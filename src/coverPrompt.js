/**
 * 封面直出：提示词组装 + 目录 / 画幅 / 风格口径（2026-11-04）
 *
 * 为什么封面单独一份而不是复用分镜提示词：分镜提示词写的是**叙事**（这一镜发生什么），
 * 封面要的是**海报**（主体居中、留出标题区、眼神看镜头、景别更紧）。沿用分镜那套规则
 * 只会出一张「分镜感的图」，不像封面。
 *
 * 与 skills/prompts/cover.md 的分工：本文件管「字怎么画进图里」（模板，硬编码，防错字约束
 * 不能改坏）；cover.md 管「写哪几个字」（下发给大模型）。两者互不影响。
 *
 * 🔴 文案必须**先锁定**再出图：字一旦画进像素就抠不出来（实测 SSIM：同 prompt 重跑 1.000、
 *    只改 2 字 0.867、换字体风格 0.346）。所以本文件只负责「给定文案 → 一条提示词」，
 *    不做任何文案生成，也不允许调用方边生成边改字。
 */
import { joinPath, seg } from './resutil.js'

/** 字体风格三档。desc 进「用…写着」，tail 是一句独立的字形约束（都经过实测）。 */
export const COVER_STYLES = [
  {
    id: 'song', label: '宋体', short: '宋',
    desc: '白色加粗宋体',
    tail: '字体是标准印刷宋体，横细竖粗、有三角衬线，像正式出版的影视海报标题，不是手写。'
  },
  {
    id: 'calli', label: '书法', short: '书',
    desc: '白色毛笔书法',
    tail: '行书笔意，笔画有起收顿挫与飞白，墨色浓郁，字迹完整可辨。'
  },
  {
    id: 'hand', label: '手写', short: '手',
    desc: '白色硬笔手写',
    tail: '笔迹随性自然，有真实书写感，不是印刷体。'
  }
]

/**
 * 画幅两档。w/h 直接给 EmptyQwenImage21LatentImage（__EW__/__EH__），
 * 所以「换比例 = 重新出一次图」，不是裁切 —— 裁切会把人切掉（改动宽高比等于换一张构图）。
 * pos 是标题落位：横版压在下方三分之一（画面重心在上），竖版下方四分之一（留更多人物）。
 */
export const COVER_RATIOS = [
  { id: '16:9', label: '横版 16:9', short: '16:9', w: 1344, h: 768, portrait: false, pos: '画面下方三分之一处' },
  { id: '9:16', label: '竖版 9:16', short: '9:16', w: 768, h: 1344, portrait: true, pos: '画面下方四分之一处' }
]

/**
 * 负向词（编辑通道有 negative 输入，H3 视频没有 —— 所以这套只在封面用）。
 * 前四组是**防错字**：错别字 / 缺笔画 / 粘连 / 乱码。实测 40 个汉字零错依赖它。
 */
export const COVER_NEG = '错别字，缺笔画，笔画粘连，乱码，多余的英文字母，数字，水印，logo，签名，边框，页码，'
  + '多处文字，文字重叠，文字漂浮，人脸变形，换人，人物重影，肢体畸形，手部畸形，'
  + '低画质，模糊，噪点，现代元素，动漫，二次元，插画，3D'

/** 汉字计数（按码点，别用 .length —— 生僻字是代理对） */
export function countCn(s) {
  return Array.from(String(s || '').replace(/\s/g, '')).length
}

const CN_NUM = ['一', '二', '三', '四', '五']

/**
 * 组装一条封面直出提示词。
 * @param {{title:string, subtitle?:string, styleId?:string, refs?:Array<{role:'scene'|'char',name:string}>, ratioId?:string}} o
 * @returns {string}
 */
export function buildCoverPrompt(o) {
  const opt = o || {}
  const ratio = COVER_RATIOS.find(r => r.id === opt.ratioId) || COVER_RATIOS[0]
  const style = COVER_STYLES.find(s => s.id === opt.styleId) || COVER_STYLES[0]
  const title = String(opt.title || '').trim()
  const subtitle = String(opt.subtitle || '').trim()
  const refs = Array.isArray(opt.refs) ? opt.refs.filter(r => r && r.role) : []
  const nT = countCn(title)
  const nS = countCn(subtitle)
  const hasScene = refs.some(r => r.role === 'scene')
  const hasChar = refs.some(r => r.role === 'char')
  const shape = ratio.portrait ? '竖版' : '横版'

  // ① 底图 / 主体：这里只说「谁在哪」，一个字都不描述长相（长相由参考图提供）
  let head
  if (!refs.length) {
    head = `画一张${shape}的古装剧海报：画面是一处有电影质感的古装场景，主体居中，四周留出呼吸空间。`
  } else if (hasScene && hasChar) {
    // 顺序有含义：TextEncodeQwenImage21 按 images.image_1..N 的顺序读，先环境后人物更稳
    const tag = refs.map((r, i) => '第' + (CN_NUM[i] || (i + 1)) + '张是' + (r.role === 'scene' ? '场景' : '人物')).join('，')
    head = `把这${refs.length > 1 ? '几' : ''}张参考图合成一张${shape}古装剧海报：${tag}，`
      + '请把人物放到场景中作为主视觉，保持脸型、五官、发型与服装配色不变、不要换脸。'
  } else if (hasChar) {
    head = `把这张参考图做成一张${shape}古装剧人物海报：把参考图中这个人物的半身像重新构图为${shape}居中站位，`
      + '人物保留参考图中的脸型、五官、发型与服装配色，不要换脸。'
  } else {
    head = `把这张参考图做成一张${shape}古装剧海报，保持参考图中的场景结构、光线与色调不变。`
  }

  // ② 文字：副标题固定用宋体（实测「书法主 + 宋体副」这一组字号比例最准，且小字宋体最抗糊）
  let text
  if (nS > 0) {
    text = `${ratio.pos}排布两行汉字：第一行是较大的${style.desc}${nT}个字「${title}」，写在正中；`
      + `第二行紧接其下、字号约为第一行一半的白色宋体${nS}个字「${subtitle}」。`
      + '两行都居中排布、字距均匀，带极细微的黑色描边保证在任何背景上都清晰可读。'
  } else {
    text = `${ratio.pos}，用${style.desc}横向写着一行${nT}个汉字「${title}」，`
      + '字迹清晰锐利、笔画完整，边缘干净，带极细微的黑色描边让白字在浅色背景上也清晰可读，字距均匀、居中排布。'
  }
  text += style.tail

  // ③ 防错字 / 防多余文字：这三句是实测零错字的必要条件，删掉表现会掉
  const forbid = `除${nS > 0 ? '这两行字' : '这几个字'}以外，画面中不再出现任何其他文字、字母、数字、印章、logo 或水印。`
    + '每一个汉字都必须准确无误、字形完整、笔画正确、可以逐字辨认。'

  // ④ 收尾：整体质感
  const tail = '整张图是一张完成的剧集海报，色调统一、有电影质感，人物与建筑不变形，8K 细节。'

  return head + text + forbid + tail
}

