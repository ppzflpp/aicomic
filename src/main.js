import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

const pinia = createPinia()
const app = createApp(App).use(pinia)

/**
 * 渲染层异常上报：把界面里未捕获的错误/未处理的 Promise 拒绝写到主进程日志
 * （软件「自己闪退 / 界面忽然不动」时，日志里至少能查到是哪一步炸的）。
 */
function reportErr(tag, text) {
  try { window.studio && window.studio.logUi(tag, text, 'error') } catch (_) { /* 日志通道不可用就算了 */ }
}
window.addEventListener('error', (e) => {
  const err = e.error
  reportErr('渲染层异常', (e.message || '未知错误') +
    ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + ':' + (e.colno || 0) +
    (err && err.stack ? '\n' + err.stack : ''))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {}
  reportErr('渲染层未处理拒绝', r.stack || r.message || String(r))
})

app.mount('#app')

// 测试钩子：UI 冒烟测试通过 window.__pinia 驱动 store、断言状态
window.__pinia = pinia
