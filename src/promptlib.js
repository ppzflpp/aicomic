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
 * 取某小节的**原始正文**（保留空行与缩进）。
 * 🔴 与 section() 的区别：section() 走 parseSections，会把空行和纯空白行吃掉、并逐行 trim
 *    —— 那对「读一句话」「读模板行」没问题，但会把按空行分段的模板压成一整段
 *    （2026-09-24 实测：素材模板的空段删除逻辑因此整体失效）。渲染模板一律用这个。
 */
export function sectionRaw(md, key) {
  const out = []
  let on = false
  for (const ln of stripHeader(md).split(/\r?\n/)) {
    const h = ln.match(/^##\s*(.+?)\s*$/)
    if (h) { on = h[1].indexOf(key) >= 0; continue }
    if (on) out.push(ln)
  }
  return out.join('\n').trim()
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
 * 带「人」字的旧式空镜陈述（连它后面紧跟的「只有…」从句一起）：只做**删除**，
 * 替代文案一律来自 md 的 keeper，代码里不写死任何提示词文案。
 * （无论是「画面里空无一人」还是「空无一人」，句子里的「人」字本身就会把人生成出来）
 */
const LEGACY_EMPTY_RE = /[，,]?\s*(?:画面[内中里]?\s*)?空无一[人个](?:[，,]\s*只(?:有|见)[^，,]*)?/g
/** 同上，但**不吞后面的「只有…」从句**——净化 keeper 自身时用，免得把「只有…」这一半正向陈述也删掉 */
const LEGACY_EMPTY_WORD_RE = /[，,]?\s*(?:画面[内中里]?\s*)?空无一[人个]/g

function stripEmptyClaim(t) {
  return String(t || '').replace(LEGACY_EMPTY_RE, '')
}
function stripEmptyWord(t) {
  return String(t || '').replace(LEGACY_EMPTY_WORD_RE, '')
}

/**
 * 场景图「空镜」保障（纯函数，2026-09-22；2026-09-24 改为纯正向陈述）：
 *  背景——场景出图里带人物，主因有三：负向词在 turbo 模型（cfg=1）下不参与采样、
 *  正向里写了「剧照」这类召人词、以及正向里的空镜说法**自己带「人」字**
 *  （否定式「不要出现人物」、或描述式「空旷得连一个人都没有」都一样：
 *   模型对名词敏感、对否定不敏感，句子里出现「人」字就更容易把人画出来）。
 *  做法：
 *   1) 先把召人词就地改写（「剧照」→「实景布景照片」，存量提示词都带这个词）；
 *   2) 再剔掉正向里的否定式空镜短语（无人物 / 不要出现人物 / 没有人物…）；
 *   3) 再删掉**带「人」字的旧式空镜陈述**（keeper 读不到时不动它，至少留个空镜声明）；
 *   4) 已含 keeper 的空镜陈述（哨兵 = keeper 去掉第一个短语后的部分，随 md 自动更新）
 *      → 原样返回，不重复补；
 *   5) 否则把 keeper（scenes.md 的「空镜必备句」，用户可随时改）补到末尾。
 * @param {string} prompt 场景正向提示词
 * @param {string} keeper 空镜必备句
 */
export function ensureSceneKeeper(prompt, keeper) {
  let s = String(prompt || '').trim()
  if (!s) return s
  const k = stripEmptyWord(String(keeper || '').trim())   // keeper 自身若是旧写法也一并净化（只删陈述本身）
  // 1) 召人词就地改写：「剧照」字面就是影视现场照片，会把演员一起画进来（历史提示词的存量问题）
  s = s.replace(/真人古装剧剧照/g, '古装剧实景布景照片').replace(/剧照/g, '实景布景照片')
  // 2) 剔掉否定式空镜短语（模型对名词敏感、对否定不敏感，写着「人物」反而更容易画人）
  s = s
    .replace(/[，,]?\s*(?:画面中)?(?:请?不要|不能|不得|避免)(?:再)?出现(?:任何)?人物(?:或人影)?/g, '')
    .replace(/[，,]?\s*(?:画面中)?(?:无|没有|不含)(?:任何)?人物/g, '')
  // 3) 带「人」字的旧式空镜陈述 → 删掉（末尾会按 md 的 keeper 补回纯正向陈述）
  if (k) s = stripEmptyClaim(s)
  s = s.replace(/[，,]\s*[，,]+/g, '，').replace(/^[，,\s]+|[，,\s]+$/g, '')
  if (!k) return s
  // 4) 已有空镜陈述的判据也从 keeper 派生（去掉第一个短语后的整段），md 改了代码自动跟随
  const segs = k.split('，').map(x => x.trim()).filter(Boolean)
  const sentinel = segs.length > 1 ? segs.slice(1).join('，') : k
  if (sentinel && s.includes(sentinel)) return s
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
 * 组装 system 提示词（纯字符串拼接，读文件由调用方负责）。
 *
 * 🔴 2026-09-24 架构调整：**提示词全部由 md 规范文件承载，代码不再硬编码任何提示词片段**。
 *   每份 md 的正文（去掉 frontmatter 后）就是它那一段的提示词，里面自带
 *   「## 角色与任务」（身份与任务说明）与「## 输出格式」（输出契约）。
 *   一个任务用到多份规范时（例：分镜 = 分镜规范 + 档案规范 + 角色规范 + 场景规范），
 *   用 `---` 分隔后整篇下发，顺序即 specs 的排列顺序 —— 也就是 md 的排列顺序。
 *
 * @param {string[]} specs    规范正文（已去 frontmatter、已按序排好）
 * @param {string[]} mustHave 契约守卫：这些关键内容必须出现在拼装结果里。
 *                            兜的是「用户把 JSON 字段名改掉 → 程序解析失败」这类
 *                            改不坏的技术契约 —— 缺了就明确报错，而不是静默生成一堆废数据。
 */
export function joinSystem({ specs = [], mustHave = [] } = {}) {
  const parts = (specs || []).map(s => String(s || '').trim()).filter(Boolean)
  if (!parts.length) {
    throw new Error('未读到任何提示词规范文件：请检查项目 prompts/ 目录（缺失时重开一次生成会自动补齐内置版）')
  }
  const text = parts.join('\n\n---\n\n')
  const missing = (mustHave || []).filter(k => k && text.indexOf(k) < 0)
  if (missing.length) {
    throw new Error('提示词规范缺少关键内容（' + missing.join(' / ') +
      '）：请在「提示词规范」里恢复对应小节，或删掉该文件让它重播内置版')
  }
  return text
}

/**
 * 去掉「程序用途小节」（`## 兜底默认` 与 `## 素材格式`）：
 * 这两节是给程序读的（生图兜底模板 / user 消息的编排模板），不该随 system 发给大模型。
 * 其余小节照原样保留并保持顺序。
 */
export function stripProgramSections(md) {
  const out = []
  let skip = false
  for (const ln of String(md || '').split(/\r?\n/)) {
    const h = ln.match(/^##\s*(.+?)\s*$/)
    if (h) skip = /^(兜底默认|素材格式)$/.test(h[1])
    if (!skip) out.push(ln)
  }
  return out.join('\n')
}

/**
 * 素材模板填充（纯函数）：把规范 md 的「## 素材格式」小节渲染成 user 消息。
 * 规则：
 *   - 正文按**空行分段**；
 *   - 段内 `{{key}}` 替换为 vars[key]（trim 后）；
 *   - 某段含占位符、且这些占位符的值**全为空** → 整段删掉（空素材不留下空标题）。
 * 这样「user 消息里写什么」也归规范 md 管，代码只负责取值与替换。
 */
export function fillTemplate(tpl, vars) {
  const v = vars || {}
  const get = k => (v[k] == null ? '' : String(v[k])).trim()
  const out = []
  for (const p of String(tpl || '').split(/\r?\n\s*\r?\n/)) {
    const keys = [...p.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(m => m[1])
    if (keys.length && keys.every(k => !get(k))) continue
    out.push(p.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => get(k)))
  }
  return out.join('\n\n').trim()
}

/** 剥掉句尾的英文括注（存量改编稿曾把画外音英文说明带进台词行，2026-09-27）：
 *  只剥括号内含英文字母的**句尾**括注——中文标注（独白）不受影响。durNeed 同源使用 */
export function stripTailEnNote(text) {
  return String(text || '')
    .replace(/\s*[（(][^（）()]*[A-Za-z][^（）()]*[)）]\s*$/, '')
    .trim()
}

/**
 * 内部共用：算单个镜头「内容所需时长」的三要素（durWarnings / durSuggest 同源，保证提示与建议永不打架）：
 *   chars/need —— 台词正文字数与所需秒数（÷4.5 + 停顿 1s，向上取整）
 *   sounds     —— 发声表演段数（每段 +2s 已计入 need）
 *   compound   —— 复合运镜（≥2 个运镜动词，或「随后/然后/再」衔接）
 */
function durNeed(o) {
  const dur = Math.round(Number(o.dur) || 0)
  // 台词正文字数：跳过「说话人名：」前缀，汉字每字记 1，连续英数串记 1；先剥句尾英文括注
  let chars = 0
  for (const ln of String(o.dialogue || '').split(/\r?\n/)) {
    const line = ln.trim()
    if (!line) continue
    const body = stripTailEnNote(line.indexOf('：') >= 0 ? line.slice(line.indexOf('：') + 1) : line)
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
  const cam = String(o.camera || '')
  const verbs = new Set((cam.match(/推|拉|摇|移|跟|环绕|甩|升降/g) || []))
  const compound = verbs.size >= 2 || /随后|然后|，再|、再/.test(cam)
  return { dur, chars, sounds, need, compound }
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
  const n = durNeed(s || {})
  const out = []
  if (!n.dur) return out

  if (n.need > 0 && n.dur < n.need) {
    const why = []
    if (n.chars > 0) why.push('台词约 ' + n.chars + ' 字')
    if (n.sounds > 0) why.push(n.sounds + ' 段发声表演')
    out.push(why.join(' + ') + ' ≈ 至少需 ' + n.need + 's（当前 ' + n.dur + 's），声音会被截')
  }

  // 复合运镜：≥2 个不同运镜动词，或用「随后/然后/再」衔接两段运镜
  if (n.compound && n.dur < 6) {
    const cam = String(s.camera || '')
    out.push('复合运镜（' + cam.slice(0, 20) + (cam.length > 20 ? '…' : '') + '）建议 ≥6s（当前 ' + n.dur + 's）')
  }
  return out
}

/**
 * 建议时长（整数秒）：内容所需秒数（台词/发声）与复合运镜下限 6s 取大者；
 * 上限封到 15s（H3 生成上限，需要更多就该拆镜头）；通过 = 0。
 * 供分镜行「⚠ 时长紧·建议 Ns」直读，与 durWarnings 共用同一套计算。
 */
export function durSuggest(s) {
  const n = durNeed(s || {})
  if (!n.dur) return 0
  return Math.min(15, Math.max(n.need, n.compound ? 6 : 0))
}

// ---------------------------------------------------------------
// 镜头连续性软校验（2026-09-23）
//   背景：每镜独立生成、模型无跨镜记忆，服装/随身道具的状态只在「变化的那一镜」
//   被写出来，其余镜头一字不提 → 模型自由发挥（实测：没戴帽子却出现摘帽子、
//   凭空多出带兜帽的斗篷）。修法 = 每镜写出**全量状态快照**（continuity），
//   变化镜额外标出变化点（change），由程序在生成 H3 提示词前逐镜注入。
//   与题材无关：字段值全是自由文本，维度不预设（外观/随身物/伤势/发型/天气…），
//   本模块只做结构校验，不认识任何具体故事的名词。
// ---------------------------------------------------------------

/** 移除类动词（语言层通用词表，与题材无关）：出现它们就意味着「此物此前必须已经在身上/手上」 */
const CONT_REMOVE = ['摘下', '摘掉', '脱下', '脱掉', '褪下', '卸下', '解下', '解开', '取下', '拿下',
  '拆下', '扯下', '撕下', '扔掉', '丢掉', '甩掉', '放下', '收起', '松开']

/** 自身身体部位/生理反应词：作为宾语时不需要「前置携带」，跳过（松开手指、放下心来…）。
 *  🔴 必须整词精确匹配：写成前缀匹配会把「肩甲」「手帕」这类道具一起放过（实测踩过）。 */
const CONT_BODY = new Set(['心', '手', '眼', '嘴', '脸', '头', '眉', '拳', '指', '脚', '腿', '肩', '身', '腰', '口', '牙', '额',
  '手指', '手掌', '手臂', '手腕', '拳头', '额头', '眉毛', '肩膀', '脖子', '目光', '视线', '神情', '表情', '呼吸',
  '嗓子', '声音', '眼泪', '身子', '脚步', '手势', '心来', '心头', '心情', '戒备', '警惕'])

/** 取中文字段里的「2 字滑窗」集合，用于宽松匹配（比整串匹配抗措辞漂移） */
function bigrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const out = []
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
  return out
}

/** from 与 before 是否有任意 2 字重合（措辞不同但指向同一物时也算命中） */
function shareBigram(from, before) {
  const b = bigrams(from)
  return b.length ? b.some(x => before.indexOf(x) >= 0) : false
}

/**
 * 分镜连续性软校验（纯函数）：
 *   R1 变化前就越界：change 的「新值」此前已经在快照里出现过 → 变化提前发生
 *   R2 凭空造物：action 里出现「移除动词 + 物」（摘/脱/解/扔…），但此前快照里从没有过该物
 *   R3 状态回退：变化镜之后的快照又写回「旧值」
 *   R4 后续没跟上：变化镜之后紧邻的第一条快照既没提该主体、也没沾到「新值」
 * 只提示、不拦截、不覆盖手改；老数据（没有 continuity/change 字段）一律跳过。
 * @param {Array} list 镜头数组
 * @returns {Array<Array<string>>} 与 list 等长，每项是该镜的违规说明列表
 */
export function contWarnings(list) {
  const arr = (Array.isArray(list) ? list : []).map(s => s || {})
  const n = arr.length
  const res = arr.map(() => [])
  const snap = arr.map(s => String(s.continuity || '').trim())
  const hasChg = arr.some(s => String(s.change || '').trim())
  if (!snap.some(Boolean) && !hasChg) return res   // 存量数据：无字段 = 不校验

  for (let i = 0; i < n; i++) {
    const s = arr[i]
    const before = snap.slice(0, i).filter(Boolean).join('\n')
    const act = String(s.action || '')

    // ---- 变化点（change 格式：主体·维度：旧值 → 新值（触发动作））----
    const chg = String(s.change || '').trim()
    if (chg) {
      const m = chg.match(/^(.*?)[：:]\s*(.+?)\s*(?:→|->|—>|变成|变为|改为)\s*(.+?)\s*(?:[（(]([^）)]*)[）)])?$/)
      if (m) {
        const from = m[2].trim(), to = m[3].trim(), trig = String(m[4] || '').trim()
        // R1：变化前就越界（新值 ≥3 字才判，避免「衣裳」这类通名误报）
        if (to.length >= 3) {
          const k = snap.slice(0, i).findIndex(t => t.indexOf(to) >= 0)
          if (k >= 0) res[i].push('变化提前：第 ' + (k + 1) + ' 镜的状态里已出现「' + to + '」，早于本镜的变化点')
        }
        // R1b：变化点缺少前置状态（旧值在此前快照里毫无痕迹 → 凭空变化）
        if (from && before && !shareBigram(from, before)) {
          res[i].push('变化点无来处：「' + from + '」在此前的镜头里从未出现，观众会看到凭空变化')
        }
        // R3：状态回退
        if (from) {
          const k = snap.findIndex((t, x) => x > i && t && t.indexOf(from) >= 0)
          if (k >= 0) res[k].push('状态回退：第 ' + (i + 1) + ' 镜已把「' + from + '」变成「' + to + '」，本镜又写回「' + from + '」')
        }
        // R4：后续没跟上（紧邻的下一镜有快照，却完全没提这次变化）
        const sub = String(m[1] || '').split(/[·:：]/)[0].trim()
        let k2 = i + 1
        while (k2 < n && !snap[k2]) k2++
        if (k2 < n && sub && snap[k2].indexOf(sub) < 0 && !shareBigram(to, snap[k2])) {
          res[k2].push('没跟上第 ' + (i + 1) + ' 镜的变化（' + sub + '）：本镜状态里既没有它，也没写变化后的样子')
        }
        // R4b：标了变化点，但本镜画面动作里没有这个动作（触发器可能是叙述性从句，用 2 字滑窗宽松比对）
        if (trig && act.indexOf(trig) < 0 && !shareBigram(trig, act)) {
          res[i].push('标了状态变化「' + trig + '」，但本镜画面动作里没有这个动作（模型看不见这个变化）')
        }
      }
    }

    // ---- R2：移除类动词缺少前置携带 ----
    if (before) {
      for (const v of CONT_REMOVE) {
        let p = act.indexOf(v)
        while (p >= 0) {
          const obj = act.slice(p + v.length)
            .replace(/^[了着掉过]/, '')
            .replace(/^(?:自己|他|她|它|手中|手里|身上|头上|脸上|肩头|肩上|臂上|腕上|腰间|脚上|的)*的?/, '')
            .match(/^[\u4e00-\u9fa5]{2,4}/)
          const o = obj ? obj[0] : ''
          if (o && !CONT_BODY.has(o) && before.indexOf(o) < 0) {
            res[i].push('动作「' + v + o + '」缺少前置：此前的镜头里从没出现过「' + o + '」，会被凭空画出来')
            break
          }
          p = act.indexOf(v, p + 1)
        }
      }
    }
    res[i] = Array.from(new Set(res[i]))   // 同一文案只留一条（多个动词命中同一物件时不重复刷屏）
  }
  return res
}

// ---------------------------------------------------------------
// 镜头合并（2026-09-23）
//   背景：LLM 习惯把「同角色的反应镜 + 台词镜」拆成两条（实测 T3 第一集 17 镜里
//   有 7 对这种结构），每多一镜就多一次独立生成 → 漂移/穿帮机会放大。程序侧
//   检出可合并的相邻镜头后黄标提示，用户一键合并；合不合由用户定，只提示不拦截。
// ---------------------------------------------------------------

/** 角色串 → 去重后的有序数组（兼容 、 ， , 三种分隔） */
function charList(s) {
  const seen = new Set()
  const out = []
  for (const x of String(s || '').split(/[、，,]/)) {
    const t = x.trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

/**
 * 相邻镜头可合并检测（纯函数）。第 i 镜（i ≥ 1）可与第 i-1 镜合并的条件：
 *   1) 场景一致（逐字相等且非空）
 *   2) 角色集合一致（顺序无关）
 *   3) 相邻两镜只有一方有台词（一方是纯反应/动作镜）
 *   4) 时长相加 ≤ 15s（H3 单镜生成上限）
 * @returns {Array<string>} 与 list 等长；第 i 项非空 = 提示文案（含合计秒数），空串 = 不可/不必合并
 */
export function mergeWarnings(list) {
  const arr = (Array.isArray(list) ? list : []).map(s => s || {})
  const res = arr.map(() => '')
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1], b = arr[i]
    const dur = (Number(a.dur) || 0) + (Number(b.dur) || 0)
    if (!dur || dur > 15) continue
    if (!a.scene || a.scene !== b.scene) continue
    const ca = charList(a.chars), cb = charList(b.chars)
    if (ca.length !== cb.length || !ca.every((x, k) => cb[k] === x)) continue
    const da = String(a.dialogue || '').trim(), db = String(b.dialogue || '').trim()
    if (da && db) continue                      // 双方都有台词 = 各自是独立叙事节拍，不提示
    res[i] = '可与上一镜合并（合计 ' + dur + 's）'
  }
  return res
}

/**
 * 合并两镜为一条（确定性字段处理，纯函数；_rev 由调用方处理）：
 *   action      两镜动作拼接（前镜去句末标点后用「，」衔接）
 *   dialogue    逐行拼接（「人名：台词」格式逐行保留）
 *   camera      取后镜（后镜运镜代表这段的收尾；后镜为空则保留前镜）
 *   continuity  取后镜快照（后镜状态代表合并后的状态；后镜为空则保留前镜）
 *   change      取后镜的变化标记；前镜有而后镜没有时保留前镜的
 *   chars       并集（保序去重）；scene/dur 等其余字段照常合并
 */
export function mergeShotPair(a, b) {
  a = a || {}; b = b || {}
  const act = (String(a.action || '').trim().replace(/[。．.！!？?；;]+$/, '') + '，' + String(b.action || '').trim())
    .replace(/^，/, '')
  const dlg = [String(a.dialogue || '').trim(), String(b.dialogue || '').trim()].filter(Boolean).join('\n')
  const chg = String(b.change || '').trim() || String(a.change || '').trim()
  const merged = {
    scene: String(b.scene || a.scene || '').trim(),
    chars: charList((a.chars || '') + '、' + (b.chars || '')).join('、'),
    action: act,
    dialogue: dlg,
    camera: String(b.camera || '').trim() || String(a.camera || '').trim(),
    dur: (Number(a.dur) || 0) + (Number(b.dur) || 0)
  }
  const cont = String(b.continuity || '').trim() || String(a.continuity || '').trim()
  if (cont) merged.continuity = cont
  if (chg) merged.change = chg
  return merged
}

// ---------------------------------------------------------------
// 场景档案 ↔ 镜头场景 一致性护栏（2026-09-24）
//   背景（实测三个项目，中两个）：模型在「分镜」这一批输出里会
//     ① 漏写/写空 scenes[].profile；
//     ② 把同一场景写成两种拼法（镜头「山上·古棋馆遗址·外 - 黄昏」/ 档案「山上·古棋馆遗址」）
//        → 档案挂在没有任何镜头使用的名字上，镜头真正在用的那张卡档案为空
//        → 那张卡的生图退化成与剧本无关的通用古装空镜（scenes.md：档案是场景图的唯一依据）。
//   这里做两件事：
//     sceneAlign()      宽松命中且候选唯一 → 把档案名改成镜头里的拼法（会改数据，生成时自动救回）
//     sceneCardIssues() 只读体检 → 缺档案 / 空档案 / 挂错名字（带建议目标），供 UI 打黄标
// ---------------------------------------------------------------

/** 场景名归一化键：去掉所有分隔符与空白、全角转半角、忽略大小写（只用于宽松比对，不用于落库） */
export function sceneKey(name) {
  return String(name == null ? '' : name)
    .replace(/[\s\u3000·・．.\-—–－_/\\|()（）[\]【】{}「」『』]/g, '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
}

/** 镜头里出现过的场景名（保序去重） */
function shotSceneNames(shots) {
  const out = []
  for (const s of (Array.isArray(shots) ? shots : [])) {
    const n = String((s && s.scene) || '').trim()
    if (n && out.indexOf(n) < 0) out.push(n)
  }
  return out
}

/**
 * 场景档案名对齐（纯函数，返回新数组，不改入参）：
 * 对每条「镜头里没有逐字用过」的档案，去镜头场景名单里找**宽松候选**（归一化键相等，
 * 或一方完整包含另一方且较短者 ≥ 4 字）：
 *   - 恰好 1 个候选 → 改名成镜头里的拼法（这是模型拼写漂移，能安全救回）
 *   - 0 个或多个   → 不动（宁可留着让用户判断，也不乱认）
 * 改名后与已有同名的档案合并（档案取较长的、提示词取非空的、图片并集）。
 * @returns {{scenes: Array, moves: Array<{from:string,to:string}>, merged: Array<string>}}
 */
export function sceneAlign(shots, scenes) {
  const used = shotSceneNames(shots)
  const usedKeys = used.map(sceneKey)
  const arr = (Array.isArray(scenes) ? scenes : []).filter(o => o && String(o.name || '').trim())
    .map(o => ({ ...o, name: String(o.name).trim() }))
  const moves = []
  const result = []
  const byKey = new Map()

  for (const a of arr) {
    let name = a.name
    if (used.indexOf(name) < 0) {
      const k = sceneKey(name)
      const cand = []
      for (let i = 0; i < used.length; i++) {
        const uk = usedKeys[i]
        if (!uk || !k) continue
        if (uk === k) { cand.push(used[i]); continue }
        const shorter = uk.length <= k.length ? uk : k
        if (shorter.length >= 4 && (uk.indexOf(k) >= 0 || k.indexOf(uk) >= 0)) cand.push(used[i])
      }
      const uniq = cand.filter((v, i) => cand.indexOf(v) === i)
      if (uniq.length === 1) { name = uniq[0]; moves.push({ from: a.name, to: name }) }
    }
    const key = name
    if (!byKey.has(key)) {
      const item = { ...a, name }
      byKey.set(key, item)
      result.push(item)
    } else {
      // 撞名（原本就重复，或改名后与已有条目撞上）→ 合并：档案/提示词取非空且更长的，图片并集
      const t = byKey.get(key)
      if (String(a.profile || '').length > String(t.profile || '').length) t.profile = a.profile
      if (!String(t.prompt || '').trim()) t.prompt = a.prompt
      if (!String(t.negative || '').trim()) t.negative = a.negative
      const cands = []
      for (const f of [].concat(t.candidates || [], a.candidates || [])) if (cands.indexOf(f) < 0) cands.push(f)
      t.candidates = cands
      if (!(typeof t.cur === 'number' && t.cur >= 0) && typeof a.cur === 'number' && a.cur >= 0) t.cur = a.cur
      if (!t.res) t.res = a.res
    }
  }
  return { scenes: result, moves, merged: moves.map(m => m.to) }
}

/**
 * 场景卡体检（纯函数，只读）：
 * 以「镜头场景名单」为事实基准，逐条给出黄标文案。
 *   used   镜头里用到的场景名（保序）
 *   byName name → 文案（仅在有问题的名字上有键）
 *          · '分镜没有给这个场景写档案（提示词会退化成通用空镜）'
 *          · '场景档案是空的（…）'
 *          · '没有任何镜头在用这个场景名'
 *          · '档案可能挂错了名字：镜头里用的是「X」'（宽松命中唯一候选时给出建议目标）
 * @returns {{used:Array<string>, byName:Object<string,string>, advice:Object<string,string>, ok:boolean}}
 */
export function sceneCardIssues(shots, scenes) {
  const used = shotSceneNames(shots)
  const usedKeys = used.map(sceneKey)
  const arr = (Array.isArray(scenes) ? scenes : []).filter(o => o && String(o.name || '').trim())
  const byName = new Map(arr.map(o => [String(o.name).trim(), o]))
  const out = {}
  const advice = {}
  for (const n of used) {
    const a = byName.get(n)
    if (!a) { out[n] = '分镜没有给这个场景写档案（提示词会退化成通用空镜）'; continue }
    if (!String(a.profile || '').trim()) out[n] = '场景档案是空的（点「刷新提示词」重算前请先补档案）'
  }
  for (const a of arr) {
    const n = String(a.name).trim()
    if (used.indexOf(n) >= 0) continue
    // 挂错名字：找一个唯一的宽松候选
    const k = sceneKey(n)
    const cand = []
    for (let i = 0; i < used.length; i++) {
      const uk = usedKeys[i]
      if (!uk || !k) continue
      if (uk === k) { cand.push(used[i]); continue }
      const shorter = uk.length <= k.length ? uk : k
      if (shorter.length >= 4 && (uk.indexOf(k) >= 0 || k.indexOf(uk) >= 0)) cand.push(used[i])
    }
    const uniq = cand.filter((v, i) => cand.indexOf(v) === i)
    if (uniq.length === 1) {
      out[n] = '档案可能挂错了名字：镜头里用的是「' + uniq[0] + '」'
      advice[n] = uniq[0]
    } else {
      out[n] = '没有任何镜头在用这个场景名（用「写入镜头…」写进镜头，或删掉这张卡）'
    }
  }
  return { used, byName: out, advice, ok: Object.keys(out).length === 0 }
}

// ---------------------------------------------------------------
// 角色名 ↔ 卡片名 一致性护栏（2026-09-27）
//   背景（实测）：改编稿给同一人写两种名字（「人名（主角）」/「人名」），
//   下游 shots[].chars 抄了带标签的、卡片存的是光名字 → 说话人按名字精确
//   匹配卡片时挂空（拿不到参考图、外观档案也不在清单里）。
//   方向（与场景对齐相反）：**卡名是图片目录的 key，动卡名会断链** ——
//   自动改的是**镜头侧**（chars 字段 + dialogue 说话人），向卡名对齐。
//   🔴 卡侧撞键（多张卡剥掉括号标签后同键）绝不自动归并——可能本来就是两个
//     不同的人（主角与「同名（同伴 A）」），只出黄标让人工判断，宁可不动。
// ---------------------------------------------------------------

/** 角色名归一化键：剥掉所有括号及括号内的定位标签、去空白、全角转半角、忽略大小写。
 *  只用于宽松比对；「基础名-限定词」（年龄 / 形态变体）里的连字符是合法命名，保留不剥。 */
export function charKey(name) {
  return String(name == null ? '' : name)
    .replace(/[（(][^（）()]*[)）]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
}

/** dialogue 说话人括号里**允许保留**的画外音标注词（与 h3.md 的画外音判定口径一致）；
 *  除此之外的括号内容（主角 / 同伴 A 这类定位标签）在对齐时剥掉——它们不是台词标注 */
const VO_TAG_RE = /^(独白|心声|内心|心里|旁白|画外音|画外|回忆|闪回|混响)$/

/**
 * 镜头人物名对齐（纯函数，返回新数组，不改入参）：
 * 对镜头里出现的每个人名（chars 字段 + dialogue 行首说话人），若不是任何卡名，
 * 就用 charKey 宽松匹配卡片名：
 *   - 恰好 1 张卡命中 → 镜头侧改名成卡名（剥掉定位标签，安全救回）
 *   - 多张卡命中（剥标签后同键）→ 不改，黄标「疑似同一个人被建成多张卡」
 *   - 0 张卡命中     → 不改，黄标「没有同名角色卡，参考图会挂不上」
 * @returns {{shots:Array, fixes:Array<{from:string,to:string}>, warnings:Array<string>}}
 */
export function charAlign(shots, cards) {
  const arr = (Array.isArray(shots) ? shots : []).map(s => s || {})
  const cardNames = []
  for (const c of (Array.isArray(cards) ? cards : [])) {
    const n = String((c && c.name) || '').trim()
    if (n && cardNames.indexOf(n) < 0) cardNames.push(n)
  }
  const nameSet = new Set(cardNames)
  const byKey = new Map()
  for (const n of cardNames) {
    const k = charKey(n)
    if (!k) continue
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(n)
  }
  const rename = new Map()       // 旧名 → 新名（唯一候选才进）
  const ambiguous = new Map()    // 旧名 → [卡名...]（剥标签后同键的多张卡）
  const missing = new Set()      // 宽松比对也命不中的镜头名
  const warnedKeys = new Set()   // 卡侧撞键已报过的宽松键（防重复黄标）
  // 卡侧自身撞键：两张卡剥掉括号标签后同键（如「张三」与「张三（同伴 A）」）——
  // 可能是同一个人被建成两张卡，不自动归并，只给黄标（与 sceneAlign 撞名同思路）
  const cardWarnings = []
  for (const [k, cands] of byKey) {
    if (cands.length > 1) {
      warnedKeys.add(k)
      cardWarnings.push('角色卡「' + cands.join('」「') + '」剥掉括号标签后是同一个名字——疑似同一个人被建成多张卡，请人工确认；已保留原文不自动改')
    }
  }
  const resolve = (n) => {
    if (!n || nameSet.has(n)) return n
    if (rename.has(n)) return rename.get(n)
    if (ambiguous.has(n)) return n
    const k = charKey(n)
    if (!k) return n
    const cands = byKey.get(k) || []
    if (cands.length === 1) { rename.set(n, cands[0]); return cands[0] }
    if (cands.length > 1) {
      ambiguous.set(n, cands)
      if (!warnedKeys.has(k)) {
        warnedKeys.add(k)
        cardWarnings.push('「' + n + '」剥掉括号标签后对应 ' + cands.length + ' 张卡（' + cands.join(' / ') +
          '）——疑似同一个人被建成多张卡，请人工确认；已保留原文不自动改')
      }
      return n
    }
    missing.add(n)
    return n
  }
  const out = arr.map(s => {
    const charsStr = charList(s.chars).map(resolve).join('、')
    let dialogue = String(s.dialogue || '')
    if (dialogue.trim()) {
      dialogue = dialogue.split(/\r?\n/).map(ln => {
        const m = ln.match(/^([^：:]{1,24})[：:]\s*([\s\S]*)$/)
        if (!m) return ln
        let who = m[1].trim(), tag = ''
        const pm = who.match(/^(.*?)[（(]([^（）()]*)[）)]$/)
        if (pm) { who = pm[1].trim(); tag = pm[2].trim() }   // 括号标注拆出来单独判：画外音标注保留，定位标签剥掉
        const who2 = resolve(who)
        const keepTag = tag && VO_TAG_RE.test(tag)
        if (who2 === who && (keepTag || !tag)) return ln
        return who2 + (keepTag ? '（' + tag + '）' : '') + '：' + m[2]
      }).join('\n')
    }
    const shot = { ...s }
    if (charsStr !== String(s.chars || '')) shot.chars = charsStr
    if (dialogue !== String(s.dialogue || '')) shot.dialogue = dialogue
    return shot
  })
  const warnings = cardWarnings
  for (const n of missing) {
    warnings.push('镜头里的人物「' + n + '」没有同名角色卡（宽松比对未命中），说话人的参考图会挂不上')
  }
  return { shots: out, fixes: Array.from(rename.entries()).map(([from, to]) => ({ from, to })), warnings }
}

// ---------------------------------------------------------------
// 素材名单覆盖检查（2026-09-27）
//   背景（实测）：素材正文常自带「参与人物：…」「场景：…」这类清单行——那是作者
//   给的硬信息，但改编稿可能把其中的人 / 地点整个漏掉（实测：清单里的「路人」
//   完全没落地、清单里的地点没有场景档案）。
//   通用做法：只认「标签 + 名单」这一**结构特征**（标签词表覆盖常见写法），
//   抽不到任何名单行就整体跳过（checked=false，UI 不提示）——绝不靠猜。
// ---------------------------------------------------------------

const LIST_LABEL_RE = /^(参与人物|出场人物|登场人物|人物表|主要人物|人物|角色|主演|场景|地点|场景列表|场景表)\s*[:：]\s*(.+)$/
const LIST_SCENE_LABEL_RE = /^(场景|地点|场景列表|场景表)$/

/** 名单行拆名字：按常见分隔符拆，只留 2~12 字的有效名字 */
function splitListNames(s) {
  const out = []
  for (const x of String(s || '').split(/[、，,/／;；\s]+/)) {
    const t = x.trim().replace(/^[「『"']|[」』"']$/g, '')
    if (t.length >= 2 && t.length <= 12 && out.indexOf(t) < 0) out.push(t)
  }
  return out
}

/**
 * 素材名单 vs 改编稿覆盖检查（纯函数，只读）：
 * @returns {{checked:boolean, names:string[], scenes:string[],
 *            missing:string[], missingScenes:string[]}}
 *   checked=false 表示素材里没有可识别的名单行（不提示，避免误报）
 */
export function listCoverage(chapter, adapted) {
  const names = []
  const scenes = []
  for (const ln of String(chapter || '').split(/\r?\n/)) {
    const m = ln.trim().match(LIST_LABEL_RE)
    if (!m) continue
    const items = splitListNames(m[2])
    // 🔴 必须带花括号：这里曾是「if (...) for ... else for ...」的单行写法，
    //    else 被悬垂绑定到内层 if 上，「人物」类名单行整行被跳过（实测踩坑）
    if (LIST_SCENE_LABEL_RE.test(m[1])) {
      for (const t of items) if (scenes.indexOf(t) < 0) scenes.push(t)
    } else {
      for (const t of items) if (names.indexOf(t) < 0) names.push(t)
    }
  }
  const flat = String(adapted || '').replace(/[\s\u3000]/g, '')
  const hit = n => flat.indexOf(n.replace(/[\s\u3000]/g, '')) >= 0
  return {
    checked: names.length + scenes.length > 0,
    names, scenes,
    missing: names.filter(n => !hit(n)),
    missingScenes: scenes.filter(n => !hit(n))
  }
}

// ---------------------------------------------------------------
// 图片提示词发送前的器材词净化（2026-09-27）
//   背景（实测翻车）：器材词（相机 / 单反 / 镜头…）会被图片模型当成**画面内容**
//   画出来；存量老提示词（「单反相机拍摄」）不会随规范重播自动改，所以发送前兜底。
//   词表由 md 承载（scenes.md 兜底默认的「器材词:」行），代码里零提示词文案。
//   只处理「逗号短语串」结构：不是短语串的整句不动（保守，避免误伤）。
// ---------------------------------------------------------------

/** 读器材词表：scenes.md「## 兜底默认」里的 `器材词: a,b,c` 行 → 字符串数组 */
export function equipmentWords(scenesMd) {
  const hit = parseFallbacks(scenesMd).find(o => o.key === '器材词')
  return hit ? hit.tpl.split(/[,，]/).map(s => s.trim()).filter(Boolean) : []
}

/** 剥掉命中器材词的逗号短语（保留原分隔符风格）；无命中原样返回 */
export function stripEquipmentWords(prompt, words) {
  const s = String(prompt || '').trim()
  const ws = (words || []).filter(Boolean)
  if (!s || !ws.length) return s
  if (s.split(/[，,]/).length < 2) return s   // 不是逗号短语串 → 不动
  const sep = s.indexOf('，') >= 0 ? '，' : ','
  const kept = s.split(/[，,]/).filter(p => {
    const t = p.trim()
    return t && !ws.some(w => t.indexOf(w) >= 0)
  })
  return kept.length ? kept.join(sep) : s
}
