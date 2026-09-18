// 阶段操作日志助手：每件大事「开始 → 完成/失败（带耗时）」各推一条到日志总线。
// 用法：
//   const L = stepLog('阶段4 角色出图')
//   L.start('正在生成角色图：沈砚（第 1/3 个）')
//   L.done('角色「沈砚」生成完成', Date.now() - t0)      // → 自动追加（12.1s）
//   L.fail('角色「沈砚」生成失败', Date.now() - t0, err)  // → （已等待 9.8s）：<原因>

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
