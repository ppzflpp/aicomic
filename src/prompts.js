import { useProject } from './stores/project.js'
import { stripHeader, joinSystem, parseFallbacks, pickFallback, section, sectionRaw, fillTemplate, stripProgramSections, equipmentWords, applyStyle, styleKeys, normalizeQuotes, normalizeQuotesDeep } from './promptlib.js'

export { stripHeader, parseSections, section, sectionRaw, parseFallbacks, pickFallback, ensureSceneKeeper, normalizeProfile, profileDirty, profileBrief, joinSystem, fillTemplate, stripProgramSections, equipmentWords, stripEquipmentWords, applyStyle, styleKeys, normalizeQuotes, normalizeQuotesDeep, listCoverage, charAlign, charKey } from './promptlib.js'

/**
 * 项目级提示词「规范」文件（与 electron/prompts.cjs 的 FILES 对应）：
 * 每个项目 <项目>/prompts/ 下有 10 个 md，新建项目自动播种、缺失自动补、
 * 旧版自动删除重播；各模块生成前从这里读最新内容（用户改过的版本优先）。
 *
 * 🔴 这些 md 的正文就是发给大模型的提示词本体（2026-09-24 起）：
 *   每份 md 自带「## 角色与任务」（身份与任务说明）与「## 输出格式」（输出契约），
 *   代码不再硬编码任何提示词片段 —— composeSystem() 只做「按序读盘 + 去 frontmatter + 拼接」。
 *   一个任务用到多份规范时，用 `---` 分隔后整篇下发，顺序即 specs 的排列顺序。
 *   唯一的例外是解析用的字段名：契约文本在 md 里，程序按固定键名解析返回值，
 *   用户把字段名改掉会在拼装阶段被 mustHave 守卫拦下（明确报错，不会静默生成废数据）。
 *
 * 🔴 2026-10-07：原先这里还有一份 PROMPT_FILES（文件名 → 展示名）表，供左侧树里
 *   已删掉的「📝 提示词规范」按文件罗列。老入口删除后它没有任何消费者，
 *   文件的展示名统一由下面的 TASKS（用途）声明 —— 少一份表就少一处会漂移的副本。
 */

/* ------------------------------------------------------------------ *
 * 用途（task）—— 界面上的「一个用途 = 一篇成品提示词」（2026-10-07 提示词配置中心）
 *   用户不需要知道「分镜」是由 shots + profile + chars + scenes 四份拼出来的，
 *   他只需要知道「分镜用这篇提示词、我可以改这篇」。这里是那层映射的唯一定义。
 *   specs 的顺序 = 拼进 system 的顺序（也就是 md 在提示词里的排列顺序）。
 *   dyn：文件随「当前模型方案」变的那些 —— 视频方案声明 prompt.files，
 *        H3 = {base:h3.md, ref:h3ref.md}、LTX-2.5 = {base:ltx.md}。
 * ------------------------------------------------------------------ */
export const TASKS = [
  { id: 'adapt', label: '漫剧改编', desc: '章节原文 → 剧本稿', kind: '', specs: ['adapt.md'], mustHave: ['## 输出格式'] },
  { id: 'shots', label: '分镜脚本', desc: '剧本稿 → 分镜 + 角色 / 场景档案', kind: 'image', specs: ['shots.md', 'profile.md', 'chars.md', 'scenes.md'], mustHave: ['"shots"', '"characters"', '"scenes"'] },
  { id: 'char', label: '角色提示词', desc: '角色档案 → 生图提示词', kind: 'image', specs: ['promptgen.md', 'profile.md', 'chars.md'], mustHave: ['"prompt"', '"negative"'] },
  { id: 'scene', label: '场景提示词', desc: '场景档案 → 生图提示词', kind: 'image', specs: ['promptgen.md', 'profile.md', 'scenes.md'], mustHave: ['"prompt"', '"negative"'] },
  { id: 'video-base', label: '视频提示词 · 基础', desc: '分镜 → 视频提示词（文字 / 首尾帧）', kind: 'video', specs: ['h3.md'], mustHave: ['## 输出格式'], dyn: 'video.base' },
  { id: 'video-ref', label: '视频提示词 · 参考', desc: '分镜 → 视频提示词（参考图 / 参考视频）', kind: 'video', specs: ['h3ref.md'], mustHave: ['## 输出格式'], dyn: 'video.ref' },
  { id: 'split', label: '拆镜重写', desc: '拆分后的镜头 → 画面补写', kind: '', specs: ['split.md'], mustHave: ['"shots"'] }
]

