import { stepLog, secs } from './ulog.js'

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
 * 快照结构：
 * {
 *   workspace, episodeId, projectId, shotDir,
 *   shots: [{ index, prompt, refImages, refVideos, firstFrame, lastFrame,
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
  cur._sig = shot.sig
  cur._ack = null
  delete cur._gen; delete cur._genAt
  vs[key] = cur
  await window.studio.saveArtifact(snapshot.workspace, snapshot.episodeId, 'videoState', vs)
  return vs
}

/**
 * 执行批量视频生成。report({done,total,label}) 上报进度；返回 { ok, bad } 统计。
 * 单镜失败不中断整批（继续下一镜），与旧 runBatchV 行为一致。
 */
export async function run(snapshot, report) {
  const L = stepLog('阶段6 H3视频')
  const shots = snapshot.shots || []
  const total = shots.length
  let ok = 0, bad = 0
  const tAll = Date.now()
  // 累积最新的完整 videoState（persistVideo 每次会读盘+写盘，这里追踪最后写回的那份），
  // 供提交方在完成回调里直接回填 store 缓存，避免再走一次 IPC 重读。
  let latestVs = null

  L.start('开始批量生成视频：待生成 ' + total + ' 个镜头（任务中心 · 独立执行，切菜单/切集不中断）')

  for (let k = 0; k < shots.length; k++) {
    const shot = shots[k]
    const prog = '（第 ' + (k + 1) + '/' + total + ' 个）'
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

  const sum = '批量生成视频结束：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : '') +
    (ok + bad < total ? '，剩余 ' + (total - ok - bad) + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
  if (bad && !ok) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
  else if (bad) L.warn(sum)
  else L.done(sum, null)

  return { ok, bad, total, videoState: latestVs }
}
