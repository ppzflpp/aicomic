/**
 * 首帧接力 + 提示词重生成（脱离组件实例的纯函数/IPC 模块 · 2026-10-26）。
 *
 * 背景：原「取上一镜末帧」（takePrevLastFrame）与「生成某镜提示词」（genP）都长在
 * StageShots 组件实例上，依赖 this.shots / this.prompts / this.chars / this.scenes /
 * this.st.* 一整套响应式状态。批量视频迁到任务中心（batchVideo.js）后，执行体跑在
 * 组件生命周期之外，切菜单/切集都不会中断 —— 但这也意味着它**碰不到组件实例**。
 *
 * 本模块把「取尾帧」与「重生成提示词」两件事抽成**纯数据 + IPC** 的独立逻辑：
 *   · 输入 = 一份 episode 数据快照（shots/chars/scenes/setting/prompts/videoState +
 *            shotDir/projectId/prefix/audioMode/promptFiles/res）＋ workspace ＋ episodeId；
 *   · 每步需要「最新」数据时，直接 `getEpisode` 重读磁盘（上一镜出片后 videoState 变了，
 *     取尾帧必须拿到刚生成的那一版视频，而不是提交批量时冻结的旧快照）；
 *   · 产出写回 `saveArtifact`，与组件自己的 savePrompts / saveArtifact 完全同源同落点。
 *
 * 与组件内 genP 的对应关系：这里复刻了 effRefs / h3ModeOf / dialogueLines / settingBlock /
 * charProfilesFor / sceneProfilesFor / mainLightOf / sceneAmbientOf / videoSpecFile /
 * audioRulesBlock 的纯函数版，只依赖快照数据，不依赖 this。
 *
 * 边界（与用户确认一致）：
 *   · 第 1 镜不接首帧；
 *   · 上一镜没视频 → 不接首帧、也不重生成提示词；
 *   · 重生成提示词失败 → 该镜跳过（返回 { ok:false, skipped:true }）。
 */

import { stepLog } from './ulog.js'
import { composeSystem, composeUser } from './prompts.js'
import { settingBlock, audioRulesBlock, pickProfileField, sceneKey, anchorBrief } from './promptlib.js'
import { groupProfiles, baseOf, variantOf } from './variant.js'
import { seg, joinPath } from './resutil.js'
import { overrideOf } from './llmSource.js'

/** 素材引用结构（与 StageShots.emptyRefs 同款） */
function emptyRefs() { return { images: [], videos: [], first: null, last: null } }

/** 文件名基名（与 StageShots.baseName 同款） */
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() }

/* ---------------- 纯数据依赖（组件方法 → 快照版） ---------------- */

/** 本镜 `chars` 里的角色名集合（顿号/逗号/斜杠分隔） */
function shotCharNames(s) {
  const out = new Set()
  for (const n of String((s && s.chars) || '').split(/[、,，/]/).map(x => x.trim()).filter(Boolean)) out.add(n)
  return out
}

/** 本镜「画面里出现的主体」= chars 角色 + 场景名 */
function shotSubjects(s) {
  const out = shotCharNames(s)
  const sc = String((s && s.scene) || '').trim()
  if (sc) out.add(sc)
  return out
}

/** 参考素材绝对路径 → 所属档案（{ base, variant, name, label }）；不属于任何卡 → null */
function refOwnerInfo(abs, chars, scenes, assetsDir) {
  if (!assetsDir || !abs) return null
  const box = [[chars, 'characters', 'character sheet'], [scenes, 'scenes', 'scene sheet']]
  for (const [list, kind, label] of box) {
    for (const c of list || []) {
      const dir = joinPath(joinPath(assetsDir, kind), seg(c.name))
      if (abs.indexOf(dir) === 0) {
        return { label, name: c.name, base: baseOf(c.name), variant: variantOf(c.name) }
      }
    }
  }
  return null
}

/** 参考素材绝对路径 → 所属主体基名 */
function refOwnerBase(abs, chars, scenes, assetsDir) {
  const o = refOwnerInfo(abs, chars, scenes, assetsDir)
  return o ? o.base : ''
}

/** 参考素材绝对路径 → 提示词里 <Picture N> 的来源标注 */
function refOwner(abs, chars, scenes, assetsDir) {
  const o = refOwnerInfo(abs, chars, scenes, assetsDir)
  if (!o) return ''
  return ' (' + o.label + ': ' + (o.variant ? (o.base + ' / ' + o.variant) : o.name) + ')'
}

/** 本镜实际生效的素材（按 chars/scene 过滤过）—— 与 StageShots.effRefs 同口径 */
function effRefs(i, shots, prompts, chars, scenes, assetsDir) {
  const src = (prompts[i] && prompts[i].refs) || {}
  const raw = { images: src.images || [], videos: src.videos || [], first: src.first || null, last: src.last || null }
  const names = shotSubjects(shots[i])
  if (!names.size) return raw
  const keep = (abs) => { const o = refOwnerInfo(abs, chars, scenes, assetsDir); return !o || names.has(o.base) }
  return { images: raw.images.filter(keep), videos: raw.videos.filter(keep), first: raw.first, last: raw.last }
}

