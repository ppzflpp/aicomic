/**
 * 视频首帧 poster（2026-11-09）
 *
 * 🔴 为什么需要它：Electron 自带的 Chromium **不含 HEVC(H.265) 解码器**
 *   （实测 canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') 返回**空串**），
 *   而本项目启动时带 COMIC_STUDIO_NO_GPU=1 关掉了硬件加速 → 连硬解都没戏。
 *   用户手机拍的视频绝大多数是 HEVC → <video> **元数据读得到**（时长对）
 *   但**解不出画面**（videoWidth=0）→ 界面上就是一个纯黑框。
 *
 * 解法：ffmpeg 自带 HEVC 解码器，抽一帧成 240px jpg 当封面图。
 *   ffmpeg 抽帧实测：HEVC 720x1280 → 240x426 jpg（5.9KB），成功。
 *
 * 🔴🔴 性能铁律（2026-11-09 当晚踩过，用户反馈「点开预览卡、播放也卡」）：
 *   **抽帧是有代价的** —— 每次都要 spawn 一个 ffprobe + 一个 ffmpeg 进程去解码。
 *   最初写成「打开预览就无条件预抽」，结果连**能正常播放的 h264**（本项目生成的
 *   视频全是 h264）也要白跑一遍解码 → 和正在播放的 <video> 抢 CPU/磁盘 →
 *   明明不需要兜底的视频反而被拖卡。
 *   现在改成 **先判编码、只给解不开的抽帧**：
 *     · h264/vp9…（能解）→ 只可能付一次 ffprobe（还有会话缓存），**绝不抽帧**
 *     · hevc/h265（解不开）→ 才 spawn ffmpeg 抽那一帧
 *   预热（参考素材）依然有，只是 h264 那条路上不再有 ffmpeg。
 *
 * 🔴 判定「Chromium 能否解码」—— **双轨制**：
 *   ① **主判据 = ffprobe 读出的编码名**（主进程 `video:codec`）。
 *      编码是文件的**客观属性**，与加载时序无关 → 权威、稳定、不会误杀。
 *   ② **辅助信号 = `<video>` 的 loadedmetadata**（videoWidth/Height 都是 0）。
 *      只在「看起来解不开」时触发，且**延迟 700ms 复核**，并再用 ① 确认才定性。
 *
 * 🔴 为什么必须有 ①：只用 ② 会误杀能播的 h264 ——
 *   base64 data URL 加载慢时，判定那一刻 videoWidth 可能还是 0
 *   → 把能播的视频也降级成静帧 → 用户白白失去播放能力
 *   （实测：连跑两套 GUI 验收时必现，单跑不现 —— 典型的时序竞态）。
 *
 * 🔴 三条铁律（都是踩过的坑）：
 *   1. **渲染层只查表**（thumbs/codecs），绝不在渲染期发 IPC —— 抽帧是异步的，
 *      渲染期读会闪；曾因渲染期懒读 base64 导致每帧读 MB 级数据 → 死循环。
 *   2. **全局共享**：抽帧结果与编码判定都放在模块级 reactive 里，
 *      同一个视频在「视频生成」「分镜」「导出」「预览」多个页面都选中时**只判一次**。
 *   3. **串行抽帧**：一次只 spawn 一个，避免一次并发十几个把 CPU 打满。
 */
import { reactive } from 'vue'

/** 绝对路径 → data:image/jpeg;base64,...（抽帧结果，全局共享） */
const thumbs = reactive({})
/** 绝对路径 → 编码名（'hevc' / 'h264' / …，ffprobe 读出；'' = 探测失败） */
const codecs = reactive({})
/** 绝对路径 → true（Chromium 解不出画面，只能用抽帧图顶上） */
const noDecode = reactive({})
/** 正在处理中的路径，避免并发重复 */
const pending = new Set()

/**
 * Chromium 能不能解这个编码？
 * 只有 HEVC(H.265) 是这里的主角 —— Electron 的 Chromium 不带它的解码器。
 * ⚠️ 其它编码（h264/vp9/av1）Chromium 都能解。
 */
export function codecUndecodable(codec) {
  const c = String(codec || '').toLowerCase()
  if (!c) return false
  return c === 'hevc' || c === 'h265' || c === 'libx265'
}

/** 取已抽好的首帧（渲染层唯一入口：纯查表，不发 IPC） */
export function thumbOf(path) {
  if (!path) return ''
  return thumbs[path] || ''
}

