// 阶段操作日志助手：每件大事「开始 → 完成/失败（带耗时）」各推一条到日志总线。
// 用法：
//   const L = stepLog('阶段4 角色出图')
//   L.start('正在生成角色图：沈砚（第 1/3 个）')
//   L.done('角色「沈砚」生成完成', Date.now() - t0)      // → 自动追加（12.1s）
//   L.fail('角色「沈砚」生成失败', Date.now() - t0, err)  // → （已等待 9.8s）：<原因>
//
// 另外提供 dbgPrompt()：把「实际输入给大模型的提示词」打到日志里，便于核对。
// 文字 / 图片 / 视频三类模型都走它；超长自动截断，开关见日志面板「打印提示词」。

function fmt(ms) {
  if (ms == null) return ''
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'
}

function errMsg(e) {
  return (e && e.message) ? String(e.message) : String(e || '未知错误')
}

export function stepLog(tag) {
  const send = (msg, level) => {
    try { window.studio.logUi(tag, msg, level) } catch (_) { /* 日志绝不影响主流程 */ }
  }
  return {
    start: (msg) => send(msg, 'info'),
    done: (msg, ms) => send(ms != null ? msg + '（' + fmt(ms) + '）' : msg, 'ok'),
    fail: (msg, ms, e) => send(msg + (ms != null ? '（已等待 ' + fmt(ms) + '）' : '') + '：' + errMsg(e), 'error'),
    info: (msg) => send(msg, 'info'),
    warn: (msg) => send(msg, 'warn')
  }
}

export function secs(ms) { return fmt(ms) }

/* ---------------- 调试：打印输入给大模型的提示词 ----------------
 * 🔴 2026-09-22 按产品要求整段停用：提示词全文把日志面板刷得完全看不清。
 * dbgPrompt 保留为空操作（调用点不动，方便以后要恢复时只需改这一处）；
 * clip/DBG_MAX 导出保留，供其它调试用途。 */

/** 单段内容最多打印多少字（超出保留头尾，中间省略） */
export const DBG_MAX = 400

/** 超长内容截断：保留头尾各一半，中间标注总长度 */
export function clip(s, max = DBG_MAX) {
  const t = String(s == null ? '' : s)
  if (t.length <= max) return t
  const half = Math.floor(max / 2)
  return t.slice(0, half) + '\n……（共 ' + t.length + ' 字，中间省略）……\n' + t.slice(-half)
}

/**
 * 打印一次模型调用的输入提示词。
 * 🔴 已停用（no-op）：不再向日志面板输出任何提示词内容。
 * @param {string} tag   阶段标签（与 stepLog 一致，便于日志面板按阶段筛选）
 * @param {string} title 这次调用是什么（例：'阶段3 分镜脚本 · 文字模型'）
 * @param {Array<[string,string]>} sections [字段名, 内容] 列表，按序打印
 */
export function dbgPrompt(tag, title, sections) {
  void tag; void title; void sections   // 已停用：保留签名，调用点零改动
}