/** 本镜参考素材 → 官方任务类型（与 StageShots.h3ModeOf 同款） */
function h3ModeOf(r) {
  const refs = r || {}
  if ((refs.images || []).length || (refs.videos || []).length) return 'Ref2VA'
  if (refs.first && refs.last) return 'FL2VA'
  if (refs.first) return 'I2VA'
  if (refs.last) return 'L2VA'
  return 'T2VA'
}

/** 分镜 dialogue → 逐条「说话人 + 台词」（与 StageShots.dialogueLines 同款） */
function dialogueLines(s) {
  const raw = String((s && s.dialogue) || '').trim()
  if (!raw) return []
  const out = []
  for (const ln of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const m = ln.match(/^([^：:]{1,24})[：:]\s*([\s\S]+)$/)
    if (!m) { out.push({ name: '', note: '', text: ln }); continue }
    let name = m[1].trim(), note = ''
    const pm = name.match(/^(.*?)[（(]([^）)]*)[）)]$/)
    if (pm) { name = pm[1].trim(); note = pm[2].trim() }
    out.push({ name, note, text: m[2].trim() })
  }
  return out
}

/** 本镜命中的场景卡列表（宽松命中：先逐字，再 sceneKey 归一化） */
function sceneCardsFor(s, scenes) {
  const all = scenes || []
  const sc = String((s && s.scene) || '').trim()
  if (!sc) return null
  let pick = all.filter(c => baseOf(c.name) === sc)
  if (!pick.length) { const k = sceneKey(sc); pick = k ? all.filter(c => sceneKey(baseOf(c.name)) === k) : [] }
  return pick.length ? pick : null
}

/** 本镜场景档案块 */
function sceneProfilesFor(s, scenes) {
  return groupProfiles(sceneCardsFor(s, scenes) || (scenes || []))
}

/** 本镜角色档案块（参考模式发锚点摘要） */
function charProfilesFor(s, chars, anchor) {
  const names = shotCharNames(s)
  const list = names.size ? (chars || []).filter(c => names.has(baseOf(c.name))) : (chars || [])
  return groupProfiles(list, anchor ? anchorBrief : undefined)
}

/** 本场主光 */
function mainLightOf(s, scenes) {
  const c = (sceneCardsFor(s, scenes) || [])[0] || null
  return pickProfileField(c && c.profile, '主光')
}

/** 本场环境音 */
function sceneAmbientOf(s, scenes) {
  const c = (sceneCardsFor(s, scenes) || [])[0] || null
  return pickProfileField(c && c.profile, '环境音')
}

/* ---------------- 取尾帧 ---------------- */

/**
 * 取上一镜视频的最后一帧 → 落盘 → 返回帧图绝对路径。
 * 上一镜没视频返回 null（调用方据此「不接力 + 不重生成」）。
 * 返回 { ok:true, frame } 或 { ok:false, error, nopath? }。
 */
export async function takePrevLastFrame(ep, i) {
  const vs = ep.videoState || {}
  if (i <= 0) return { ok: false, reason: 'first' }
  const prev = vs[i - 1]
  const files = (prev && prev.files) || []
  if (!files.length) return { ok: false, reason: 'no-prev-video' }
  const k = Number.isInteger(prev.cur) && prev.cur >= 0 && prev.cur < files.length ? prev.cur : files.length - 1
  const f = files[k]
  const fname = (f && f.f) || f || null
  if (!fname) return { ok: false, reason: 'no-prev-video' }
  const abs = joinPath(ep.shotDir, fname)
  const prefix = ep.prefix || 'shot'
  const out = joinPath(ep.shotDir, prefix + '_shot_' + (i + 1) + '_first.png')
  try {
    const r = await window.studio.videoLastFrame({ video: abs, out })
    if (!r || !r.ok) {
      return { ok: false, reason: 'ffmpeg', error: (r && r.error) || '未知原因' }
    }
    const st = await window.studio.fileStat(abs)
    return {
      ok: true,
      frame: r.out,
      firstSrc: { video: abs, mtime: (st && st.mtime) || 0, size: (st && st.size) || 0 }
    }
  } catch (e) {
    return { ok: false, reason: 'error', error: String((e && e.message) || e) }
  }
}

/* ---------------- 重生成提示词 ---------------- */

/**
 * 重新生成某一镜的提示词（纯数据 + IPC）。返回 { ok:true, prompt } 或 { ok:false, error }。
 * 🔴 依赖锚点（anchorBrief）延迟 require，避免循环依赖（promptlib ← promptChain ← batchVideo）。
 */