export function taskById(id) { return TASKS.find(t => t.id === id) || null }

/** 某用途实际用到的规范文件（视频侧随当前视频方案换文件） */
export function taskSpecs(taskId, promptFiles) {
  const t = taskById(taskId)
  if (!t) return []
  const vf = (promptFiles || {}).video || {}
  if (t.dyn === 'video.base') return [vf.base || 'h3.md']
  if (t.dyn === 'video.ref') return [vf.ref || 'h3ref.md']
  return t.specs.slice()
}

/* ------------------------------------------------------------------ *
 * 体裁分流规范（2026-10-08）
 *
 *   原先「一个用途用哪份规范」是写死的：改编环节永远是 adapt.md。可 adapt.md 是
 *   **小说改编**规范（素材定性为小说章节、R7/R8 命名规则、禁用镜头语言、五部分分场结构），
 *   同一份规范发给广告素材，模型只能拒答或产出一份伪剧本 —— 体裁的分叉点在最上游，
 *   到分镜才纠正已经晚了。
 *
 *   所以把「读哪份文件」交给**当前项目的风格包**声明（electron/styles/axes/genre/*.json
 *   的 prompt.files）。映射的键是**逻辑规范名**（代码里认的 adapt.md / shots.md …），
 *   值是**这个项目实际要读的文件清单**：
 *     · 写一份 → 整份替换（规则互斥时用，如广告改编 vs 小说改编）
 *     · 写两份 → 基座 + 体裁增量（契约共用时用，如分镜的 JSON 输出格式）
 *
 *   🔴 换的只是「读哪个文件」，不换身份：模型专属规范（profile.prompt.append）与风格说明
 *      仍按逻辑名挂载，所以换体裁不会让 zimage 那类模型事实掉链子。
 *   🔴 现读风格包（按 `项目id|风格id` 缓存），不走全局状态 —— A 项目广告、B 项目小说
 *      互不串味，切项目立刻生效。
 * ------------------------------------------------------------------ */

/** 本项目声明的「逻辑规范名 → 读取清单」（没有声明 / 取不到 → 空表 = 一切照旧） */
async function specAlias(pid) {
  try { return ((await currentStylePack(pid)) || {}).files || {} } catch (_) { return {} }
}

/** 按当前体裁把逻辑规范名解析成实际要读的文件清单（去重，保持顺序） */
async function resolveSpecs(specs, pid) {
  const alias = await specAlias(pid)
  const out = []
  for (const n of (specs || [])) {
    const real = (Array.isArray(alias[n]) && alias[n].length) ? alias[n] : [n]
    for (const r of real) if (out.indexOf(r) < 0) out.push(r)
  }
  return out
}

/** 某用途在本项目**实际要读**的规范文件（含体裁变体）——界面用它显示「这篇由哪些文件拼成」 */
export async function taskRealSpecs(taskId, projectId) {
  const pid = resolveProjectId(projectId)
  return resolveSpecs(taskSpecs(taskId, useProject().promptFiles), pid)
}

/**
 * 当前项目 id。显式传入优先 —— 提示词页不属于任何一集（没有 st.current），
 * 它从左侧树带自己的 projectId 进来，所以不能只认 st.current。
 */
function resolveProjectId(explicit) {
  if (explicit) return explicit
  const st = useProject()
  return (st.current && st.current.projectId) || (st.promptTarget && st.promptTarget.projectId) || null
}