/** 这个视频在 Chromium 里解不出画面（HEVC 等） */
export function isUndecodable(path) {
  if (!path) return false
  return !!noDecode[path]
}

/**
 * 该不该把这个视频降级成静帧？
 * 条件：已确认解不出画面 **且** 首帧图已经抽到手。
 * （刚判定失败时图还没抽完，先让 <video> 顶着，图到手后 Vue 会重渲染切过去。）
 */
export function shouldFallback(path) {
  if (!path) return false
  return !!noDecode[path] && !!thumbs[path]
}

/** 探测编码（会话内缓存；探测失败也缓存空串，避免反复 spawn ffprobe） */
async function ensureCodec(p) {
  if (codecs[p] !== undefined) return codecs[p]
  try {
    const c = await window.studio.videoCodec(p)
    codecs[p] = (c && c.ok && c.codec) ? c.codec : ''
  } catch (_) { codecs[p] = '' }
  return codecs[p]
}

/** 真的抽一帧（spawn ffmpeg） */
async function extractThumb(p) {
  if (thumbs[p]) return
  try {
    const r = await window.studio.videoThumb(p)
    if (r && r.ok && r.b64) thumbs[p] = 'data:image/jpeg;base64,' + r.b64
  } catch (_) { /* 抽帧失败就保持 <video>，不阻断 */ }
}

/**
 * 为一批视频补抽首帧 + 探测编码（已处理过的跳过）。
 *
 * 🔴 默认 **只给解不开的编码抽帧**：能播的视频抽了也用不上，白烧一次解码
 *    （见文件头「性能铁律」）。force:true 用于「连容器都解不了」的兜底 ——
 *    那时编码探测不可信，宁可抽一张图也别让用户盯着黑框。
 *
 * 串行执行：一次只跑一个 ffmpeg，别把 CPU/磁盘打满。
 */
export async function loadThumbs(paths, opt) {
  const force = !!(opt && opt.force)
  for (const p of (paths || [])) {
    if (!p || pending.has(p)) continue
    if (thumbs[p]) continue
    pending.add(p)
    try {
      const codec = await ensureCodec(p)
      if (force || codecUndecodable(codec)) await extractThumb(p)
      // 🔴 能播的编码到此为止 —— 不 spawn ffmpeg（这正是「点开/播放变卡」的根因）
    } finally { pending.delete(p) }
  }
}

/**
 * <video> 的元数据加载回调：**videoWidth/Height 都是 0** 说明容器能解析
 * （时长读得到）但画面解不开 —— 就是 HEVC 那种情况。
 *
 * 🔴 这是**辅助**判据（主判据是 ffprobe 的编码名）：只有编码探测失败/未知时才靠它。
 *    延迟 700ms 复核：`preload="metadata"` 时尺寸可能迟到，当场定性会误杀能播的。
 *    🔴 定性前**必须再用 ffprobe 确认编码**（这一步只在「看起来解不开」时才付代价，
 *    正常能播的视频连这一个 IPC 都不会发）。
 */
export function noteVideoMeta(path, el) {
  if (!path || !el) return
  if (el.videoWidth || el.videoHeight) return
  if (codecUndecodable(codecs[path])) {        // 已知是 HEVC → 不用再等
    noDecode[path] = true
    loadThumbs([path])
    return
  }
  setTimeout(async () => {
    const v = el.isConnected ? el : null
    if (!v) return
    if (v.videoWidth || v.videoHeight) return   // 尺寸补上了 → 其实能播
    const codec = await ensureCodec(path)       // 权威判据
    if (codecUndecodable(codec)) {
      noDecode[path] = true
      loadThumbs([path])
      return
    }
    if (codec) return                           // 编码已知且可解 → 绝不误杀
    // 编码探测失败（老 ffmpeg / 文件异常）且两次都量不到尺寸 → 按解不开处理，
    // 强抽一张首帧，至少让用户看见画面
    noDecode[path] = true
    loadThumbs([path], { force: true })
  }, 700)
}

/** <video> 彻底加载失败（连容器都解不了）也走同一套兜底 */
export function noteVideoError(path) {
  if (!path) return
  if (codecUndecodable(codecs[path])) {         // 已经判定过了
    noDecode[path] = true
    return
  }
  noDecode[path] = true
  loadThumbs([path], { force: true })           // 容器都挂了 → 编码不可信，直接抽
}