export async function regeneratePrompt(ep, i, ctx = {}) {
  const shots = ep.shots || []
  const prompts = ep.prompts || []
  const s = shots[i]
  if (!s) return { ok: false, error: '镜头 ' + (i + 1) + ' 不存在' }
  const p = prompts[i] || (prompts[i] = { text: '', refs: emptyRefs() })
  const chars = ep.chars || []
  const scenes = ep.scenes || []
  const L = stepLog('阶段5 H3提示词')
  const prog = ctx.total ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
  try {
    const refs = p.refs || {}
    const eff = effRefs(i, shots, prompts, chars, scenes, ep.assetsDir)
    const mode = h3ModeOf(eff)
    const vf = (ep.promptFiles && ep.promptFiles.video) || {}
    const specFile = (mode === 'Ref2VA' && vf.ref) ? vf.ref : (vf.base || (mode === 'Ref2VA' ? 'h3ref.md' : 'h3.md'))
    const system = await composeSystem({
      specs: [specFile],
      mustHave: ['## 输出格式'],
      task: mode === 'Ref2VA' ? 'video-ref' : 'video-base',
      projectId: ep.projectId
    })
    // 对白锁人
    const dlg = dialogueLines(s)
    const who = (n) => {
      if (!n) return '(speaker name missing in the shot text)'
      const hit = (chars || []).find(c => c.name === n) || (scenes || []).find(c => c.name === n)
      let pic = ''
      if (hit && mode === 'Ref2VA') {
        const k = eff.images.findIndex(f => refOwnerBase(f, chars, scenes, ep.assetsDir) === n)
        if (k >= 0) pic = ' → <Picture ' + (k + 1) + '>'
      }
      return n + pic
    }
    const dlgText = dlg.length
      ? dlg.map((l, k) => (k + 1) + '. ' + who(l.name) + (l.note ? ' [' + l.note + ']' : '') + ' says: ' + l.text).join('\n')
      : ''
    const cont = String(s.continuity || '').trim()
    const chg = String(s.change || '').trim()
    const setHead = settingBlock(ep.setting, { mainLight: mainLightOf(s, scenes) })
    // 资产清单 + 首尾帧对齐句
    let refAssets = '', frames = ''
    let picN = (mode === 'Ref2VA') ? eff.images.length : 0
    const frameSrc = []
    if (eff.first) frameSrc.push('<Picture ' + (++picN) + '> = the first frame image attached to the model')
    if (eff.last) frameSrc.push('<Picture ' + (++picN) + '> = the last frame image attached to the model')
    frames = frameSrc.join('\n')
    if (mode === 'Ref2VA') {
      const inv = []
      eff.images.forEach((f, k) => inv.push('<Picture ' + (k + 1) + '> = ' + baseName(f) + refOwner(f, chars, scenes, ep.assetsDir)))
      eff.videos.forEach((f, k) => inv.push('<Video ' + (k + 1) + '> = ' + baseName(f)))
      refAssets = inv.join('\n')
    }
    const user = await composeUser(specFile, {
      characters: charProfilesFor(s, chars, mode === 'Ref2VA') || '(none)',
      scenes: sceneProfilesFor(s, scenes) || '(none)',
      n: i + 1,
      dur: s.dur,
      shot: JSON.stringify(s, null, 2),
      mode,
      dialogue: dlgText,
      continuity: setHead + ((cont || chg) ? (cont || '(none)') : ''),
      audioRules: audioRulesBlock(ep.audioMode || 'full', ep.setting, sceneAmbientOf(s, scenes), { syncEvents: mode === 'Ref2VA' }),
      change: chg,
      refAssets,
      frames
    })
    const text = await window.studio.llmChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], { temperature: 0.6, maxTokens: 2048, stage: 'prompt', providerOverride: overrideOf('prompt'), label: '阶段5 H3提示词' })
    const t = String(text || '').trim()
    if (!t) return { ok: false, error: '模型返回空提示词' }
    p.text = t
    p._rev = (p._rev || 1) + 1
    // 🔴 接力重生成后清签名（2026-10-27）：与 batchVideo.persistVideo 对视频签名的处理对称。
    //    接力改了本镜首帧（refs.first 0→1）+ 提示词，旧 _sig 已对不上新状态，硬留会制造
    //    「提示词过期」的假琥珀（promptStale 里 sigStale 拿旧签名比新 curPromptSig，必判过期）。
    //    清成 null → promptStale 见 !_sig 直接返回 false，不再显示脏标记；下次手动 genP
    //    会重新写签名，脏标记机制恢复。
    p._sig = null
    L.done('第' + (i + 1) + '个镜头的提示词重生成完成：' + t.length + ' 字' + prog)
    return { ok: true, prompt: t }
  } catch (e) {
    if (e && (e.code === 'CANCELLED' || /已停止生成|已取消|SKIP_CANCELLED/.test(String(e.message || e)))) {
      return { ok: false, cancelled: true, error: '已停止生成' }
    }
    L.fail('第' + (i + 1) + '个镜头的提示词重生成失败' + prog, null, e)
    return { ok: false, error: String((e && e.message) || e) }
  }
}
