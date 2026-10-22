import { reactive } from 'vue'

/**
 * 视频生成任务的「跨页可见状态」（2026-10-22）。
 * 任务跑在任务中心（taskCenter.js），组件用 v-show 常驻、切菜单不销毁。
 * 侧栏只想知道「还有视频任务在跑吗」→ 这里放最小只读状态，
 * 由 VideoGen 在订阅任务中心事件时镜像进来，侧栏据此显示闪点。
 */
export const vgState = reactive({ busy: false, text: '' })