/** 封面目录：<项目>/assets/covers/<集名>。刻意不放进 成片/（那里按 .mp4 扫描） */
export function coverDirOf(ep) {
  if (!ep) return ''
  const base = ep.assetsDir || ''
  if (!base) return ''
  return joinPath(base, 'covers', seg(ep.prefix || ep.name || 'cover'))
}

/** 文件名里的比例写法：16:9 → 16x9（冒号在 Windows 文件名里非法） */
export function ratioTag(ratioId) {
  return String(ratioId || '16:9').replace(':', 'x')
}

/** '1920x1080' → [1920, 1080]；解析不出来返回 [0, 0] */
function parseRes(v) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2])] : [0, 0]
}

/**
 * 封面画布分辨率档位。
 *
 * 口径与「导出成片」弹窗完全一致（取值来自主进程 models.resOptions().out），
 * 但按当前画幅**过滤同向档位** —— 竖版画布不可能塞 1920×1080，反过来也一样，
 * 把互斥的组合直接列出来只会让人选错。
 *
 * 「自动」放第一档：= 该画幅的模型原生尺寸（横 1344×768 / 竖 768×1344）。
 * 这也是唯一能保证不糊的档 —— 再大的尺寸都是模型先按原生尺寸画、再被拉上去的。
 *
 * @param {Array<{value:string,label:string}>} outList 主进程下发的成片分辨率清单
 * @param {string} ratioId '16:9' | '9:16'
 */
export function coverResOptions(outList, ratioId) {
  const ratio = COVER_RATIOS.find(r => r.id === ratioId) || COVER_RATIOS[0]
  const auto = { value: 'auto', label: '自动（' + ratio.w + '×' + ratio.h + '，最清晰）' }
  const list = (Array.isArray(outList) ? outList : []).filter(o => {
    if (!o || !o.value || o.value === 'auto') return false
    const [w, h] = parseRes(o.value)
    if (!w || !h) return false
    // 只留跟当前画幅同向的档（横版留宽>高，竖版留高>宽）
    return ratio.portrait ? h > w : w > h
  })
  return [auto].concat(list)
}

/**
 * 画布尺寸：auto → 该画幅原生尺寸；选了具体档位 → 解析该档位。
 * 解析失败一律退回原生尺寸（宁可出一张好图，也不要因为参数脏而炸掉一次 80 秒的生成）。
 * @returns {{w:number,h:number}}
 */
export function coverSize(ratioId, resValue) {
  const ratio = COVER_RATIOS.find(r => r.id === ratioId) || COVER_RATIOS[0]
  if (!resValue || resValue === 'auto') return { w: ratio.w, h: ratio.h }
  const [w, h] = parseRes(resValue)
  return (w && h) ? { w, h } : { w: ratio.w, h: ratio.h }
}

/**
 * 文案是否满足直出的字形要求（出图前拦一道，别拿注定画坏的字去烧 80 秒）。
 * 返回 '' = 通过，否则是给用户看的原因。
 */
export function checkCopy(title, subtitle) {
  const T = String(title || '').trim()
  const S = String(subtitle || '').trim()
  if (!T) return '主标题不能为空'
  const nT = countCn(T)
  if (nT < 2 || nT > 6) return '主标题请控制在 2~6 个字（现在是 ' + nT + ' 个）'
  if (/[^\u4e00-\u9fa5]/.test(T)) return '主标题只能有汉字：标点、数字、字母都会被画坏'
  if (S) {
    const nS = countCn(S)
    if (nS < 2 || nS > 8) return '副标题请控制在 2~8 个字（现在是 ' + nS + ' 个）'
    if (/[^\u4e00-\u9fa5]/.test(S)) return '副标题只能有汉字：标点、数字、字母都会被画坏'
  }
  return ''
}
