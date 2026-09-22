import { useProject } from './stores/project.js'
import { stripHeader, joinSystem } from './promptlib.js'

export { stripHeader, parseSections, section, parseFallbacks, pickFallback, ensureSceneKeeper, normalizeProfile, profileDirty, profileBrief, joinSystem } from './promptlib.js'

/**
 * 项目级提示词「规范」文件（与 electron/prompts.cjs 的 FILES 对应）：
 * 每个项目 <项目>/prompts/ 下有 5 个 md，新建项目自动播种、缺失自动补、
 * 旧版自动删除重播；各模块生成前从这里读最新内容（用户改过的版本优先）。
 *
 * ⚠️ 这些 md 是「风格规范」，不是直接发给大模型的完整提示词。
 * 真正的 system 提示词由 composeSystem() 组装：
 *   身份说明（代码固定）+ 风格规范（读 md）+ 输出格式契约（代码固定）
 * 这样用户改规范能调风格，但改不坏 JSON 格式等技术契约。
 */
export const PROMPT_FILES = [
  { name: 'adapt.md', label: '改编规范' },
  { name: 'shots.md', label: '分镜规范' },
  { name: 'chars.md', label: '角色规范' },
  { name: 'scenes.md', label: '场景规范' },
  { name: 'profile.md', label: '档案规范（角色 / 场景档案）' },
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
 * 组装真正的 system 提示词。
 * @param {string}   identity 代码固定的身份与任务说明
 * @param {string[]} specs    风格规范文件名（按序拼进提示词）
 * @param {string}   contract 代码固定的输出格式契约（技术约束，不随 md 变化）
 * @param {string}   fallback 规范文件全部读不到时的兜底提示词
 */
export async function composeSystem({ identity, specs = [], contract = '', fallback = '' }) {
  const bodies = []
  for (const name of specs) {
    const body = stripHeader(await readPrompt(name)).trim()
    if (body) bodies.push(body)
  }
  return joinSystem({ identity, specs: bodies, contract, fallback })
}
