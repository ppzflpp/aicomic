/**
 * 本地图片 → 可直接放进 <img src> 的 URL（2026-10-17）
 *
 * 为什么需要：渲染层不能直接读磁盘，以前一律走 IPC `file:readBase64`，
 * 由主进程同步读整文件再回传 base64 字符串。大图（1~3MB）下这条链每次都
 * 要把「同步读 + base64 膨胀 33% + 跨进程拷贝 + 主线程拼 data URL + 整图解码」
 * 全走一遍 —— 点开预览明显一顿，缩略图还把这些字符串常年堆在 JS 堆里。
 *
 * 改走主进程注册的 `studio-media://` 协议后：渲染层只给一个 URL，
 * Chromium 自己流式读、自己缓存、自己异步解码，主进程不阻塞、堆里不留大字符串。
 *   studio-media://media/?p=<encodeURIComponent(绝对路径)>
 * 路径放在 query（不放 pathname）是为了绕开 Windows 盘符/中文/空格的转义坑。
 */
const SCHEME_RE = /^(studio-media|https?|data|blob|file):/i

export function mediaUrl(abs) {
  if (!abs) return ''
  const s = String(abs)
  if (SCHEME_RE.test(s)) return s          // 已经是 URL（或 data:）就原样返回
  return 'studio-media://media/?p=' + encodeURIComponent(s)
}
