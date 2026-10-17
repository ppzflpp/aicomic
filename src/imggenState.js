import { reactive } from 'vue'

/**
 * 图片生成任务的「跨页可见状态」（2026-10-17）。
 * 任务本身跑在 ImageGen 组件实例里（页面用 v-show 常驻，切换菜单不会销毁），
 * 侧栏只想知道「还在生成吗」→ 这里只放最小只读状态，业务逻辑一律留在组件里。
 * ImageGen 用 watch 把 busy / busyText 镜像进来，侧栏据此显示转圈小点。
 */
export const igState = reactive({ busy: false, text: '' })
