/**
 * 提示词规范解析的纯函数（无任何依赖，可被 node 直接动态 import 做离线单测）。
 * 项目级 md 的结构约定（v2 统一结构）：
 *
 *   ---
 *   title: 分镜脚本规范
 *   module: shots
 *   rev: 2
 *   note: 给用户看的说明
 *   ---
 *   ## 适用范围
 *   ## 核心规则
 *   ## 格式与一致性
 *   ## 兜底默认          ← 只有 chars.md / scenes.md 有内容，其他写「（无）」
 */

/** 去掉 md 头部 frontmatter（--- 包裹的说明区），剩下的才是规范正文 */
export function stripHeader(md) {
  const s = String(md || '')
  const m = s.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? s.slice(m[0].length) : s
}

/** 解析 md 的 ## 小节，返回 { 标题: 正文 } */
export function parseSections(md) {
  const out = {}
  let cur = null
  for (const line of stripHeader(md).split(/\r?\n/)) {
    const h = line.match(/^##\s*(.+)$/)
    if (h) { cur = h[1].trim(); out[cur] = [] }
    else if (cur !== null && line.trim()) out[cur].push(line.trim())
  }
  const res = {}
  for (const k of Object.keys(out)) if (out[k].length) res[k] = out[k].join('\n')
  return res
}

/** 取某小节正文（按标题关键词模糊匹配，例：section(md,'兜底') 命中「## 兜底默认」） */
export function section(md, key) {
  const sec = parseSections(md)
  const k = Object.keys(sec).find(x => x.indexOf(key) >= 0)
  return k ? sec[k] : ''
}

/**
 * 解析「## 兜底默认」小节 → [{key, tpl}]。
 * 支持 "主人公: xxx" / "场景: xxx" 这种带前缀的写法（模板本身可以是中文，
 * 配合 Z-Image 等原生中文图片模型），也支持只有一行的通用模板；
 * 没有半角冒号的行视为说明文字，自动跳过。
 */
export function parseFallbacks(md) {
  const body = section(md, '兜底')
  if (!body) return []
  const out = []
  for (const raw of body.split(/\r?\n/)) {
    const ln = raw.trim().replace(/^[-*]\s*/, '')
    if (!ln || /^[（(]?无[）)]?$/.test(ln)) continue
    const m = ln.match(/^([^:]{1,10}):\s*(.+)$/)   // 只认半角冒号：全角冒号的是中文说明行
    if (!m) continue
    const tpl = m[2].trim()
    if (!tpl || /^[（(]?无[）)]?$/.test(tpl)) continue
    out.push({ key: m[1].trim(), tpl })
  }
  return out
}

/** 从 parseFallbacks 的结果里挑模板：按 keys 顺序匹配小节前缀，都没命中返回 def */
export function pickFallback(list, keys, def = '') {
  for (const k of keys) {
    const hit = (list || []).find(o => o.key && o.key.toLowerCase().indexOf(String(k).toLowerCase()) >= 0)
    if (hit) return hit.tpl
  }
  return def
}

/**
 * 场景图「空镜」保障（纯函数，2026-09-22）：
 *  背景——场景出图里带人物，主因有三：负向词在 turbo 模型（cfg=1）下不参与采样、
 *  正向里写了「剧照」这类召人词、以及正向里的「无人物」是**否定式**写法
 *  （模型对名词敏感、对否定不敏感，写着「人物」反而更容易画人）。
 *  做法：
 *   1) 先把召人词就地改写（「剧照」→「实景布景照片」，存量提示词都带这个词）；
 *   2) 再剔掉正向里的否定式空镜短语（无人物 / 不要出现人物 / 没有人物…）；
 *   3) 已含**正面**空镜陈述（空无一人）→ 原样返回，不重复补；
 *   4) 否则把 keeper（scenes.md 的「空镜必备句」，用户可随时改）补到末尾。
 * @param {string} prompt 场景正向提示词
 * @param {string} keeper 空镜必备句
 */
export function ensureSceneKeeper(prompt, keeper) {
  let s = String(prompt || '').trim()
  const k = String(keeper || '').trim()
  if (!s) return s
  // 1) 召人词就地改写：「剧照」字面就是影视现场照片，会把演员一起画进来（历史提示词的存量问题）
  s = s.replace(/真人古装剧剧照/g, '古装剧实景布景照片').replace(/剧照/g, '实景布景照片')
  // 2) 剔掉否定式空镜短语（模型对名词敏感、对否定不敏感，写着「人物」反而更容易画人）
  s = s
    .replace(/[，,]?\s*(?:画面中)?(?:请?不要|不能|不得|避免)(?:再)?出现(?:任何)?人物(?:或人影)?/g, '')
    .replace(/[，,]?\s*(?:画面中)?(?:无|没有|不含)(?:任何)?人物/g, '')
  s = s.replace(/[，,]\s*[，,]+/g, '，').replace(/^[，,\s]+|[，,\s]+$/g, '')
  if (!k) return s
  if (/空无一人/.test(s)) return s          // 已有正面空镜陈述 → 不再追加
  return s ? s + '，' + k : k
}

/**
 * 档案（角色 / 场景 profile）→ 行文本（纯函数，2026-09-22 档案层）：
 * 大模型可能给字符串（多行「字段名：值」），也可能给对象（{姓名:'李白', 身份:'士人'}）
 * 或数组；统一成每行一个字段、全角冒号分隔的文本，方便用户直接在卡片里编辑。
 */
export function normalizeProfile(v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    return v.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join('\n')
  }
  if (Array.isArray(v)) {
    return v.map(x => normalizeProfile(x)).filter(Boolean).join('\n')
  }
  if (typeof v === 'object') {
    return Object.keys(v)
      .filter(k => v[k] != null && String(v[k]).trim() !== '')
      .map(k => k + '：' + String(v[k]).replace(/\s+/g, ' ').trim())
      .join('\n')
  }
  return String(v)
}