/** 从覆写文件（可选）的 frontmatter 里取 `for:`（这份覆写是为哪个模型方案写的） */
function finalFor(raw) {
  const m = String(raw || '').match(/^\s*---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return ''
  const f = m[1].match(/(?:^|\n)\s*for:\s*(.+?)\s*(?:\n|$)/)
  return f ? f[1].trim() : ''
}

/**
 * 读某用途的成品覆写。不存在返回 null。
 * 覆写已剥掉 frontmatter（那是给程序看的元信息，不该发给模型）。
 */
export async function taskOverride(taskId, projectId) {
  const pid = resolveProjectId(projectId)
  if (!pid) return null
  const st = useProject()
  let raw = null
  try { raw = await window.studio.promptFinalRead(st.workspace, pid, taskId) } catch (_) { return null }
  if (raw == null) return null
  return { raw, text: stripHeader(raw).trim(), forId: finalFor(raw) }
}

/** 某项目已有哪些用途的成品覆写：{ [taskId]: { size, mtimeMs, forId } } */
export async function finalList(projectId) {
  const pid = resolveProjectId(projectId)
  if (!pid) return {}
  try { return (await window.studio.promptFinalList(useProject().workspace, pid)) || {} }
  catch (_) { return {} }
}

/** 存一份成品覆写（forId 会写进 frontmatter 的 `for:`，界面据此防跨模型串味） */
export async function saveTaskOverride(taskId, content, forId, projectId) {
  const pid = resolveProjectId(projectId)
  if (!pid) throw new Error('没有打开任何项目')
  const body = stripHeader(String(content == null ? '' : content)).trim()
  const head = forId ? '---\nfor: ' + forId + '\n---\n\n' : ''
  return window.studio.promptFinalSave(useProject().workspace, pid, taskId, head + body)
}

/** 删掉成品覆写（= 恢复默认合成） */
export async function clearTaskOverride(taskId, projectId) {
  const pid = resolveProjectId(projectId)
  if (!pid) return false
  return window.studio.promptFinalClear(useProject().workspace, pid, taskId)
}

/**
 * 生成某用途的成品提示词（界面预览 + 一键另存都用它）。只读，不改任何东西。
 * 返回 { task, specs, text, overridden, forId, missing, error }
 *   overridden=true  → 当前下发的就是用户的覆写（text 即覆写全文，此时它不再随风格/模型变）
 *   missing          → 该用途的输出契约里缺的项（预览里直接黄标，不用等生成时报错）
 */
export async function previewTask(taskId, projectId) {
  const t = taskById(taskId)
  if (!t) return { task: null, specs: [], text: '', overridden: false, forId: '', missing: [], error: '未知用途：' + taskId }
  const pid = resolveProjectId(projectId)
  // 显示**实际要读**的文件（含体裁变体），而不是逻辑名 —— 用户才知道自己改的是哪一篇
  const specs = await taskRealSpecs(taskId, pid)
  const ov = await taskOverride(taskId, pid)
  const miss = (text) => (t.mustHave || []).filter(k => k && String(text || '').indexOf(k) < 0)
  if (ov && ov.text) {
    return { task: t, specs, text: ov.text, overridden: true, forId: ov.forId, missing: miss(ov.text), error: '' }
  }
  try {
    const text = await composeSystem({ specs: taskSpecs(taskId, useProject().promptFiles), mustHave: [], kind: t.kind, projectId: pid })
    return { task: t, specs, text, overridden: false, forId: '', missing: miss(text), error: '' }
  } catch (e) {
    return { task: t, specs, text: '', overridden: false, forId: '', missing: [], error: (e && e.message) || String(e) }
  }
}

/* ------------------------------------------------------------------ *
 * 风格包（2026-10-07）：项目级「题材 / 画风」配置
 *   规范 md 正文里的 `{{S.x}}` 占位符由这里取到的变量表在**内存里**替换 ——
 *   项目 prompts/ 下的磁盘副本始终不含替换结果，所以 prompts.cjs 的 rev 播种、
 *   用户手改的规范都不受影响（风格换了不会把规范文件写脏）。
 * ------------------------------------------------------------------ */

/** 当前风格包缓存。🔴 键必须是「风格 id」而不是布尔 —— 风格是**项目级**的，
 *  切项目 / 切风格都必须能分辨出来（跟 promptExtras 的「模型方案」缓存是两码事）。 */
/**
 * 🔴 2026-10-07 改造：缓存键从「风格 id」升级为「项目 + 风格 id」。
 *    风格覆盖已下沉到项目 —— 同一个 id 在两个项目里可以有不同的词表，
 *    只按 id 缓存必然串味（改了 A 项目的现代都市词表，B 项目跟着变）。
 *    key = `<项目 id>|<风格 id>`。
 */
const _styleCache = new Map()

/** 🔴 解析不了的风格只报一次（否则每读一份规范就刷一条日志）。
 *  这是老实现最坑人的地方：项目存的风格取不到时 get() 会悄悄给古风包，
 *  结果"项目设的是现代风格、实际出的是古风片"而用户毫不知情。 */
let _styleWarned = new Set()

/** 读某个风格包（主进程；读不到返回 null）。projectId 决定用哪个项目的词表覆盖。 */
async function stylePack(id, projectId) {
  const key = String(id || '')
  const pid = String(projectId || '')
  const ck = pid + '|' + key
  if (_styleCache.has(ck)) return _styleCache.get(ck)
  const st = useProject()
  let pack = null
  try { pack = (await window.studio.styleGet(key, st.workspace, pid)) || null } catch (_) { pack = null }
  const res = pack && pack.resolved
  if (res && res.ok === false && !_styleWarned.has(ck)) {
    _styleWarned.add(ck)
    try {
      window.studio.logUi('风格', '项目设置的风格「' + (res.wanted || key) + '」无法解析：' + res.reason +
        ' —— 提示词已按兜底风格（' + (pack.name || '') + '）生成，请在项目配置里重新选择', 'error')
    } catch (_) { /* 日志通道不可用就算了 */ }
  }
  _styleCache.set(ck, pack)
  return pack
}

/**
 * 某项目当前用的风格 id。
 * 当前集自带的 style 就是它所属项目的风格（主进程读剧集时顺手带上）；
 * 提示词页**不属于任何一集**（st.current 为空）→ 退回它从左侧树带进来的那个项目。
 */
function styleIdOf(projectId) {
  const st = useProject()
  const pid = projectId || (st.current && st.current.projectId) || ''
  if (st.current && st.current.style && (!pid || st.current.projectId === pid)) return st.current.style
  const p = pid ? (st.tree || []).find(x => x.id === pid) : null
  return (p && p.res && p.res.style) || ''
}

/** 某项目的风格包（不传 projectId = 当前集所属项目） */
export async function currentStylePack(projectId) {
  const pid = resolveProjectId(projectId)
  return stylePack(styleIdOf(pid), pid)
}

/** 某项目的风格变量表（替换 `{{S.x}}` 用）；取不到返回 {} */
export async function currentStyleVars(projectId) {
  const p = await currentStylePack(projectId)
  return (p && p.vars) || {}
}

/** 清风格包缓存（切项目 / 改风格 / 改风格文件后调用）—— 按项目缓存，所以整体清 */
export function clearStylePack() {
  _styleCache.clear()
  _styleWarned = new Set()
}

/** 风格包清单（新建项目 / 项目配置的下拉用） */
export async function styleList() {
  try { return (await window.studio.styleList()) || [] } catch (_) { return [] }
}

/** 读项目级规范文件（主进程缺了会自动补内置版）；拿不到返回空串。
 *  🔴 这里统一做风格替换 —— 它是所有规范读取的唯一收口点，所以
 *     composeSystem / composeUser / 兜底模板 / 空镜句 / 器材词 / 负向词表
 *     全部自动跟随当前风格，不需要每个调用点各改一遍。 */
export async function readPrompt(name, projectId) {
  const st = useProject()
  const pid = resolveProjectId(projectId)
  if (!pid) return ''
  try {
    const raw = (await window.studio.readPrompt(st.workspace, pid, name)) || ''
    return applyStyle(raw, await currentStyleVars(pid))
  } catch (_) { return '' }
}

/**
 * 读项目规范里的兜底负向词表（chars.md / scenes.md 的「## 兜底默认」小节里那行「负向: …」）。
 * 生图环节在「大模型没给 negative」时用它兜底；读不到返回空串（不补任何代码内置文案）。
 */
export async function readDefaultNegative() {
  for (const name of ['chars.md', 'scenes.md']) {
    const v = pickFallback(parseFallbacks(await readPrompt(name)), ['负向', 'negative'])
    if (v) return v
  }
  return ''
}

/**
 * 读器材词表（生图发送前剥掉命中器材词的短语用）。
 * 🔴 2026-10-08 改造：**优先取风格包里的 equipStrip**（画风族声明「本画风必须剥掉哪些器材词」），
 *    原因是「哪些词必须剥」本身就是画风事实 —— 真人实拍要剥，将来加二次元 / 3D 画风族时
 *    该剥的词不一样。老路径（scenes.md「## 兜底默认」的「器材词: …」行）保留为兜底：
 *    老项目副本里那一行还在，改版后也能读到词表，不至于忽然不剥了。
 * 🔴 「手机」已从词表移除：它在现代都市题材里是**合法道具**，旧实现按子串匹配会
 *    把「手里握着手机」这类短语整条删掉（画面直接少一件东西）。
 * 读不到返回空数组 → 发送链不做剥除，代码零提示词文案。
 */
export async function readEquipmentWords(projectId) {
  const pid = resolveProjectId(projectId)
  try {
    const pack = await currentStylePack(pid)
    const list = String((pack && pack.vars && pack.vars.equipStrip) || '')
      .split(/[,，]/).map(x => x.trim()).filter(Boolean)
    if (list.length) return list
  } catch (_) { /* 取不到风格包就走下面的兜底 */ }
  try { return equipmentWords(await readPrompt('scenes.md', pid)) } catch (_) { return [] }
}

/**
 * 读「空镜必备句」（scenes.md「## 空镜必备句」小节的第一行正文，2026-09-30）。
 * 场景卡出图前用它补齐「画面里没有人」的陈述 —— 库里的场景图与集内场景图走同一条生图链，
 * 少了这句就会出「场景图里站着人」，故抽成共用读取。读不到返回空串（不补）。
 */
export async function readSceneKeeper() {
  try {
    const body = section(await readPrompt('scenes.md'), '空镜')
    if (!body) return ''
    for (const raw of String(body).split(/\r?\n/)) {
      const ln = raw.trim()
      if (!ln || /^[（(]/.test(ln) || /^[-*#>]/.test(ln)) continue
      return ln
    }
  } catch (_) { /* 读不到就留空 */ }
  return ''
}

/**
 * 组装 system 提示词 = 按序读取多份规范 md，去掉 frontmatter 后整篇拼接。
 * 身份与任务说明（md 的「## 角色与任务」）、风格规则、输出契约（md 的「## 输出格式」）
 * 全部随 md 一起下发；代码只负责顺序与拼接，不持有任何提示词文案。
 *
 * 另外会追加「当前模型方案」为同名规范声明的专属规范（profile.prompt.append）——
 * 例如生图方案 zimage-turbo 会给 chars.md / scenes.md / promptgen.md 各追加一份
 * model-zimage.md（写清 cfg=1 负向无效、禁器材词这类本模型的事实）。
 * 于是「换一个生图模型」连提示词部分也变成只改配置：换方案 = 换模型事实，通用规范不动。
 *
 * 最后再追加「当前风格包」的说明（electron/styles/<id>/style.md）—— 与模型专属规范同理，
 * 那一份写的是「这部片子是什么题材 / 什么画风」，换风格只改那一份。追加一次（不逐份重复）。
 *
 * 🔴 体裁分流（2026-10-08）：specs 里的名字是**逻辑规范名**，进入循环前会按当前项目的
 *    风格包声明的 `files` 换成这个项目实际要读的文件（见上面的「体裁分流规范」注释）。
 *    换的只是读哪个文件，模型专属规范与风格说明仍按逻辑名挂载。
 *
 * @param {string[]} specs    规范文件名（按序拼接，顺序 = md 在提示词里的排列顺序）
 * @param {string[]} mustHave 契约守卫：见 joinSystem
 * @param {string}   kind     模型用途（'image' / 'video'）；不传则按 specs 自动推断
 */
export async function composeSystem({ specs = [], mustHave = [], kind = '', task = '', projectId = '' } = {}) {
  const pid = resolveProjectId(projectId)

  // 🔴 成品覆写：该用途被用户整段改过 → 直接下发覆写全文，不再合成、也不做风格替换。
  //    这是有意的「脱钩」（用户要的就是能整段接管这一篇）；代价由界面显式标出 + 一键恢复。
  //    但 mustHave 契约守卫仍然生效 —— 自己写成品最容易漏掉输出契约，
  //    漏了程序就解析不到字段，静默生成一堆废数据。
  if (task) {
    const ov = await taskOverride(task, pid)
    if (ov && ov.text) {
      const t = taskById(task)
      const missing = (mustHave || []).filter(k => k && ov.text.indexOf(k) < 0)
      if (missing.length) {
        throw new Error('「' + ((t && t.label) || task) + '」的成品覆写缺少关键内容（' + missing.join(' / ') +
          '）：这些是程序解析返回值要用的字段名，请补回去，或在提示词页点「恢复默认」回到自动合成')
      }
      return ov.text
    }
  }

  const k = kind || inferKind(specs)
  const extras = k ? ((await promptExtras(pid))[k] || {}) : {}
  const svars = await currentStyleVars(pid)
  const pack = await currentStylePack(pid)
  // 当前体裁声明的「逻辑规范名 → 实际读取清单」（没声明就是空表 = 一切照旧）
  const alias = (pack && pack.files) || {}
  const bodies = []
  for (const name of specs) {
    // 🔴 换的只是「读哪个文件」，不换身份：下面的模型专属规范与风格说明仍按**逻辑名**挂载，
    //    所以换体裁不会让 zimage 那类模型事实掉链子。
    const real = (Array.isArray(alias[name]) && alias[name].length) ? alias[name] : [name]
    let got = 0
    for (const rn of real) {
      // 去掉 frontmatter 与「程序用途小节」（兜底默认 / 素材格式），其余整篇下发。
      // readPrompt 已经做过风格替换 —— 这里拿到的正文对当前风格就是「成品」。
      const body = stripProgramSections(stripHeader(await readPrompt(rn, pid))).trim()
      if (body) { bodies.push(body); got++ }
    }
    // 映射指向的文件一份都读不到 → 当场报错。静默跳过等于「用户明明选了广告体裁，
    // 改编环节却收到一篇空规范」，那比报错难查得多。
    if (!got && alias[name]) {
      throw new Error('「' + name + '」在本项目体裁下要读 ' + real.join(' / ') +
        '，但它们都读不到内容 —— 请到「提示词配置中心 → 通用规范」确认这些文件是否存在')
    }
    // 紧跟在同名通用规范之后，追加该模型方案声明的专属规范
    for (const text of (extras[name] || [])) {
      // 模型专属规范也要过一遍风格替换（model-zimage.md 里同样有题材相关的举例）
      const ex = applyStyle(stripProgramSections(stripHeader(text)).trim(), svars)
      if (ex) bodies.push(ex)
    }
  }
  // 风格包自己的说明：追加在正文之后，一次性下发（不逐份重复，省 token）
  if (pack && pack.text && (pack.append || []).some(n => specs.includes(n))) {
    const t = applyStyle(stripProgramSections(stripHeader(pack.text)).trim(), svars)
    if (t) bodies.push(t)
  }
  const text = joinSystem({ specs: bodies, mustHave })
  // 🔴 兜底闸门：规范正文本该被替换干净，若还留着 {{S.x}}（风格包缺键 / 键名拼错），
  //    宁可当场报错，也不要带着占位符发给大模型 —— 静默出废片比报错难查得多。
  const left = styleKeys(text)
  if (left.length) {
    throw new Error('提示词规范里还有没被替换的风格占位符：' +
      left.map(x => '{{S.' + x + '}}').join(' / ') +
      ' —— 请检查当前风格包' + (pack ? '（' + pack.id + '）' : '') + ' 的 vars 是否缺这些键')
  }
  return text
}

/**
 * 从 specs 推断模型用途（生图 / 视频）——调用点没显式传 kind 时的兜底，
 * 避免每个调用点都要重复声明。视频类提示词规范（h3 / h3ref / ltx）归视频方案，
 * 档案 / 分镜 / 生图提示词类归生图方案。
 */
function inferKind(specs) {
  for (const n of specs) if (/^(h3|h3ref|ltx)\.md$/i.test(n)) return 'video'
  for (const n of specs) if (/^(chars|scenes|promptgen)\.md$/i.test(n)) return 'image'
  return ''
}

/**
 * 当前各用途模型方案自带的专属规范正文：{ image: { 规范名: [正文…] }, video: {…} }。
 * 缓存键是**项目 id**：方案本身是全局的，但「模型专属规范」的覆盖已下沉到项目
 * （<项目>/prompts/model/）—— 同一个方案在两个项目里可以配不同写法，
 * 只按方案缓存必然串味。改模型方案或改规范文件后调 clearPromptExtras() 让下次重新取。
 */
const _extrasCache = new Map()
export async function promptExtras(projectId) {
  const st = useProject()
  const pid = String(resolveProjectId(projectId) || '')
  if (_extrasCache.has(pid)) return _extrasCache.get(pid)
  let v = {}
  try { v = (await window.studio.profilePromptExtras(st.workspace, pid)) || {} } catch (_) { v = {} }
  _extrasCache.set(pid, v)
  return v
}

/** 清缓存（切模型方案 / 改模型专属规范后调用）—— 按项目缓存，所以整体清 */
export function clearPromptExtras() { _extrasCache.clear() }

/**
 * 渲染 user 消息：从任务专属规范 md 的「## 素材格式」小节取模板，填入本次素材。
 * 与 system 同理 —— user 侧说什么也由规范 md 决定，代码只负责取值与替换。
 * @param {string} from 规范文件名（通常是该任务的专属规范，如 shots.md / promptgen.md）
 * @param {object} vars 占位符取值（见 fillTemplate）
 */
export async function composeUser(from, vars) {
  const pid = resolveProjectId()
  // 素材模板也按当前体裁解析（广告体裁的改编规范是 adapt-ad.md，它的「素材格式」才是本片的素材位）。
  // 基座 + 增量时**近处覆盖远处**：清单里最后一份带「## 素材格式」的说了算。
  const real = await resolveSpecs([from], pid)
  let body = ''
  for (const rn of real) {
    // 必须用 sectionRaw（保留空行）：模板按空行分段，section() 会把空行吃掉，导致空段删除逻辑整体失效
    const sec = sectionRaw(await readPrompt(rn, pid), '素材格式')
    if (String(sec || '').trim()) body = sec
  }
  // 🔴 素材字符规范化（2026-10-08）：**这里是素材进入模型的唯一收口点**（全部 6 个 llmChat 调用点
  //    都经过 composeUser），所以在这一层做最省事也最彻底 —— 剧本原文 / 改编稿 / 已有档案摘要 /
  //    镜头 JSON 都要过一遍。事实：改编稿里一个半角双引号会让模型的 JSON 输出提前闭合，
  //    输出仍是合法 JSON 但结构被击穿（档案截断 + 裸字符串碎片）。
  //    用 normalizeQuotesDeep 而非 normalizeQuotes：镜头 JSON 那几处（split / 视频提示词）
  //    里的引号是**结构引号**，整篇替换会把素材变成一份引号全变形的 JSON。详见 promptlib。
  const safe = {}
  for (const k of Object.keys(vars || {})) {
    const v = vars[k]
    safe[k] = typeof v === 'string' ? normalizeQuotesDeep(v) : v
  }
  return fillTemplate(body, safe)
}
