import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

const pinia = createPinia()
const app = createApp(App).use(pinia)
app.mount('#app')

// 测试钩子：UI 冒烟测试通过 window.__pinia 驱动 store、断言状态
window.__pinia = pinia