/**
 * 卡片的「档案已改 · 提示词待更新」判定（纯函数）：
 *   _profRev   = 用户每次编辑档案自增
 *   _profRevAt = 上次生成提示词时记录的档案版本
 *   _profAck   = 用户点掉提示（先不动提示词）时记录的档案版本
 * 两者都不等于当前档案版本 → 提示词落后于档案（不自动重算，避免冲掉手改的提示词）。
 */
export function profileDirty(c) {
  const o = c || {}
  if (!String(o.profile || '').trim()) return false
  const rev = o._profRev || 0
  if (rev === (o._profRevAt || 0)) return false
  return (o._profAck || 0) !== rev
}

/**
 * 已有档案摘要（纯函数）：批量/单卡生成提示词时一并下发，
 * 让模型按「任意两个角色至少 3 个维度不同」的硬约束错开外观。
 * @param {Array}  list     本项目的角色/场景档案
 * @param {string} selfName 本次要生成提示词的那一条（从摘要中排除）
 * @param {number} max      最多列出多少条（防提示词过长）
 */
export function profileBrief(list, selfName, max = 12) {
  const rows = []
  for (const it of list || []) {
    if (!it || !it.name || it.name === selfName) continue
    const body = normalizeProfile(it.profile)
    if (!body) continue
    rows.push(it.name + '：\n' + body)
  }
  return rows.slice(0, max).join('\n\n')
}

/**
 * 组装真正的 system 提示词（纯字符串拼接，读文件由调用方负责）：
 *   身份说明（代码固定）+ 风格规范（来自项目 md）+ 输出格式契约（代码固定）
 * 这样用户改规范能调风格，但改不坏 JSON 格式等技术契约。
 */
export function joinSystem({ identity = '', specs = [], contract = '', fallback = '' } = {}) {
  const parts = (specs || []).map(s => String(s || '').trim()).filter(Boolean)
  if (!parts.length) return fallback || identity
  const blocks = [identity, '', '【风格规范】（来自项目 prompts/ 目录，可随时修改）', parts.join('\n\n---\n\n')]
  if (contract) blocks.push('', '【输出格式】', contract)
  return blocks.join('\n')
}

/**
 * 分镜行时长软校验（纯函数，2026-09-23）：
 * shots.md 的「时长规则」要求时长与内容匹配，但此前程序侧零校验——
 * LLM 心算失误或手改过小时，台词会被挤到镜头时长之外直接丢掉
 * （时长不够的视频里，台词/笑声都会被截）。只提示、不拦截、不覆盖手改。
 *
 * 校验三条（对应 shots.md「时长规则」）：
 *   1) 台词：字数 ÷ 4.5 字/秒 + 起止停顿 1s（对白行「说话人名：台词」，只计台词正文）
 *   2) 台词外发声表演（大笑/痛哭/惊呼/喘息…）：每段 +2s
 *   3) 复合运镜（camera 出现 ≥2 个运镜动词，或「随后/然后/再」衔接两段运镜）：建议 ≥6s
 * @param {object} s 单个镜头 { dur, dialogue, camera, action }
 * @returns {Array<string>} 违规说明列表，空数组 = 通过
 */
export function durWarnings(s) {
  const o = s || {}
  const dur = Math.round(Number(o.dur) || 0)
  const out = []
  if (!dur) return out

  // 台词正文字数：跳过「说话人名：」前缀，汉字每字记 1，连续英数串记 1
  let chars = 0
  for (const ln of String(o.dialogue || '').split(/\r?\n/)) {
    const line = ln.trim()
    if (!line) continue
    const body = line.indexOf('：') >= 0 ? line.slice(line.indexOf('：') + 1) : line
    const cjk = (body.match(/[\u4e00-\u9fa5]/g) || []).length
    const lat = (body.match(/[A-Za-z0-9]+/g) || []).length
    chars += cjk + lat
  }
  // 发声表演段数（大笑、痛哭这类有明确声源的发声，只写画面动词=无声）
  const act = String(o.action || '')
  const sounds = (act.match(/大笑|狂笑|痛哭|哭喊|嚎啕|惊呼|尖叫|喘息|抽泣|呜咽|长叹/g) || []).length

  let need = 0
  if (chars > 0) need += Math.ceil(chars / 4.5) + 1
  if (sounds > 0) need += sounds * 2
  if (need > 0 && dur < need) {
    const why = []
    if (chars > 0) why.push('台词约 ' + chars + ' 字')
    if (sounds > 0) why.push(sounds + ' 段发声表演')
    out.push(why.join(' + ') + ' ≈ 至少需 ' + need + 's（当前 ' + dur + 's），声音会被截')
  }

  // 复合运镜：≥2 个不同运镜动词，或用「随后/然后/再」衔接两段运镜
  const cam = String(o.camera || '')
  const verbs = new Set((cam.match(/推|拉|摇|移|跟|环绕|甩|升降/g) || []))
  const compound = verbs.size >= 2 || /随后|然后|，再|、再/.test(cam)
  if (compound && dur < 6) {
    out.push('复合运镜（' + cam.slice(0, 20) + (cam.length > 20 ? '…' : '') + '）建议 ≥6s（当前 ' + dur + 's）')
  }
  return out
}
