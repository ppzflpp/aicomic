/**
 * 现场（会话快照）：软件退出时保存，下次启动恢复到上次的页面。
 *
 * 保存内容（主进程侧还有一份「窗口位置/大小」，见 electron/session.cjs）：
 *   view      当前页面（工作区 / 设置）
 *   episodeId 上次打开的集数
 *   expanded  侧栏项目树的展开状态
 *   scroll    工作区与侧栏的滚动位置
 *   logs      底部日志面板（展开、高度、档位）
 *
 * 策略：界面一变就**防抖落库**（600ms），不赌退出瞬间的钩子——
 * 强杀进程也不会把现场丢光；退出时再补一次 send 兜底。
 */
import { watch } from 'vue'
import { useProject } from './stores/project.js'
import { useLogs } from './stores/logs.js'

const DEBOUNCE = 600
/** 日志面板高度夹取范围（与 LogPanel 的拖动限制保持一致） */
const H_MIN = 120
const H_MAX = 900

let timer = null
let installed = false

/** 收集当前现场快照（纯数据，可直接过 IPC） */
export function snapshot() {
  const st = useProject()
  const logs = useLogs()
  const content = document.querySelector('.content')
  const side = document.querySelector('.side-scroll')
  return {
    view: st.view,
    episodeId: st.current ? st.current.id : null,
    expanded: [...st.expanded],
    scroll: {
      content: content ? Math.round(content.scrollTop) : 0,
      side: side ? Math.round(side.scrollTop) : 0
    },
    logs: {
      open: logs.open,
      height: Math.round(logs.height),
      level: logs.level,
      autoScroll: logs.autoScroll
    }
  }
}

function flush() {
  try { window.studio.saveSession(snapshot()) } catch (_) { /* 存不下不影响使用 */ }
}

/** 界面变了：防抖后落库 */
export function saveSoon() {
  clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE)
}

/** 立即保存（退出路径用 send，不等回包） */
export function saveNow() {
  clearTimeout(timer)
  try { window.studio.saveSessionNow(snapshot()) } catch (_) { /* 退出路径不阻塞 */ }
}

export async function readSession() {
  try {
    const s = await window.studio.getSession()
    return (s && typeof s === 'object') ? s : {}
  } catch (_) { return {} }
}

/**
 * 恢复上次的页面。
 * 必须在 store.boot()（拿到项目树）之后、installSessionAutoSave() 之前调用，
 * 否则默认状态（首页 / 无集数）会反过来把现场覆盖掉。
 */
export async function restoreSession() {
  const st = useProject()
  const logs = useLogs()
  const ses = await readSession()
  if (!ses || !ses.savedAt) return false

  // 1) 侧栏项目树：把上次展开的项目/文件夹重新展开
  if (Array.isArray(ses.expanded)) st.expanded = new Set(ses.expanded.map(String))

  // 2) 底部日志面板（tag / 搜索词不还原：上次的阶段标签在新会话里多半已不存在）
  const lg = ses.logs || {}
  if (typeof lg.open === 'boolean') logs.open = lg.open
  if (Number.isFinite(lg.height)) logs.height = Math.min(Math.max(H_MIN, lg.height), H_MAX)
  if (['key', 'all', 'warn', 'error'].includes(lg.level)) logs.level = lg.level
  if (typeof lg.autoScroll === 'boolean') logs.autoScroll = lg.autoScroll
  if (logs.open) logs.unreadErr = 0

  // 3) 上次打开的集数（已被删除则忽略，回到「请选择或新建集数」）
  const id = Number(ses.episodeId) || 0
  if (id && st.findEpisode(id)) await st.openEpisode(id)

  // 4) 上次停留的页面
  st.view = ses.view === 'settings' ? 'settings' : 'dash'

  // 5) 滚动位置：DOM 出来先设一次，异步内容（图片/视频卡片）撑高后再校正一次
  const sc = ses.scroll || {}
  const view = st.view
  const apply = () => applyScroll(sc, view)
  setTimeout(apply, 0)
  setTimeout(apply, 500)
  return true
}

/** 把滚动位置还原到元素上；未恢复到目标位置时返回 false（内容还没撑开） */
function applyScroll(sc, view) {
  const set = (sel, v) => {
    const el = document.querySelector(sel)
    if (!el || !Number.isFinite(v)) return true
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = Math.min(Math.max(0, v), max)
    return Math.abs(el.scrollTop - Math.min(Math.max(0, v), max)) < 4
  }
  // 设置页与工作区内容完全不同，跨页还原滚动位置没有意义
  const okContent = view === 'settings' ? true : set('.content', sc.content)
  set('.side-scroll', sc.side)

  // 工作区没能回到原位（内容仍在异步加载）→ 退而求其次，把「进行中」的阶段滚进视野
  if (!okContent && Number(sc.content) > 80) {
    const run = document.querySelector('.stage.running')
    if (run && run.scrollIntoView) run.scrollIntoView({ block: 'center' })
    return false
  }
  return okContent
}

/** 装上自动保存：页面/集数/展开状态/日志面板变化 + 滚动 + 退出兜底 */
export function installSessionAutoSave() {
  if (installed) return
  installed = true
  const st = useProject()
  const logs = useLogs()

  watch(() => [
    st.view,
    st.current ? st.current.id : null,
    [...st.expanded].sort().join(','),
    logs.open, logs.height, logs.level, logs.autoScroll
  ], saveSoon)

  // 滚动位置不是响应式的：scroll 不冒泡，用捕获阶段统一收
  window.addEventListener('scroll', (e) => {
    const t = e.target
    if (t && t.classList && (t.classList.contains('content') || t.classList.contains('side-scroll'))) saveSoon()
  }, { capture: true, passive: true })

  // 退出兜底：关窗瞬间不等回包，主进程同步落库
  window.addEventListener('beforeunload', saveNow)
}
