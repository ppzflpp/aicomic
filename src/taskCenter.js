import { reactive } from 'vue'

/**
 * 前端任务中心（2026-10-22）。
 *
 * 目标：把「任务在跑」这件事从组件生命周期里解耦出来。原来批量生成跑在组件实例里，
 * 切菜单/切集会销毁组件 → await 链断裂 → 任务中断。这里改成：任务中心持有队列与状态，
 * 执行函数是「数据快照 + 独立逻辑」，不依赖任何组件实例；组件只负责「提交」和「订阅刷新」。
 *
 * 设计要点：
 *  1. 串行队列：一次只跑一个任务（视频生成吃满显存，并行会 OOM）。后续任务排队。
 *  2. 每个任务持有 data 快照（episodeId / 镜头下标等），切集不影响已提交任务。
 *  3. 事件订阅：progress / done / fail / cancel，组件据此局部刷新（不整页重载）。
 *  4. 派生只读状态 activeBusy / activeLabel，侧栏闪点直接读它。
 *
 * 执行函数约定：submit({ id, label, episodeId, run }) —— run 是一个 async 函数，
 * 接收一个 `report(progress)` 回调用于上报进度，返回结果或抛错。run 内部不得依赖组件实例。
 */

let seq = 0

const state = reactive({
  // 当前正在跑的任务（null = 空闲）
  current: null,
  // 排队中的任务
  queue: [],
  // 已完成/失败/取消的任务（只保留最近若干条，供日志/通知）
  recent: [],
  // 按类型统计「活跃任务数」（在跑 + 排队）。侧栏闪点直接读它，切菜单/切集后仍准确。
  // 例：{ 'video': 1, 'library': 0 }
  activeByType: {}
})

// 事件订阅表：{ progress: [], done: [], fail: [], cancel: [], change: [] }
const listeners = { progress: [], done: [], fail: [], cancel: [], change: [] }

function emit(type, payload) {
  for (const fn of listeners[type] || []) {
    try { fn(payload) } catch (e) { /* 订阅者异常不阻断调度 */ }
  }
  for (const fn of listeners.change || []) {
    try { fn(payload) } catch (e) { /* 同上 */ }
  }
}

/** 订阅事件；返回取消订阅函数。type 可选 progress|done|fail|cancel|change */
export function subscribe(type, fn) {
  if (!listeners[type]) listeners[type] = []
  listeners[type].push(fn)
  return () => {
    const i = listeners[type].indexOf(fn)
    if (i >= 0) listeners[type].splice(i, 1)
  }
}

/** 是否还有任务在跑/排队（侧栏闪点用） */
export function hasActive() {
  return !!state.current || state.queue.length > 0
}

/** 某类型的活跃任务数（>0 表示该类型有任务在跑/排队）。侧栏按类型闪点。 */
export function activeCount(type) {
  return Number(state.activeByType[type] || 0)
}

/** 当前活跃（在跑 + 排队）的任务数组。 */
export function activeTasks() {
  const out = []
  if (state.current) out.push(state.current)
  for (const t of state.queue) out.push(t)
  return out
}

/**
 * 属于某一集的活跃任务（在跑 + 排队）。episodeId 为空时返回空数组。
 * 用于：① 项目树在「哪一集」上显示闪点；② 组件切回该集时据此恢复「批量进行中」的显示。
 */
export function activeForEpisode(episodeId, type) {
  if (episodeId == null) return []
  return activeTasks().filter(t =>
    String(t.episodeId) === String(episodeId) && (!type || t.type === type)
  )
}

/** 当前活动任务的展示文案（侧栏闪点 title 用） */
export function activeLabel() {
  const t = state.current || state.queue[0]
  return t ? (t.label || '任务进行中') : ''
}

function bumpType(type, delta) {
  if (!type) return
  state.activeByType[type] = Math.max(0, Number(state.activeByType[type] || 0) + delta)
  if (!state.activeByType[type]) delete state.activeByType[type]
}

/** 提交一个任务。返回任务 id。run(report) 异步执行，report({done,total,label}) 上报进度。 */
export function submit({ label, episodeId, type, run }) {
  const task = reactive({
    id: 't' + (++seq),
    label: label || '任务',
    episodeId,
    type: type || '',
    status: 'queued',   // queued | running | done | failed | canceled
    done: 0, total: 0, text: '',
    error: null,
    _run: run
  })
  state.queue.push(task)
  bumpType(type, +1)
  emit('change', { type: 'queued', task })
  pump()
  return task.id
}

/** 取消任务：只对排队中的任务立即取消；正在跑的标记取消（由 run 内部检查） */
export function cancel(id) {
  const t = findByState(id)
  if (!t) return false
  if (t.status === 'queued') {
    t.status = 'canceled'
    const i = state.queue.indexOf(t)
    if (i >= 0) state.queue.splice(i, 1)
    bumpType(t.type, -1)
    emit('cancel', { type: 'cancel', task: t })
    emit('change', { type: 'cancel', task: t })
  } else if (t.status === 'running') {
    t._cancelRequested = true
    emit('change', { type: 'cancel-requested', task: t })
  }
  return true
}

function findByState(id) {
  if (state.current && state.current.id === id) return state.current
  return state.queue.find(t => t.id === id) || state.recent.find(t => t.id === id)
}

/** 队首出队并执行；串行——当前任务结束后才跑下一个 */
async function pump() {
  if (state.current) return                 // 已有任务在跑
  const task = state.queue.shift()
  if (!task) return
  state.current = task
  task.status = 'running'
  emit('change', { type: 'start', task })
  try {
    const report = (p) => {
      if (!p) return
      task.done = Number(p.done) || 0
      task.total = Number(p.total) || 0
      task.index = p.index != null ? Number(p.index) : task.index
      task.text = p.label || task.text || ''
      emit('progress', { type: 'progress', task })
    }
    const result = await task._run(report)
    task.status = 'done'
    task.result = result
    state.recent.unshift(task)
    if (state.recent.length > 20) state.recent.pop()
    emit('done', { type: 'done', task })
  } catch (e) {
    const canceled = task._cancelRequested || /已停止生成|已取消/.test(String((e && e.message) || e))
    task.status = canceled ? 'canceled' : 'failed'
    task.error = e
    state.recent.unshift(task)
    if (state.recent.length > 20) state.recent.pop()
    emit(canceled ? 'cancel' : 'fail', { type: task.status, task })
  } finally {
    state.current = null
    bumpType(task.type, -1)
    emit('change', { type: 'idle', task })
    pump()   // 串行：跑下一个
  }
}

export { state }
