/** 分辨率/时长小工具（StageChars / StageVideos / StageShots 共用） */

/** '宽x高' → [w, h]；非法回退默认 */
export function parseRes(v, dw = 1216, dh = 832) {
  const m = /^(\d+)x(\d+)$/i.exec(String(v || ''))
  return m ? [+m[1], +m[2]] : [dw, dh]
}

/** '864x480' → '864×480（16:9）'（比例约分，不整除时保留原比值） */
export function ratioLabel(v, dw, dh) {
  const [w, h] = parseRes(v, dw, dh)
  const g = (a, b) => { while (b) { [a, b] = [b, a % b] } return a || 1 }
  const d = g(w, h)
  return w + '×' + h + '（' + (w / d) + ':' + (h / d) + '）'
}

/** 档位列表里保证当前已保存的值存在（否则 select 显示不出来） */
export function optsWith(list, cur) {
  const out = (list || []).slice()
  if (cur && !out.some(o => o.value === cur)) out.unshift({ value: cur, label: ratioLabel(cur) })
  return out
}

/**
 * 只读态（锁定后）显示用：优先取档位表里的官方 label，命不中才退回约分比例。
 * 否则同一个分辨率在下拉里是「1344×768（16:9）」、锁定后却被 gcd 约分成「7:4」，
 * 看起来像比例被改了（其实是 1344×768 的精确比值本来就等于 7:4）。
 */
export function resLabel(list, v, dw, dh) {
  const hit = (list || []).find(o => o && o.value === v)
  return (hit && hit.label) ? hit.label : ratioLabel(v, dw, dh)
}

/** 镜头时长夹取：4~15 秒（含边界），非数字回退 8 */
export function clampDur(v) {
  const n = Math.round(Number(v) || 8)
  return Math.min(15, Math.max(4, n))
}

/** 路径段清洗：与主进程 assetStore.sanitize 保持一致（角色名会出现在目录名里） */
export function seg(name) {
  return String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed'
}

/** 用手头的系统分隔符拼路径（渲染层只需 Windows 形态的绝对路径） */
export function joinPath(...parts) {
  return parts.filter(p => p != null && p !== '').join('\\').replace(/\\+/g, '\\')
}
