import { stepLog, secs } from './ulog.js'
import { takePrevLastFrame, regeneratePrompt } from './promptChain.js'
import { joinPath } from './resutil.js'

/**
 * 批量视频生成（独立于组件的执行体 · 2026-10-22）。
 *
 * 这是「任务中心」落地的第一环：把原来跑在 StageShots 组件实例里的批量视频循环抽出来，
 * 变成「数据快照 + 独立循环」。循环不依赖任何组件实例，切菜单 / 切集都不会中断；
 * 每镜完成后直接把结果写回快照指定的集（episodeId），不碰「当前集」——避免串集。
 *
 * 快照由 StageShots 在提交时用它的现有方法算好（effRefs/resOf/durOf/curVideoSig 等），
 * 这里零重复逻辑，只做三件事：串行调 ComfyUI、把结果落回 videos.json、上报进度。
 *
 * 🔴 首帧接力（2026-10-26）：snapshot.autoChainFirst === true 时，每镜生成前（第 1 镜除外）
 *    取上一镜最新视频的末帧 → 写进本镜首帧 → 重生成本镜提示词 → 再生成视频。
 *    「取尾帧 + 重生成提示词」已抽成脱离组件的纯函数/IPC（promptChain.js），
 *    因此这里依旧不依赖组件实例，切菜单/切集不中断的能力保持不变。
 *    边界：上一镜没视频 → 不接首帧、也不重生成（仍按原提示词生成）；重生成失败 → 该镜跳过。
 *
 * 快照结构：
 * {
 *   workspace, episodeId, projectId, shotDir,
 *   autoChainFirst,               // 是否开启「自动填充首帧」逐镜接力
 *   shots: [{ index, prompt, promptStale, refImages, refVideos, firstFrame, lastFrame,
 *             width, height, seconds, baseName, refsUsed, sig }]
 * }
 */

const MAX_FILES = 4   // 与 StageShots 一致：每镜最多保留 4 版

/** 读某集的 videoState（纯数据，不依赖组件）。返回 {} 兜底。 */
async function readVideoState(workspace, episodeId) {
  try {
    const ep = await window.studio.getEpisode(workspace, episodeId)
    const s = (ep && ep.videoState) || {}
    return (s && Object.keys(s).length) ? JSON.parse(JSON.stringify(s)) : {}
  } catch (_) { return {} }
}

/** 读某集的完整数据（首帧接力时用最新版，而非提交批量时冻结的旧快照）。返回 null 兜底。 */
async function readEpisode(workspace, episodeId) {
  try {
    const ep = await window.studio.getEpisode(workspace, episodeId)
    return ep || null
  } catch (_) { return null }
}

/** 把某一镜的生成结果落回 videos.json（指定集，不依赖当前集）。返回写回后的完整 videoState。 */
async function persistVideo(snapshot, shot, files, ms) {
  const vs = await readVideoState(snapshot.workspace, snapshot.episodeId)
  const key = String(shot.index)
  const cur = vs[key] || { files: [], cur: -1, confirmed: false }
  cur.files = [...(cur.files || []), ...files]
  // 每版耗时
  const fm = cur.fileMs || (cur.fileMs = {})
  files.forEach(f => { fm[f] = ms })
  while (cur.files.length > MAX_FILES) {
    const gone = cur.files.shift()
    if (gone && fm[gone]) delete fm[gone]
  }
  cur.cur = cur.files.length - 1
  cur.confirmed = true
  cur.genMs = ms
  cur.refsUsed = shot.refsUsed
  // 🔴 首帧接力（2026-10-26）：接力改了本镜提示词 + 首帧后，快照里的旧 sig 已对不上新状态，
  //   硬写会制造「视频已过期」的假琥珀。接力过的镜头清掉签名（= 不判过期，与「重新生成即已处理」同义），
  //   由 StageShots 完成回调里的 refreshFrameStale / 下次重生成再补。
  cur._sig = shot.chainChanged ? null : shot.sig
  cur._ack = null
  delete cur._gen; delete cur._genAt
  vs[key] = cur
  await window.studio.saveArtifact(snapshot.workspace, snapshot.episodeId, 'videoState', vs)
  return vs
}

