import { useProject } from './stores/project.js'
import { stripHeader, joinSystem, parseFallbacks, pickFallback, section, sectionRaw, fillTemplate, stripProgramSections, equipmentWords } from './promptlib.js'

export { stripHeader, parseSections, section, sectionRaw, parseFallbacks, pickFallback, ensureSceneKeeper, normalizeProfile, profileDirty, profileBrief, joinSystem, fillTemplate, stripProgramSections, equipmentWords, stripEquipmentWords, listCoverage, charAlign, charKey } from './promptlib.js'

/**
 * 项目级提示词「规范」文件（与 electron/prompts.cjs 的 FILES 对应）：
 * 每个项目 <项目>/prompts/ 下有 8 个 md，新建项目自动播种、缺失自动补、
 * 旧版自动删除重播；各模块生成前从这里读最新内容（用户改过的版本优先）。
 *
 * 🔴 这些 md 的正文就是发给大模型的提示词本体（2026-09-24 起）：
 *   每份 md 自带「## 角色与任务」（身份与任务说明）与「## 输出格式」（输出契约），
 *   代码不再硬编码任何提示词片段 —— composeSystem() 只做「按序读盘 + 去 frontmatter + 拼接」。
 *   一个任务用到多份规范时，用 `---` 分隔后整篇下发，顺序即 specs 的排列顺序。
 *   唯一的例外是解析用的字段名：契约文本在 md 里，程序按固定键名解析返回值，
 *   用户把字段名改掉会在拼装阶段被 mustHave 守卫拦下（明确报错，不会静默生成废数据）。
 */
export const PROMPT_FILES = [
  { name: 'adapt.md', label: '改编规范' },
  { name: 'shots.md', label: '分镜规范' },
  { name: 'chars.md', label: '角色规范' },
  { name: 'scenes.md', label: '场景规范' },
  { name: 'profile.md', label: '档案规范（角色 / 场景档案）' },
  { name: 'promptgen.md', label: '生图提示词规范（档案 → 提示词）' },
  { name: 'h3.md', label: 'H3 提示词规范（基础模式）' },
  { name: 'h3ref.md', label: 'H3 提示词规范（参考模式）' }
]

/** 读项目级规范文件（主进程缺了会自动补内置版）；拿不到返回空串 */
export async function readPrompt(name) {
  const st = useProject()
  if (!st.current || !st.current.projectId) return ''
  try { return (await window.studio.readPrompt(st.workspace, st.current.projectId, name)) || '' }
  catch (_) { return '' }
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
 * 读器材词表（scenes.md「## 兜底默认」里的「器材词: …」行，2026-09-27）。
 * 生图发送前剥掉命中器材词的短语用（老提示词里的「单反相机拍摄」不会随规范重播自动改）。
 * 读不到返回空数组 → 发送链不做剥除，代码零提示词文案。
 */
export async function readEquipmentWords() {
  try { return equipmentWords(await readPrompt('scenes.md')) } catch (_) { return [] }
}

/**
 * 组装 system 提示词 = 按序读取多份规范 md，去掉 frontmatter 后整篇拼接。
 * 身份与任务说明（md 的「## 角色与任务」）、风格规则、输出契约（md 的「## 输出格式」）
 * 全部随 md 一起下发；代码只负责顺序与拼接，不持有任何提示词文案。
 * @param {string[]} specs    规范文件名（按序拼接，顺序 = md 在提示词里的排列顺序）
 * @param {string[]} mustHave 契约守卫：见 joinSystem
 */
export async function composeSystem({ specs = [], mustHave = [] } = {}) {
  const bodies = []
  for (const name of specs) {
    // 去掉 frontmatter 与「程序用途小节」（兜底默认 / 素材格式），其余整篇下发
    const body = stripProgramSections(stripHeader(await readPrompt(name))).trim()
    if (body) bodies.push(body)
  }
  return joinSystem({ specs: bodies, mustHave })
}

/**
 * 渲染 user 消息：从任务专属规范 md 的「## 素材格式」小节取模板，填入本次素材。
 * 与 system 同理 —— user 侧说什么也由规范 md 决定，代码只负责取值与替换。
 * @param {string} from 规范文件名（通常是该任务的专属规范，如 shots.md / promptgen.md）
 * @param {object} vars 占位符取值（见 fillTemplate）
 */
export async function composeUser(from, vars) {
  // 必须用 sectionRaw（保留空行）：模板按空行分段，section() 会把空行吃掉，导致空段删除逻辑整体失效
  return fillTemplate(sectionRaw(await readPrompt(from), '素材格式'), vars || {})
}
