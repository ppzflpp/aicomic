/**
 * 大模型来源的「本次运行覆盖」—— 纯内存，不落库。
 *
 * 设计（2026-10-15 用户拍板）：**设置页是唯一持久入口**；阶段页上的切换只影响本次打开，
 * 刷新/重启就回到设置页的默认值。这样不会出现「设置页能改、页面也能改，而且两边都记得」
 * 互相打架的局面。
 *
 * 覆盖粒度 = 环节（stage）。一个页面涉及多个环节时（分镜页 = shots/prompt/split），
 * 页面上那一个开关会把它们一起切 —— 对用户来说就是「这一页这次走云端」。
 */
const ov = {}   // { [stage]: 'local' | 'cloud' }

export function overrideOf(stage) { return ov[stage] || '' }

export function setOverride(stages, kind) {
  const list = Array.isArray(stages) ? stages : [stages]
  list.forEach(s => {
    if (kind === 'local' || kind === 'cloud') ov[s] = kind
    else delete ov[s]
  })
}

export function clearOverrides() { Object.keys(ov).forEach(k => { delete ov[k] }) }

/** 一组环节当前的统一覆盖值：'' = 全都没被覆盖；'mixed' = 不一致 */
export function overrideTag(stages) {
  const list = Array.isArray(stages) ? stages : [stages]
  const vals = list.map(s => ov[s] || '')
  return vals.every(v => v === vals[0]) ? vals[0] : 'mixed'
}