/**
 * 执行批量视频生成。report({done,total,label}) 上报进度；返回 { ok, bad } 统计。
 * shouldStop() 由任务中心注入：返回 true 表示用户已请求整批停止（cancel 对 running 任务置位），
 * 每镜开始前检查它 —— 否则整批停止只靠 comfyGenerate 抛 CancelledError 收尾，
 * 一旦取消信号落在「镜头间隙」（上一镜 finally 已清 inference 层标记、下一镜还没提交），
 * 后续镜头就不再感知取消，批量会继续往下跑（2026-10-24 实测场景 2）。
 * 单镜失败不中断整批（继续下一镜），与旧 runBatchV 行为一致。
 */
export async function run(snapshot, report, shouldStop) {
  const L = stepLog('阶段6 H3视频')
  const shots = snapshot.shots || []
  const total = shots.length
  let ok = 0, bad = 0, skipped = 0, stopped = false
  const tAll = Date.now()
  // 累积最新的完整 videoState（persistVideo 每次会读盘+写盘，这里追踪最后写回的那份），
  // 供提交方在完成回调里直接回填 store 缓存，避免再走一次 IPC 重读。
  let latestVs = null
  // 首帧接力（2026-10-26）：逐镜推进时缓存「刚生成的上一镜 videoState」，取尾帧读它，
  // 不再每次 getEpisode 全量重读（上一镜刚出片、写盘已由 persistVideo 完成，这里就是最新）。
  let chainEp = null

  L.start('开始批量生成视频：待生成 ' + total + ' 个镜头' +
    (snapshot.autoChainFirst ? '（自动填充首帧 · 逐镜接力）' : '') +
    '（任务中心 · 独立执行，切菜单/切集不中断）')

  for (let k = 0; k < shots.length; k++) {
    // 🔴 整批停止（任务中心 cancel 置位）：每镜开始前检查，立刻结束整批，不等下一镜提交
    if (shouldStop && shouldStop()) { stopped = true; break }
    const shot = shots[k]
    const i = shot.index
    const prog = '（第 ' + (k + 1) + '/' + total + ' 个）'
    // 🔴 首帧接力是否已重生成过本镜提示词（避免「提示词脏」分支再重复 genP）
    let chainRegenerated = false

    // ---- 首帧接力：取上一镜末帧 → 填本镜首帧 → 重生成本镜提示词 ----
    if (snapshot.autoChainFirst && i > 0) {
      // 🔴 上一镜是否出片：直接看「上一镜」在 shots 快照里是否还有后续 —— 更稳的是读盘。
      //    上一镜刚出片，persistVideo 已把结果写进 videos.json；这里重读拿最新 videoState。
      chainEp = chainEp || (await readEpisode(snapshot.workspace, snapshot.episodeId))
      if (chainEp) {
        // getEpisode 不返回 promptFiles / audioMode（它们是 store 级 / 项目行数据），
        // 接力重生成提示词要用到 —— 从快照补进这份 episode 数据。
        chainEp.promptFiles = snapshot.promptFiles || {}
        chainEp.audioMode = snapshot.audioMode || 'full'
      }
      if (shouldStop && shouldStop()) { stopped = true; break }
      const prevVs = (chainEp && chainEp.videoState) || {}
      const prevFiles = (prevVs[i - 1] && prevVs[i - 1].files) || []
      if (prevFiles.length) {
        // 🔴 2026-10-27：重生成提示词**不是无条件**的 —— 只有「本镜首帧来源真的变了」才重写。
        //    且**首帧没变时不重新抽帧**：抽帧会重写首帧 png 的 mtime → 文件指纹变 → order 签名变
        //    → 「生成提示词」按钮假脏（与单镜 genV 同一口径）。
        const oldRefs = (chainEp && chainEp.prompts && chainEp.prompts[i] && chainEp.prompts[i].refs) || null
        const oldFirst = oldRefs && oldRefs.firstSrc
        // 上一镜视频的当前版本绝对路径 + 元数据（用于判断首帧来源是否变了）
        const pv = prevVs[i - 1]
        const pk = Number.isInteger(pv.cur) && pv.cur >= 0 && pv.cur < prevFiles.length ? pv.cur : prevFiles.length - 1
        const pvFname = (prevFiles[pk] && prevFiles[pk].f) || prevFiles[pk] || null
        const prevAbs = pvFname ? joinPath(chainEp.shotDir, pvFname) : null
        let srcChanged = !oldFirst || !prevAbs
        if (!srcChanged && prevAbs) {
          let st = null
          try { st = await window.studio.fileStat(prevAbs) } catch (_) { st = null }
          if (!st || !st.exists) srcChanged = true
          else srcChanged = oldFirst.video !== prevAbs || oldFirst.mtime !== (st.mtime || 0) || oldFirst.size !== (st.size || 0)
        }
        if (!srcChanged) {
          // 首帧没变 → 不重新抽帧、不重生成提示词，直接用现有首帧 + 提示词
          L.done('镜头 ' + (i + 1) + ' 首帧未变（复用现有首帧与提示词，不重生成）' + prog)
        } else {
          L.info('镜头 ' + (i + 1) + ' 首帧来源已变 → 取上一镜末帧 + 重生成提示词' + prog)
          const fr = await takePrevLastFrame(chainEp, i)
          if (fr.ok) {
            // 🔴 先把本镜首帧 + firstSrc 写进**内存里的** prompts（regeneratePrompt 读的是这份），
            //    再重生成提示词；成功后一次性落盘。
            const memPrompts = (chainEp.prompts || []).slice()
            const p = memPrompts[i] || (memPrompts[i] = { text: '', refs: emptyRefs() })
            p.refs = p.refs || emptyRefs()
            p.refs.first = fr.frame
            p.refs.firstFrom = 'prev-shot'
            p.refs.firstSrc = fr.firstSrc
            chainEp.prompts = memPrompts
            // 重生成提示词（拿到「接上首帧」后的新提示词）
            const rg = await regeneratePrompt(chainEp, i, { n: k + 1, total })
            if (shouldStop && shouldStop()) { stopped = true; break }
            if (rg.cancelled) { stopped = true; break }
            if (!rg.ok) {
              // 🔴 提示词重生成失败 → 该镜跳过（不生成视频），继续下一镜
              L.warn('镜头 ' + (i + 1) + ' 首帧接力：提示词重生成失败，跳过该镜（' + (rg.error || '未知原因') + '）' + prog)
              skipped++
              continue
            }
            shot.prompt = rg.prompt
            shot.chainChanged = true
            chainRegenerated = true
            // 写回重生成后的提示词（带 _rev + 首帧 firstSrc）
            const persist = (chainEp.prompts || []).slice()
            await window.studio.saveArtifact(snapshot.workspace, snapshot.episodeId, 'prompts', persist)
            L.done('镜头 ' + (i + 1) + ' 首帧已接上一镜末帧，提示词已重生成' + prog)
            shot.firstFrame = fr.frame
            if (shot.refsUsed) shot.refsUsed.first = fr.frame
            // 🔴 2026-10-26：把「接上的尾帧 + 重生成的提示词」随 progress 透出去，
            //   订阅方（StageShots）据此就地更新 UI（首帧缩略图 + 提示词文本），逐镜实时可见。
            report({
              done: k + 1, total, index: i,
              label: '批量视频 ' + (k + 1) + '/' + total,
              chain: { index: i, firstFrame: fr.frame, firstSrc: fr.firstSrc, prompt: shot.prompt }
            })
          } else if (fr.reason === 'no-prev-video') {
            // 上一镜没视频 → 不接首帧、也不重生成（按原提示词生成）
            L.warn('镜头 ' + (i + 1) + ' 上一镜没有视频，跳过首帧接力（按原提示词生成）' + prog)
          } else {
            // 取帧失败（ffmpeg 缺失等）→ 该镜跳过
            L.warn('镜头 ' + (i + 1) + ' 取上一镜末帧失败，跳过该镜（' + (fr.error || fr.reason || '未知原因') + '）' + prog)
            skipped++
            continue
          }
        }
      } else {
        L.warn('镜头 ' + (i + 1) + ' 上一镜没有视频，跳过首帧接力（按原提示词生成）' + prog)
      }
    }

    // ---- 提示词脏 → 重生成（与「自动填充首帧」开关无关 · 2026-10-27）----
    // 快照在提交时（runBatchV 里 refreshAsig 之后）已把 promptStale 算好带下来；
    // 开关关、或第 1 镜、或上一镜没视频，只要提示词脏了都要重生成，不再拿旧提示词直接出片。
    if (shot.promptStale && !chainRegenerated) {
      chainEp = chainEp || (await readEpisode(snapshot.workspace, snapshot.episodeId))
      if (chainEp) {
        chainEp.promptFiles = snapshot.promptFiles || {}
        chainEp.audioMode = snapshot.audioMode || 'full'
      }
      if (shouldStop && shouldStop()) { stopped = true; break }
      if (!chainEp) {
        // 读集失败 → 拿不到分镜/档案数据，无法重生成；按现有提示词继续（别因这个卡死整批）
        L.warn('镜头 ' + (i + 1) + ' 提示词脏但读集失败，跳过重生成（按现有提示词生成）' + prog)
      } else {
        L.info('镜头 ' + (i + 1) + ' 提示词已脏（分镜/素材/声音档位变了）→ 重生成提示词（不抽首帧）' + prog)
        const rg = await regeneratePrompt(chainEp, i, { n: k + 1, total })
        if (shouldStop && shouldStop()) { stopped = true; break }
        if (rg.cancelled) { stopped = true; break }
        if (!rg.ok) {
          L.warn('镜头 ' + (i + 1) + ' 提示词脏，重生成失败，跳过该镜（' + (rg.error || '未知原因') + '）' + prog)
          skipped++
          continue
        }
        shot.prompt = rg.prompt
        shot.chainChanged = true
        // 写回重生成后的提示词（带 _rev；regeneratePrompt 已清 _sig）
        const persist = (chainEp.prompts || []).slice()
        await window.studio.saveArtifact(snapshot.workspace, snapshot.episodeId, 'prompts', persist)
        L.done('镜头 ' + (i + 1) + ' 提示词已重生成（提示词脏了）' + prog)
        // 只透出 prompt（不带 firstFrame），订阅方据此只更新提示词文本、不动首帧
        report({
          done: k + 1, total, index: i,
          label: '批量视频 ' + (k + 1) + '/' + total,
          chain: { index: i, prompt: shot.prompt }
        })
      }
    }

    const inputs = []
    if (shot.firstFrame) inputs.push('首帧')
    if (shot.lastFrame) inputs.push('尾帧')
    if (shot.refImages.length) inputs.push('参考图×' + shot.refImages.length)
    if (shot.refVideos.length) inputs.push('参考视频×' + shot.refVideos.length)
    const t0 = Date.now()
    report({ done: k + 1, total, index: shot.index, label: '批量视频 ' + (k + 1) + '/' + total })
    L.start('正在生成视频：镜头 ' + (shot.index + 1) + prog + '（' + shot.seconds + 's · ' + shot.width + 'x' + shot.height + ' · 本地推理）')
    try {
      const params = {
        prompt: shot.prompt, firstFrame: shot.firstFrame, lastFrame: shot.lastFrame,
        refImages: shot.refImages, refVideos: shot.refVideos,
        width: shot.width, height: shot.height,
        seconds: shot.seconds,
        projectId: snapshot.projectId
      }
      const r = await window.studio.comfyGenerate({
        templateKey: 'video', dir: snapshot.shotDir, baseName: shot.baseName,
        params, label: '阶段6 H3视频'
      })
      const ms = Date.now() - t0
      latestVs = await persistVideo(snapshot, shot, r.files, ms)
      // 首帧接力：本镜刚出片 → 缓存最新 videoState，供下一镜取尾帧用
      if (snapshot.autoChainFirst) chainEp = null
      ok++
      L.done('镜头 ' + (shot.index + 1) + ' 视频生成完成：' + r.files.join('、'), ms)
    } catch (e) {
      const msg = String((e && e.message) || e)
      // 🔴 2026-10-22：区分「单镜跳过」与「整批停止」——
      //   skip（SKIP_CANCELLED）：只停当前这一镜，continue 到下一镜继续批量；
      //   full（用户已停止生成 / 已取消）：结束整批（与旧 runBatchV 的 canceled 语义一致）。
      if (/SKIP_CANCELLED/.test(msg)) {
        L.warn('镜头 ' + (shot.index + 1) + ' 已跳过（用户点了这一镜的停止），继续下一镜' + prog)
        continue
      }
      if (/已停止生成|已取消/.test(msg)) {
        L.warn('镜头 ' + (shot.index + 1) + ' 视频生成已停止' + prog)
        // 停止：不再继续后续镜头（与旧 runBatchV 的 canceled 语义一致）
        break
      }
      bad++
      L.fail('镜头 ' + (shot.index + 1) + ' 视频生成失败' + prog, Date.now() - t0, e)
    }
  }

  const sum = (stopped ? '批量生成视频已停止' : '批量生成视频结束') + '：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : '') +
    (skipped ? '，跳过 ' + skipped + ' 个' : '') +
    (ok + bad + skipped < total ? '，剩余 ' + (total - ok - bad - skipped) + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
  if (bad && !ok) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
  else if (bad || stopped) L.warn(sum)
  else L.done(sum, null)

  return { ok, bad, skipped, total, stopped, videoState: latestVs }
}

function emptyRefs() { return { images: [], videos: [], first: null, last: null } }
