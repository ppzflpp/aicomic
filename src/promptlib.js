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
 * 单行档案拆回多行（纯函数，2026-10-12）：
 * profile.md 要求档案「每行一个字段」，但大模型偶尔偷懒，把整份档案写成
 * `字段名：值；字段名：值；…` 的**一整行** → 卡片里挤成一坨没法读（实测 V9X-4 两条档案全是 0 换行）。
 * 这里做一次兜底还原。**只在能确信它是「；分隔的字段串」时才拆**，判据三条：
 *   ① 整段没有任何换行；② 第一段就必须是「短字段名：」（档案首行一定是字段名）；
 *   ③ 至少有 2 段以「短字段名：」开头。
 * 不满足就原样返回 —— 普通叙述文本（用「；」断句的长句）绝不会被误拆。
 * 值内部的「；」并回上一段（例如「外观：A；B」里的 B 不是字段名，不能拆成新行）。
 */
export function unfoldProfileLine(s) {
  const t = String(s == null ? '' : s)
  if (!t || /\n/.test(t)) return t
  if (t.length < 24) return t
  const parts = t.split('；').map(x => x.trim()).filter(Boolean)
  if (parts.length < 2) return t
  // 字段名上限 10 字：「品牌标志与确切文字」是实际出现的最长字段名（9 字）
  const looksField = x => /^[^：:]{1,10}[：:]/.test(x)
  if (!looksField(parts[0])) return t
  if (parts.filter(looksField).length < 2) return t
  const out = []
  for (const p of parts) {
    if (looksField(p) || !out.length) out.push(p)
    else out[out.length - 1] += '；' + p
  }
  return out.join('\n')
}

/**
 * 档案（角色 / 场景 profile）→ 行文本（纯函数，2026-09-22 档案层）：
 * 大模型可能给字符串（多行「字段名：值」），也可能给对象（{姓名:'李白', 身份:'士人'}）
 * 或数组；统一成每行一个字段、全角冒号分隔的文本，方便用户直接在卡片里编辑。
 * 2026-10-12：字符串分支加 unfoldProfileLine 兜底 —— 模型把档案写成一整行时拆回多行。
 */
export function normalizeProfile(v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    return unfoldProfileLine(v.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join('\n'))
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
      '）：请在「🎛 提示词配置中心」的「通用规范」里恢复对应小节，或删掉该文件让它重播内置版')
  }
  return text
}

/**
 * 去掉「不下发小节」（`## 兜底默认` / `## 素材格式` / `## 维护说明`）：
 *  - 兜底默认 / 素材格式：给程序读的（生图兜底模板 / user 消息的编排模板）。
 *  - 维护说明（🆕 2026-10-07）：写给规范维护者自己看的备注（为什么这么改、本项目的特殊约定）。
 *    用户微调规范时把话写在这里，既不污染 system 提示词，也不会被模型当成规则执行。
 * 其余小节照原样保留并保持顺序。
 */
const NON_SEND_SECTIONS = /^(兜底默认|素材格式|维护说明)$/

export function stripProgramSections(md) {
  const out = []
  let skip = false
  for (const ln of String(md || '').split(/\r?\n/)) {
    const h = ln.match(/^##\s*(.+?)\s*$/)
    if (h) skip = NON_SEND_SECTIONS.test(h[1])
    if (!skip) out.push(ln)
  }
  return out.join('\n')
}

/**
 * 按行丢弃（**体裁裁剪**，2026-10-09）：删掉所有**包含任一指定片段**的整行。
 * 用途：某个体裁下，基座规范里有一条规则与本体裁**直接冲突**（例：shots.md「核心规则」
 * 里「每 1000 字改编稿约 8-15 个镜头」是分集短剧的粒度，对广告体裁是反向指令）。
 *
 * 🔴 为什么按行删、不按小节删：冲突的往往只是某小节里的一条，整节删会把同节里仍然有效的
 *    内容一起带走（「核心规则」里还有合并优先、对白带人名这些始终生效的硬规则）。
 * 🔴 为什么不由基座文件自己改：基座是所有体裁**共用**的同一份文件（还带项目副本 + rev 播种），
 *    为 A 体裁删一行必然伤到 B 体裁。所以片段写在**体裁声明**里
 *    （electron/styles/axes/genre/<id>.json 的 `prompt.drop`，键 = 真实文件名）。
 * 片段匹配是**子串匹配**（trim 后非空的项）；没配 drop 的文件原样返回。
 * @param {string} text      规范正文（已去 frontmatter / 程序小节）
 * @param {string[]} needles 行片段
 * @returns {string}
 */
export function dropLines(text, needles) {
  const ns = (Array.isArray(needles) ? needles : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean)
  if (!ns.length) return String(text == null ? '' : text)
  const out = []
  for (const ln of String(text).split(/\r?\n/)) {
    if (ns.some(n => ln.indexOf(n) >= 0)) continue
    out.push(ln)
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

// ---------------------------------------------------------------
// 风格占位符（2026-10-07）
//   规范 md 正文里凡是**题材相关**的短语（定调词 / 收尾词 / 空镜句 / 反风格词表 /
//   世界约束 / 世界观举例…）一律写成 `{{S.变量名}}`，由当前项目的「风格包」
//   （electron/styles/<id>/style.json 的 vars）在**渲染层的内存里**替换。
//   - 用 `S.` 前缀是为了与「## 素材格式」的模板占位符彻底分开：fillTemplate 的键名正则
//     只认 [A-Za-z0-9_]+，匹配不到带点的键 → 两边永远不会互相误伤。
//   - 取不到的键**原样保留**（不换成空串）：让裸占位符显式暴露，composeSystem 会当场报错，
//     而不是静默把某处规范变成空白（静默失败比报错危险得多）。
// ---------------------------------------------------------------
const STYLE_VAR_RE = /\{\{\s*S\.([A-Za-z0-9_]+)\s*\}\}/g

/** 规范正文里用到的风格变量键（去重，按出现顺序）—— style-check 用它验「风格包变量是否齐全」 */
export function styleKeys(md) {
  const out = []
  for (const m of String(md || '').matchAll(STYLE_VAR_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 用风格包的变量表替换 `{{S.x}}`；取不到的键原样保留 */
export function applyStyle(md, vars) {
  const v = vars || {}
  return String(md || '').replace(STYLE_VAR_RE, (whole, k) =>
    (v[k] == null || String(v[k]) === '') ? whole : String(v[k]))
}

/* ------------------------------------------------------------------ *
 * 素材字符规范化（2026-10-08）
 *
 * 事故：V9X-2 的改编稿里写「车尾右侧有“V9X"镀铬字样」—— **全角开引号 + 半角闭引号**（改编
 * 环节自己打错的）。模型把这段逐字抄进角色档案的 profile，而那份输出最终以 JSON 承载
 * （llama.cpp 在 json_object 模式下用 JSON 语法强约束解码）—— **半角双引号就是 JSON 的
 * 字符串结束符**，值在引号处提前闭合、档案齐根断掉，剩下的行被当成数组里的裸字符串吐完。
 * 输出**仍然是合法 JSON**，解析不报错 → 4 条碎片被当成角色名收下，一路绿灯进档案。
 *
 * ⇒ 与其在解析端猜哪条是垃圾，不如在**发送端**断掉污染源：素材里的半角引号统一换成中文
 *   全角引号，模型就没有半角引号可抄。同源项目 V9X 恰好没坏（那轮模型自己改写成了「」），
 *   说明坏不坏原本取决于模型当轮是否逐字照抄 —— 这正是最该被消掉的不确定性。
 *
 * 🔴 只作用于**素材变量**（composeUser 的 vars），绝不碰规范正文：
 *    规范 md 里满是 JSON 输出契约示例（`"shots"`、`"name"`… 全是半角引号），
 *    统一替换会把契约本身改坏，模型反而不知道要输出 JSON。
 * ------------------------------------------------------------------ */

/** 半角引号 → 中文全角引号（双引号按开/闭配对，单引号统一右弯） */
export function normalizeQuotes(s) {
  const t = String(s == null ? '' : s)
  let out = ''
  let open = true
  // 已出现但还没闭合的全角引号（`“` `「` `『`）→ 它们各自该配的闭引号
  const stack = []
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '"') {
      // 前面还留着一个没闭合的全角开引号 → 这个半角引号就是它的闭引号（“V9X" → “V9X”）
      if (stack.length) { out += stack.pop(); continue }
      out += open ? '“' : '”'
      open = !open
      continue
    }
    if (ch === '“' || ch === '「' || ch === '『') stack.push(ch === '“' ? '”' : (ch === '「' ? '」' : '』'))
    else if (ch === '”' || ch === '」' || ch === '』') stack.pop()
    out += ch === "'" ? '’' : ch
  }
  return out
}

/**
 * 素材字符规范化的**收口版本**（2026-10-08）——带 JSON 感知。
 *
 * 为什么要分两路：有 3 个调用点把**镜头 JSON** 当素材传下去
 * （split.md 的 `shot` / `parts`、视频提示词的 `shot`，都是 `JSON.stringify(s, null, 2)`）。
 * 那种文本里的每个 `"` 都是**结构引号** —— 整篇 normalizeQuotes 会把一份 JSON 变成
 * `“scene”: “花海公路·外”`，模型拿到的素材直接变形。所以：
 *  - JSON 文本 → 解析出来，**只规范字符串值内部**，再序列化回去（结构引号一律不动）
 *  - 其它文本 → 整篇规范
 *  - 本来就不含半角引号的（绝大多数素材）→ 直接原样返回，不解析、不重排
 *
 * 🔴 注意 JSON 这一路并不是「多余」：`JSON.stringify` 虽已把值内引号转义成 `\"`，
 *    但模型看到引号仍可能照抄成裸引号，而裸引号在 json_object 强约束下只能靠「提前闭合字符串」
 *    消化 —— 那正是本事故的形态。规范成全角引号才算真的没有引号可抄。
 */
export function normalizeQuotesDeep(s) {
  const t = String(s == null ? '' : s)
  if (!/["']/.test(t)) return t                       // 没有半角引号 → 原样返回（零开销、零重排）
  const head = t.trim().charAt(0)
  if (head === '{' || head === '[') {
    try { return JSON.stringify(walkQuotes(JSON.parse(t)), null, 2) } catch (_) { /* 不是合法 JSON → 走整篇 */ }
  }
  return normalizeQuotes(t)
}
/** 深度遍历：只规范化字符串**值**，数组 / 对象的结构与顺序一律保持 */
function walkQuotes(x) {
  if (Array.isArray(x)) return x.map(walkQuotes)
  if (x && typeof x === 'object') {
    const o = {}
    for (const k of Object.keys(x)) o[k] = walkQuotes(x[k])
    return o
  }
  return typeof x === 'string' ? normalizeQuotes(x) : x
}

/**
 * 模型返回的档案数组**形状校验**（2026-10-08，与上面的 normalizeQuotes 同一事故的两端）。
 *
 * JSON 语法合法 ≠ 结构没坏：素材里的半角引号会让值提前闭合，后半段变成数组里的**裸字符串碎片**
 * （V9X-2 的 characters 里混着 4 条 —— 被截断那段的残骸 + 整段生图提示词），而输出仍是合法 JSON。
 * 旧代码的 normArchive 有一句宽容分支 `typeof raw === 'string' → { name: raw }`，于是每条碎片都被
 * 当成一个角色名收下，垃圾一路绿灯进档案。
 *
 * 这不是「模型只给了名字」的合法简写 —— chars.md / scenes.md 的输出契约是**对象数组**，名字还
 * 必须「用中文、不含空格与标点」。所以按契约判形状，不通过就抛错（调用点应在落盘**之前**调用，
 * 这样旧数据一点不受影响）：
 *  - 条目必须是对象（裸字符串 = 契约已被击穿）
 *  - 名字不得超长、不得含换行 / 全角冒号 / 半角引号（合法名字里绝不会有这些）
 *
 * 🔴 名字里**允许**空格、字母数字、`-`、`·`、`（）`：产品名「魏牌 V9X」、形态名「李白-少年」、
 *    场景名「花海公路·外」都合法；而「李白（主角）」这种带定位标签的名字是 charAlign 的
 *    既有降级路径（剥标签后向卡名对齐），不能在这里把它判死。
 *
 * @param {Array} raw 模型原始返回（**归一化之前**的数组）
 * @param {string} label 报错里的人类可读名（如「角色档案」）
 */
const AUDIT_NAME_MAX = 20
const AUDIT_NAME_BAD_RE = /[\r\n："]/
export function auditModelArchive(raw, label) {
  const list = Array.isArray(raw) ? raw : []
  if (!list.length) return
  const frag = []
  const bad = []
  for (const it of list) {
    if (typeof it === 'string') { const s = it.trim(); if (s) frag.push(s); continue }
    if (!it || typeof it !== 'object' || Array.isArray(it)) { bad.push('(不是对象)'); continue }
    const nm = String(it.name || it.title || '').trim()
    if (!nm) { bad.push('(名字为空)'); continue }
    if (nm.length > AUDIT_NAME_MAX || AUDIT_NAME_BAD_RE.test(nm)) bad.push(nm)
  }
  if (!frag.length && !bad.length) return
  const show = s => (s.length > 36 ? s.slice(0, 36) + '…' : s)
  throw new Error('模型返回的' + (label || '档案') + '结构损坏，本次结果已放弃（还没写入档案，旧数据不受影响）：' +
    (bad.length ? bad.length + ' 条名字不合法（' + bad.slice(0, 3).map(show).join(' / ') + '）；' : '') +
    (frag.length ? frag.length + ' 条不是档案对象而是裸字符串碎片（' + frag.slice(0, 2).map(show).join(' / ') + '…）' : '') +
    '。最常见的原因是改编稿里混进了**半角引号**（"）—— 它会让你返回的 JSON 提前闭合；' +
    '请检查改编稿里的引号是不是都写成了全角「」/“”，改完重新生成即可。')
}

/** 剥掉句尾的英文括注（存量改编稿曾把画外音英文说明带进台词行，2026-09-27）：
 *  只剥括号内含英文字母的**句尾**括注——中文标注（独白）不受影响。durNeed 同源使用 */
export function stripTailEnNote(text) {
  return String(text || '')
    .replace(/\s*[（(][^（）()]*[A-Za-z][^（）()]*[)）]\s*$/, '')
    .trim()
}

// ---------------------------------------------------------------
// 时长模型（台词 ÷ 语速 + 停顿）——全项目单一事实源
//   🔴 durNeed / durFit / durWarnings / durTag / splitShot 全部由下面四个常量派生：
//      改语速、改单镜上限，只改这里；任何地方再写一遍 4.5 或 15 都是 bug 源。
// ---------------------------------------------------------------
/** H3 单镜生成上限（秒），与 resutil.clampDur 的上限一致 */
const DUR_MAX = 15
/** 台词语速（字/秒） */
const CPS = 4.5
/** 每镜起止停顿（秒） */
const PAUSE = 1
/** 复合运镜的时长下限（秒）：两段运镜挤进 1 秒是废镜 */
const COMPOUND_MIN = 6
/**
 * 舒适单镜时长（秒）：容量规划的目标值 —— 让镜头落在 12s 上下，
 * 而不是贴着 DUR_MAX(15s) 硬顶。低于它 = 镜头数够用；逼近/贴住它 = 在硬撑。
 * 与 DUR_MAX 之差（3s）就是「给内容留的呼吸量」。
 */
const DUR_COMFORT = 12
/** 单行台词的字数硬上限：超过它一行就占满整镜，必须切开（由 DUR_MAX 与 CPS 派生 = 63 字） */
const LINE_CHAR_MAX = Math.floor((DUR_MAX - PAUSE) * CPS)

/**
 * 单行台词的正文字数：跳过「说话人名：」前缀、剥句尾英文括注，汉字每字记 1、连续英数串记 1。
 * 🔴 必须与 durNeed 同口径 —— 拆镜的台词分组和时长计算共用这一把尺子，
 *    否则「按字数分好组」之后每一段还会超限（尺子不同 = 白分）。
 */
function lineWeight(line) {
  const t = String(line || '').trim()
  if (!t) return 0
  const body = stripTailEnNote(t.indexOf('：') >= 0 ? t.slice(t.indexOf('：') + 1) : t)
  return (body.match(/[\u4e00-\u9fa5]/g) || []).length + (body.match(/[A-Za-z0-9]+/g) || []).length
}

/** 整段台词的正文总字数（逐行累加 lineWeight） */
function dialogueWeight(text) {
  let chars = 0
  for (const ln of String(text || '').split(/\r?\n/)) chars += lineWeight(ln)
  return chars
}

/**
 * 内部共用：算单个镜头「内容所需时长」的三要素（durWarnings / durSuggest 同源，保证提示与建议永不打架）：
 *   chars/need —— 台词正文字数与所需秒数（÷4.5 + 停顿 1s，向上取整）
 *   sounds     —— 发声表演段数（每段 +2s 已计入 need）
 *   compound   —— 复合运镜（≥2 个运镜动词，或「随后/然后/再」衔接）
 */
function durNeed(o) {
  const dur = Math.round(Number(o.dur) || 0)
  const chars = dialogueWeight(o.dialogue)
  // 发声表演段数（大笑、痛哭这类有明确声源的发声，只写画面动词=无声）
  const act = String(o.action || '')
  const sounds = (act.match(/大笑|狂笑|痛哭|哭喊|嚎啕|惊呼|尖叫|喘息|抽泣|呜咽|长叹/g) || []).length
  let need = 0
  if (chars > 0) need += Math.ceil(chars / CPS) + PAUSE
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

  const why = []
  if (n.chars > 0) why.push('台词约 ' + n.chars + ' 字')
  if (n.sounds > 0) why.push(n.sounds + ' 段发声表演')
  if (n.need > DUR_MAX) {
    // 内容本身超过单镜生成上限：把 dur 拉满也念不完（上限是硬顶），只能拆镜头
    out.push(why.join(' + ') + ' ≈ 需 ' + n.need + 's，超过单镜 ' + DUR_MAX + 's 上限，建议拆成两个镜头')
  } else if (n.need > 0 && n.dur < n.need) {
    out.push(why.join(' + ') + ' ≈ 至少需 ' + n.need + 's（当前 ' + n.dur + 's），声音会被截')
  }

  // 复合运镜：≥2 个不同运镜动词，或用「随后/然后/再」衔接两段运镜
  if (n.compound && n.dur < COMPOUND_MIN) {
    const cam = String(s.camera || '')
    out.push('复合运镜（' + cam.slice(0, 20) + (cam.length > 20 ? '…' : '') + '）建议 ≥' + COMPOUND_MIN + 's（当前 ' + n.dur + 's）')
  }
  return out
}

/**
 * 内容所需的镜头时长（整数秒，**不看 dur 字段本身**）：台词/发声所需秒数与复合运镜下限 6s 取大者，
 * 上限封到 15s（H3 单镜生成上限；真超了就该拆镜头，不是把 dur 拉长——本来也拉不动）。
 * 返回 0 = 内容对时长无约束（无台词、无发声、非复合运镜），调用方应保留原值。
 *
 * 生成分镜时程序直接用它写 dur：让模型逐字数数做除法已被实测否定——
 * shots.md 里写着与程序完全相同的自检公式、还带「18 ÷ 4.5 + 1 = 5 秒」的算例，
 * 10 个样本里模型一次都没执行过（它只按「一个镜头 5~8 秒好看」的节奏瞎填）。
 * 算术交给程序，模型只负责内容。
 */
export function durFit(s) {
  const n = durNeed(s || {})
  if (!n.need && !n.compound) return 0
  return Math.min(DUR_MAX, Math.max(n.need, n.compound ? COMPOUND_MIN : 0))
}

/**
 * 建议时长（整数秒）：同 durFit；dur 未填（0）时返回 0（没有可比的基准，不提示）。
 * 供分镜行黄标直读，与 durWarnings 共用同一套计算。
 */
export function durSuggest(s) {
  const n = durNeed(s || {})
  if (!n.dur) return 0
  return durFit(s)
}

/**
 * 分镜行时长黄标的显示文案（'' = 通过，不挂黄标）：
 *   超单镜上限 → 「⚠ 超单镜上限·建议拆分」（dur 已是 15 硬顶，提示「建议 15s」毫无意义）
 *   时长不足   → 「⚠ 时长紧·建议 Ns」
 * 与 durWarnings 同源，保证 hover 明细与正文案永不打架。
 */
export function durTag(s) {
  if (!durWarnings(s || {}).length) return ''
  const n = durNeed(s || {})
  return n.need > DUR_MAX ? '⚠ 超单镜上限·建议拆分' : '⚠ 时长紧·建议 ' + durFit(s) + 's'
}

// ---------------------------------------------------------------
// 镜头拆分（2026-09-28，第 2 批）
//   背景：H3 单镜生成上限 15s（clampDur 锁死 4~15），而改编稿升级为剧本体后台词
//   密度上升 —— 模型常把 3~4 个对话回合塞进一镜（实测测试项目2 第1集：8 镜里 2 镜
//   真实需要 19~20s）。这不是「时长填小了」，是内容真的装不进一个镜头：dur 拉到
//   15 也念不完。唯一解法是拆开。
//   分工（用户拍板）：程序全权执行拆分、立即出结果，不依赖 LLM；
//   模型只在用户点「AI 重写」时补写被切开那两段的画面（StageShots.rewriteSplit）。
//   程序侧的确定性处理：
//     台词     —— 按行边界分组（行是最小语义单位，绝不切半行）；行数不够段数时按标点
//                  硬切最长的行，并补回「人名：」前缀（说话人绝不能丢）。
//     动作     —— 按标点句边界切（切在标点之后，原文一字不丢），再按各段台词量分配。
//     镜头语言 —— 沿用原值（两段构图雷同 → 黄标提示用户改或让 AI 重写）。
//     连续性   —— 每段都写完整快照（同一镜内状态不变），change 只挂最后一段。
//   拆出来的每段自带 _split 标记（gid / 序号 / 段数 / 原始镜头快照）→
//   「撤回拆分」与「AI 重写」都只凭段自身即可完成，不需要外部状态表。
// ---------------------------------------------------------------

/** 找接近文本中点的切点，优先切在标点之后；返回 0 = 太短不宜切 */
function bestCut(text) {
  const t = String(text || '')
  if (t.length < 6) return 0
  const mid = Math.floor(t.length / 2)
  for (let d = 0; d < t.length; d++) {
    for (const i of [mid - d, mid + d]) {
      if (i > 0 && i < t.length && /[。！？；，、,.!?;]/.test(t[i - 1])) return i
    }
  }
  return mid
}

/**
 * 台词行预处理：把超过单行字数上限（LINE_CHAR_MAX = 63 字）的行切开。
 * 行是最小语义单位，只在「一行就已经占满整镜」时才切；切完必须补回「人名：」前缀
 * —— 说话人一丢，下游 H3 提示词的「对白锁人」随即失效（说话人会漂移）。
 */
function splitLongLines(lines) {
  const out = []
  for (const line of (lines || [])) {
    const queue = [line]
    let guard = 0
    while (guard++ < 20) {
      let bi = -1, bl = 0
      queue.forEach((l, k) => { const w = lineWeight(l); if (w > bl) { bl = w; bi = k } })
      if (bi < 0 || bl <= LINE_CHAR_MAX) break
      const cut = bestCut(queue[bi])
      if (!cut) break
      const m = queue[bi].match(/^([^：:]{1,24}[：:])\s*[\s\S]+$/)
      queue.splice(bi, 1, queue[bi].slice(0, cut).trim(), (m ? m[1] : '') + queue[bi].slice(cut).trim())
    }
    out.push(...queue)
  }
  return out
}

/** 动作描述切成句子（保留标点）；不足 want 句时继续对最长句硬切，保证每段都有画面可写 */
function splitSentences(text, want) {
  const t = String(text || '').trim()
  if (!t) return []
  const arr = t.split(/(?<=[。！？；，,.!?;])/).map(x => x.trim()).filter(Boolean)
  let guard = 0
  while (arr.length < want && guard++ < 20) {
    let bi = -1, bl = 0
    arr.forEach((l, k) => { if (l.length > bl) { bl = l.length; bi = k } })
    if (bi < 0 || bl < 8) break
    const cut = bestCut(arr[bi])
    if (!cut) break
    arr.splice(bi, 1, arr[bi].slice(0, cut).trim(), arr[bi].slice(cut).trim())
  }
  return arr
}

/**
 * 把台词行分成若干组，每组都是「一镜之内念得完」的量（保序、行不切半）。
 * 组容量 cap = min(单行上限, 总字数 / 目标段数 × 1.35)：
 *   前者是硬约束（加进来就念不完 → 必须开新组），后者让分配尽量均匀
 *   （避免「前 5 行挤一组、剩下 1 行一组」）。组数由内容决定，可以多于目标段数。
 */
function groupByLines(lines, n) {
  if (!lines.length) return []
  const ws = lines.map(lineWeight)
  const total = ws.reduce((a, b) => a + b, 0)
  const cap = Math.max(1, Math.min(LINE_CHAR_MAX, (total / Math.max(1, n)) * 1.35))
  const groups = []
  let cur = [], acc = 0
  for (let k = 0; k < lines.length; k++) {
    const w = ws[k] || 1
    const remainItems = lines.length - k
    const remainGroups = Math.max(1, n - groups.length)
    if (cur.length && (acc + w > cap || remainItems < remainGroups)) {
      groups.push(cur); cur = []; acc = 0
    }
    cur.push(lines[k]); acc += w
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** 按权重把条目按比例分到 n 组（总数守恒；前面为空的组向后借一条，保证每组有内容） */
function allocate(items, weights, n) {
  const groups = Array.from({ length: n }, () => [])
  if (!items.length) return groups
  const total = weights.reduce((a, b) => a + (b || 0), 0) || n
  let ptr = 0
  for (let k = 0; k < n; k++) {
    const want = k === n - 1 ? (items.length - ptr) : Math.round(items.length * weights[k] / total)
    const take = Math.max(0, Math.min(want, items.length - ptr))
    groups[k] = items.slice(ptr, ptr + take)
    ptr += take
  }
  if (ptr < items.length) groups[n - 1] = groups[n - 1].concat(items.slice(ptr))
  for (let k = 0; k < n - 1; k++) {
    if (!groups[k].length) {
      for (let j = k + 1; j < n; j++) {
        if (groups[j].length > 1) { groups[k].push(groups[j].shift()); break }
      }
    }
  }
  return groups
}

/**
 * 拆镜（纯函数）：内容超过单镜 15s 上限时，把它拆成 N 个 ≤15s 的镜头（顺序不变、内容不丢字）。
 * @param {object} s   待拆镜头（dur 不采信，只按 dialogue/action/camera 算内容所需）
 * @param {string} gid 组标识（不传则自生成）
 * @returns {Array|null} null = 无需拆分（内容所需 ≤15s）；否则返回长度 ≥2 的镜头序列，每段带 _split
 */
export function splitShot(s, gid) {
  const src = s || {}
  const n = durNeed(src)
  if (!(n.need > DUR_MAX)) return null
  return splitShotParts(src, Math.max(2, Math.ceil(n.need / DUR_MAX)), gid)
}

/**
 * 复合运镜的**段首衔接词**（与 durNeed 的 compound 判据同源：`/随后|然后|，再|、再/`）。
 * 拆镜时把它剥掉 —— 不剥的话「随后切至窗外特写」自己又命中 /随后/，compound 依旧为真，
 * 等于白拆。两处判据必须同进同退。
 */
const CAM_LEAD_RE = /^(?:随后|然后|接着|而后|继之|再|又)\s*/

/**
 * 把一条运镜描述按「顿挫标点」切成若干独立运镜段（纯函数）。
 * 🔴 为什么需要（2026-10-13 挖出，修「真人剧 T=60 → 实际 62 秒」）：
 *    `splitShotParts` 原来把 `camera` **原样复制**到每一份 —— 一条
 *    「中景缓推，随后切至窗外特写」拆成 3 份后，3 份都带「随后」，于是每份的
 *    `durNeed.compound` 全为真 → `durFit` 全部 ≥ COMPOUND_MIN(6) → 拆完的时长**下限**
 *    从 4s 抬到 6s。实测真人剧 T=60 / 14 镜时 Σfloor 已是 62s，补偿循环无余量可减，
 *    `fitDurs` 只能出 62s。
 * @returns {string[]} 至少 1 段（切不出来就返回 [原文]）
 */
function splitCamera(cam) {
  const raw = String(cam || '').trim()
  if (!raw) return []
  const segs = raw.split(/[，,；;]+/).map(x => x.trim().replace(CAM_LEAD_RE, '').trim()).filter(Boolean)
  return segs.length ? segs : [raw]
}

/**
 * 把 n 段运镜按比例摊到 parts 份镜头上（纯函数）：第 k 份取第 [⌊k·n/parts⌋, ⌊(k+1)·n/parts⌋) 段，
 * 空区间补一段（段数少于份数 = 多出来的份沿用同一段，信息不丢），**最后一份兜住剩余段**（一段都不丢）。
 * 🔴 只有 1 段时返回空表 —— 调用方据此保持「原样复制」的老行为逐字不变
 *    （「全景，低机位」这类并列描述、以及「推近后环绕」这种真正拆不开的复合运镜都走这条路）。
 */
function camPerShot(segs, parts) {
  const n = segs.length
  if (n <= 1) return []
  const out = []
  for (let k = 0; k < parts; k++) {
    const a = Math.floor(k * n / parts)
    let b = Math.floor((k + 1) * n / parts)
    if (b <= a) b = Math.min(n, a + 1)
    if (k === parts - 1) b = n
    out.push(segs.slice(a, b).join('，'))
  }
  return out
}

/**
 * 按**指定段数**拆一条镜头（纯函数，2026-10-12）—— splitShot 的底层实现，也是容量规划的入口。
 * 与 splitShot 的唯一区别：段数由调用方给定（容量规划算出来的「这段需要几条镜头」），
 * 而不是由内容（台词/发声）推算。切分机制完全共用：
 *   台词 —— 按行边界分组（行是最小语义单位，绝不切半行）；**台词实在装不下时以台词为准**，
 *           段数可能多于 want（`parts = max(want, 台词组数, 2)`），绝不把两句话塞进同一段。
 *   动作 —— 按标点句边界切，再按各段台词量分配。
 *   镜头语言 —— **复合运镜按段分派**（2026-10-13：原样复制会让每一份都命中 compound，
 *               把拆完的时长下限从 4s 抬到 6s，真人剧 T=60 于是出 62s）；单段运镜原样复制。
 *               连续性 —— 每段写完整快照，change 只挂最后一段。
 * @param {object} s    待拆镜头
 * @param {number} want 期望段数（< 2 时按 2 处理）
 * @param {string} gid  组标识（不传则自生成）
 * @returns {Array} 长度 ≥2 的镜头序列，每段带 _split = {gid, k, n, ai, src}
 */
export function splitShotParts(s, want, gid) {
  const src = s || {}
  const id = gid || ('sp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  const wantN = Math.max(2, Math.round(Number(want) || 2))

  // 台词：取行 → 超长行按单行字数上限切开 → 按「每段念得完」分组；段数由内容定（可能多于 want）
  const raw = String(src.dialogue || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const dlgGroups = groupByLines(splitLongLines(raw), wantN)
  const parts = Math.max(wantN, dlgGroups.length, 2)

  // 动作：切句 → 按各段台词量分配（台词为空 = 纯发声镜头时按句数均分）
  const sents = splitSentences(src.action, parts)
  const wts = Array.from({ length: parts }, (_, k) => (dlgGroups[k] || []).reduce((a, l) => a + lineWeight(l), 0))
  const actGroups = allocate(sents, wts.map(w => w || 1), parts)

  const snap = {
    scene: String(src.scene || ''), chars: String(src.chars || ''),
    action: String(src.action || ''), dialogue: String(src.dialogue || ''),
    camera: String(src.camera || ''), dur: Number(src.dur) || 0,
    continuity: String(src.continuity || ''), change: String(src.change || '')
  }
  if (src._rev) snap._rev = src._rev

  // 复合运镜按段分派（2026-10-13）：只有**真复合**（≥2 个运镜动词，或有随后/然后/再 衔接）才切；
  // 单段运镜与「全景，低机位」这类并列描述一律走老路（camSegs 为空 → 原样复制到每一份）。
  const camSegs = durNeed({ camera: snap.camera }).compound ? camPerShot(splitCamera(snap.camera), parts) : []

  const out = []
  for (let k = 0; k < parts; k++) {
    const seg = {
      scene: snap.scene,
      chars: snap.chars,
      action: (actGroups[k] || []).join(''),
      dialogue: (dlgGroups[k] || []).join('\n'),
      camera: camSegs.length ? camSegs[k] : snap.camera,
      dur: 0
    }
    if (snap.continuity) seg.continuity = snap.continuity
    if (k === parts - 1 && snap.change) seg.change = snap.change
    const fit = durFit(seg)
    seg.dur = Math.min(DUR_MAX, Math.max(4, fit > 0 ? fit : Math.round((snap.dur || 8) / parts)))
    seg._split = { gid: id, k, n: parts, ai: false, src: snap }
    out.push(seg)
  }
  return out
}

/**
 * 批量拆镜（纯函数）：把所有内容超单镜上限的镜头就地替换成拆分段。
 * @returns {{shots: Array, groups: Array<{gid, at, n}>, map: number[][]}}
 *   groups —— 报告「拆了几组、落在哪」；map —— map[旧下标] = 新下标数组（长度 1 = 未拆），
 *   调用方据此按下标重建提示词 / 视频槽位（镜头数变了，后面所有镜头的位置都会前移）。
 */
export function splitAll(shots) {
  const arr = Array.isArray(shots) ? shots : []
  const out = []
  const groups = []
  const map = []
  for (const s of arr) {
    const parts = splitShot(s)
    if (parts) {
      const at = out.length
      groups.push({ gid: parts[0]._split.gid, at, n: parts.length })
      map.push(parts.map((_, k) => at + k))
      for (const p of parts) out.push(p)
    } else {
      map.push([out.length])
      out.push(s)
    }
  }
  return { shots: out, groups, map }
}

/**
 * 拆分段的行内黄标文案（'' = 不是拆分段）：
 *   组头 → 「✂ 程序拆分 1/2 · 画面待重写」；其余段 → 「✂ 程序拆分 2/2」
 * AI 重写成功后同一组统一变「✂ AI 重写 k/n」。
 */
export function splitTag(s) {
  const sp = (s || {})._split
  if (!sp) return ''
  const pos = (sp.k + 1) + '/' + sp.n
  if (sp.ai) return '✂ AI 重写 ' + pos
  return sp.k === 0 ? '✂ 程序拆分 ' + pos + ' · 画面待重写' : '✂ 程序拆分 ' + pos
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
 * 解析一条 change 行（分镜的 `change` 字段，格式「主体·维度：旧值 → 新值（触发动作）」）。
 * 2026-10-16：原来这段正则长在 contWarnings 里，装扮变体也要用同一个格式 → 抽出来共用一份，
 * 免得两处各拿一份副本、以后改了一处另一处悄悄失配。
 * 🔴 主体与维度的切分用**最后一个** `·`：分镜里的场景/主体名自己就含间隔号（「礼堂·内」），
 *    取第一个会把主体名切掉一半（contWarnings 的 R4 原本就取第一个，那里只当软提示用，
 *    这里要吃主体名，必须按末尾切）。
 * @returns {{sub:string, dim:string, from:string, to:string, trig:string}|null} 不是变化行返回 null
 */
export function parseChange(line) {
  const m = String(line || '').trim()
    .match(/^([^：:]+)[：:]\s*(.+?)\s*(?:→|->|—>|变成|变为|改为)\s*(.+?)\s*(?:[（(]([^）)]*)[）)])?$/)
  if (!m) return null
  const head = m[1].trim()
  const at = head.lastIndexOf('·')
  return {
    sub: (at > 0 ? head.slice(0, at) : '').trim(),
    dim: (at > 0 ? head.slice(at + 1) : head).trim(),
    from: m[2].trim(),
    to: m[3].trim(),
    trig: String(m[4] || '').trim()
  }
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
      const p = parseChange(chg)
      if (p) {
        const from = p.from, to = p.to, trig = p.trig
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
        const sub = p.sub
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

/**
 * 全量合并（纯函数，2026-10-09）：从左往右贪心合并所有「可与上一镜合并」的相邻镜头。
 *
 * 为什么需要：`mergeWarnings` 只能黄标，用户得逐镜点开弹窗确认 —— 实测 V9X-4 的 12 镜里
 * 有 8 处可合并，等于要手点 8 次；而「开始整理」只做时长重算 + 拆镜（方向是让镜头变多）。
 * 于是规范里写着「合并优先」，实际落到盘上却是 12 镜（上限 6 镜）。
 *
 * 判据与逐镜黄标**完全同源**（mergeWarnings + mergeShotPair）——「界面标了什么」与
 * 「这个按钮会合掉什么」永远一致，不会出现「标了没合」或「没标却合了」。
 * 合并后按内容重算时长（durFit：台词 / 发声 / 复合运镜所需秒数）；内容对时长没约束时
 * 保留两镜之和（mergeWarnings 已保证合计 ≤ DUR_MAX）。
 *
 * 🔴 拆分段（`_split`）一律不参与合并：mergeShotPair 只搬运契约字段，`_split` 会丢，
 *    合并等于悄悄让「撤回拆分」失效。
 * 🔴 本函数**不写 `_rev`**：`_rev` 是「本行的提示词/视频已过期」的标记，属于调用方的落库语义；
 *    由调用方按返回的 `merged` 列表去打（见 StageShots.mergeShotsAll）。
 * @param {Array} list 镜头数组
 * @returns {{shots: Array, count: number, map: number[][], merged: number[]}}
 *   map[旧下标] = [新下标]（合并时两项映射到同一新下标）；merged = 由合并产生的那些新下标
 */
export function mergeAllShots(list) {
  const arr = Array.isArray(list) ? list : []
  const out = []
  const map = []
  const merged = []
  let count = 0
  for (const s of arr) {
    const cur = s || {}
    const last = out[out.length - 1]
    if (last && !last._split && !cur._split && mergeWarnings([last, cur])[1]) {
      const m = mergeShotPair(last, cur)
      const fit = durFit(m)
      m.dur = Math.min(DUR_MAX, Math.max(4, fit > 0 ? fit : (Number(m.dur) || 0)))
      out[out.length - 1] = m
      map.push([out.length - 1])
      merged.push(out.length - 1)
      count++
      continue
    }
    out.push({ ...cur })
    map.push([out.length - 1])
  }
  return { shots: out, count, map, merged }
}

/**
 * 把镜头时长分布到「脚本各段秒数之和」上（纯函数，2026-10-09）。
 *
 * 为什么需要：合并与 durFit 都只管**单镜**，管不住**全片总长**。单镜 dur 是模型按
 * 「5~8 秒好看」填的节奏值，12 镜 × 4s 的硬下限就有 48 秒；实测 V9X-4 脚本 28 秒、
 * 成片 53 秒（1.9 倍），而规范（shots-ad.md「镜头量」）要求总时长落在脚本各段合计的 ±20%。
 *
 * 规则：
 *   · 下限 = **内容所需**（durFit：台词 / 发声表演 / 复合运镜；没有内容约束时取 4s 硬下限），
 *     上限 15s —— 「台词念得完」永远优先于「凑够总时长」，所以贴回脚本不会把声音挤掉；
 *   · `keep(s, i)` 为真 = 该镜时长**不动**（用户手改过的），它的时长先从目标里扣掉；
 *   · 余量按轮转逐个 +1 平均分配，加满到上限 15s 即止（余量小于镜头数时，靠前的先分到）。
 * 目标为 0（改编稿没写段落时长 —— 剧集体裁就是）→ 原样返回，一个字节都不动。
 * @param {Array} list     镜头数组
 * @param {number} totalSec 脚本各段秒数之和
 * @param {Function} [keep] keep(s, i) → true 表示这一镜的时长不参与重算
 * @returns {{shots: Array, changed: number, total: number}}
 */
export function fitDurs(list, totalSec, keep) {
  const arr = (Array.isArray(list) ? list : []).map(s => ({ ...(s || {}) }))
  const t = Math.round(Number(totalSec) || 0)
  const sum = (a) => a.reduce((x, s) => x + (Number(s.dur) || 0), 0)
  if (!arr.length || !t) return { shots: arr, changed: 0, total: sum(arr) }
  const isKeep = typeof keep === 'function' ? keep : () => false
  const cl = (v) => Math.min(DUR_MAX, Math.max(4, v))
  const floor = arr.map((s, i) => {
    if (isKeep(s, i)) return cl(Number(s.dur) || 4)
    const need = durFit(s)
    return cl(need > 0 ? need : 4)
  })
  const out = arr.map((s, i) => ({ ...s, dur: floor[i] }))
  const free = arr.map((s, i) => i).filter(i => !isKeep(arr[i], i))
  let rest = t - sum(out)
  let guard = 0
  while (rest > 0 && guard++ < 4000) {
    let bumped = 0
    for (const i of free) {
      if (rest <= 0) break
      if (out[i].dur >= DUR_MAX) continue
      out[i].dur++
      rest--
      bumped++
    }
    if (!bumped) break     // 自由镜头全部顶到 15s，余量无处可放
  }
  const changed = out.reduce((a, s, i) => a + (s.dur !== (Number(arr[i].dur) || 0) ? 1 : 0), 0)
  return { shots: out, changed, total: sum(out) }
}

// ---------------------------------------------------------------
// 时长容量（2026-10-12）：把「脚本要求的时长 T」与「镜头数能装下的时长」对账
//   为什么要有这一层：`fitDurs` 只能把 T 摊到**已有**镜头上，装不下时它的补偿循环
//   （上面那句「自由镜头全部顶到 15s，余量无处可放」）会**静默丢弃**余量 —— 全片就短了。
//   而此前三条校验都对它放行：durWarnings 只看「内容需要 > dur」（无台词长运镜永不告警）、
//   shotCheck 的镜头数与总时长各自套着宽松阈值（V9X-4 实测 6 镜 × 15s = 90s vs 脚本 105s，
//   偏差 14.3% < durTol 20% → 一声不响，用户只能靠肉眼数出「全是 15s」）。
//
//   本层判据是**纯算术**：(镜头数, 脚本总秒数, 各段声明秒数) 的属性，与模型写了什么无关 ——
//   所以给 0 容忍、不走 durTol，并且**只认「时长：」已声明的体裁**（剧集没有声明 → 整层跳过）。
//
//   三种「装不下」的形状里只有前两种是**容量**问题（第三种「单个镜头内容超 15s」由
//   durWarnings 逐镜黄标 + splitAll 自动拆分负责，不在这里重复判）：
//     ① 全片装不下        N × 15 < T                      → capacity-short（会丢秒）
//     ② 分布装不下        段落 20s 却只分到 1 条（容量 15s）→ capacity-seg（总时长对，但逐段不齐）
//   再看脚本自身是否对本体裁不自洽：逐段对齐需 Σmax(1,⌈秒/15⌉) 镜 > 体裁上限 → capacity-script（回上游）
//   🔴 ②是此前**完全没有**的（「逐段对齐」只写在 shots-ad.md 里、程序零校验）——
//      7 镜 × 15s = 105s 那种「总时长一分不差、单镜全贴硬顶」全靠它才抓得住。
// ---------------------------------------------------------------

/**
 * 容量对账（纯函数）。
 * @returns {{totalSec, units, segSecs, shots, capN, needN, comfortN, targetN, capacity,
 *            floorSum, deficit, aligned, cur, needSeg, needTotal, segShort, issues}}
 *   totalSec  脚本总秒数 T（各段「时长：」之和；无声明 = 0 → 调用方整层跳过）
 *   units     段落数；segSecs 各段声明秒数（按出现顺序）
 *   shots     镜头数 N；capN 体裁允许的镜头数上限 ceil(段落数 × shotsPerUnit)（没声明 = 0 = 不判）
 *   needN     全局：装得下 T 所需的**最少**镜头数 ceil(T / 15)
 *   comfortN  全局：不贴硬顶所需的镜头数 ceil(T / 12)
 *   targetN   建议补到的镜头数 min(capN, max(N, needTotal 或 comfortN))
 *   capacity  现有镜头数的时长容量 N × 15
 *   floorSum  内容硬下限之和 Σ durFit（台词 / 发声 / 复合运镜；每镜已封顶 15，供参考）
 *   deficit   全局结构性短缺 T − capacity（> 0 = 必然丢秒）
 *   aligned   段落秒数可用（segSecs 条数与段落数一致）→ 才做「逐段对齐」判定
 *   cur       各段落当前拥有的镜头数（按镜头顺序分派）；needSeg 各段落**需要**的镜头数 max(1, ceil(秒/15))
 *   needTotal Σ needSeg（逐段对齐所需的镜头数）；segShort 对不齐的段落 [{at, sec, got, need}]
 *   issues    kind ∈ capacity-script | capacity-short | capacity-seg
 */
export function shotCapacity({ shots = [], adapted = '', limits = {} } = {}) {
  const list = Array.isArray(shots) ? shots : []
  const u = storyUnits(adapted)
  const perUnit = Number(limits && limits.shotsPerUnit) || 0
  const T = u.hasSec ? u.totalSec : 0
  const N = list.length
  const capN = (u.count && perUnit) ? Math.ceil(u.count * perUnit) : 0
  const needN = T ? Math.ceil(T / DUR_MAX) : 0
  const comfortN = T ? Math.ceil(T / DUR_COMFORT) : 0
  const capacity = N * DUR_MAX
  const floorSum = list.reduce((a, s) => a + (durFit(s) || 0), 0)
  const deficit = T ? Math.max(0, T - capacity) : 0
  // 逐段对齐（「每一镜的 dur 要贴近它所在段落的声明秒数」——此前只写在 shots-ad.md 里，程序零校验）
  const aligned = !!(u.count > 0 && (u.segSecs || []).length === u.count)
  const needSeg = aligned ? u.segSecs.map(s => Math.max(1, Math.ceil(s / DUR_MAX))) : []
  const needTotal = needSeg.reduce((a, b) => a + b, 0)
  const cur = (aligned && N >= u.count) ? groupBySegments(N, u.segSecs, T) : []
  const segShort = (cur.length === u.count)
    ? needSeg.map((k, i) => ({ at: i + 1, sec: u.segSecs[i], got: cur[i], need: k })).filter(x => x.got < x.need)
    : []
  const targetN = capN ? Math.min(capN, Math.max(N, aligned ? needTotal : comfortN)) : 0

  const issues = []
  const reqN = aligned ? needTotal : needN
  if (T && capN && reqN > capN) {
    // 脚本分布对本体裁的容量假设不自洽：拆到上限也装不下 —— 只能回上游（拆段落 / 减时长），程序不瞎拆
    issues.push({
      kind: 'capacity-script',
      text: '脚本 ' + T + 's 对本体裁超容：' + (aligned
        ? '按逐段对齐需要 ' + needTotal + ' 镜（各段 max(1, ⌈秒数/' + DUR_MAX + '⌉) 之和）'
        : '至少要 ' + needN + ' 镜') +
        '，而本体裁上限只有 ' + capN + ' 镜（' + u.count + ' 段落 × ' + perUnit + '）。' +
        '请回改编稿把段落拆细 —— 每段声明 ≤' + DUR_MAX + 's 时一段一镜即自洽；或者删减总时长'
    })
  } else if (deficit > 0) {
    issues.push({
      kind: 'capacity-short',
      text: N + ' 镜装不下脚本 ' + T + 's（' + N + '×' + DUR_MAX + 's=' + capacity + 's）—— 会全员顶到 ' +
        DUR_MAX + 's 硬顶、丢掉 ' + deficit + 's。建议补到 ' + targetN + ' 镜（' + needN +
        ' 镜是硬下限，' + comfortN + ' 镜可让单镜落在 ' + DUR_COMFORT + 's 上下）'
    })
  } else if (segShort.length) {
    issues.push({
      kind: 'capacity-seg',
      text: '逐段对不齐：第 ' + segShort.slice(0, 4).map(x => x.at).join('、') +
        (segShort.length > 4 ? ' 等 ' : ' ') + '段落声明 ' +
        segShort.slice(0, 4).map(x => x.sec + 's').join('/') +
        '，却只有 ' + segShort.slice(0, 4).map(x => x.got + ' 个镜头').join('/') +
        '（容量 ' + segShort.slice(0, 4).map(x => x.got * DUR_MAX + 's').join('/') +
        '）—— 总时长对得上，但这几段的内容被压进更少的镜头里。建议补到 ' + targetN + ' 镜'
    })
  }
  return { totalSec: T, units: u.count, segSecs: u.segSecs || [], shots: N, capN, needN, comfortN,
           targetN, capacity, floorSum, deficit, aligned, cur, needSeg, needTotal, segShort, issues }
}

/**
 * 把 N 条镜头按**出现顺序**分给 units 个段落（按各段声明秒数占比，最大余数法对齐）。
 * 生成期「段落顺序 = 镜头顺序」，所以顺序分组是可靠的分派依据。
 * 保证每段至少 1 条、总和恰为 N（N < units 时返回全 1，调用方据此放弃）。
 */
function groupBySegments(N, seg, total) {
  const units = seg.length
  const out = new Array(units).fill(1)
  const rest = N - units
  if (rest <= 0) return out
  const T = total || seg.reduce((a, b) => a + b, 0) || 1
  const raw = seg.map(s => (rest * s) / T)
  const frac = []
  for (let i = 0; i < units; i++) { const f = Math.floor(raw[i]); out[i] += f; frac.push({ i, f: raw[i] - f }) }
  let used = out.reduce((a, b) => a + b, 0)
  frac.sort((a, b) => (b.f - a.f) || (a.i - b.i))
  for (let k = 0; k < frac.length && used < N; k++) { out[frac[k].i]++; used++ }
  return out
}

/**
 * 配镜补齐（纯函数，2026-10-12 建；2026-10-13 加双轨配时路径）：
 * 把「镜头数 N」变成**由时长反推**的变量 —— 这是 `fitDurs` 丢时长 / 拍太短的**根治**。
 *
 * 两条路径（**互斥**，看改编稿有没有「时长：」行）：
 *   ① 逐段秒数路径（广告）：一段声明 20s 就至少要 ceil(20/15)=2 条 —— 按**段落秒数**补。
 *   ② 双轨配时路径（剧集，2026-10-13）：改编稿没有秒数（`adapt.md` 禁止它写秒数），
 *      改由**目标时长 T** 与**画面单元数 B** 推 `N*`（见 pacingPlan）——
 *      需体裁声明 `limits.pacing` **且**调用方给了 `targetSec`，否则整层惰性、一个字节不动。
 *
 * 与 splitAll 的分工（两者互补，生成期都要跑）：
 *   splitAll     治「**单个**镜头内容太多」（台词 / 发声 > 15s）：按台词边界拆。
 *   fitShotCount 治「**全片 / 单段**装不下」（N × 15 < T，或某段拿到的镜头数装不下它该有的量）：按段补。
 *
 * 本函数只定**条数**，具体每条的秒数交给随后跑的 fitDurs 贴回（分工不重叠）。
 * 🔴 一个段落已有 k 条时，只把其中**最长的那条**（最可能是在硬撑的）拆成 (want−k+1) 段。
 * 🔴 只做加法、**永不合并**（合并是减法，拿「装不下」触发合并只会雪上加霜）。
 *
 * @param {Array} shots 现有镜头
 * @param {string} adapted 改编稿
 * @param {object} limits 体裁声明的 limits
 * @param {number} [targetSec] 本集目标时长（秒）；只在双轨配时路径用
 * @returns {{shots, groups, map, added, reason, totalSec}}
 *   groups / map 语义与 splitAll **完全一致**（map[旧下标] = 新下标数组），调用方按同一套逻辑重建槽位。
 *   reason: '' 未动 | 'capacity' 按段落秒数补镜 | 'pacing' 按目标时长补镜 | 'paced' 双轨配时下已达标
 *           | 'script' 脚本超体裁容量（回上游）| 'nolimit' 体裁没声明上限
 *           | 'align' 段落秒数 / 单元数拿不到 | 'aligned' 算下来无需新增
 */
export function fitShotCount(shots, adapted, limits, targetSec) {
  const arr = Array.isArray(shots) ? shots : []
  const noop = { shots: arr, groups: [], map: arr.map((_, i) => [i]), added: 0, reason: '' }
  const cap = shotCapacity({ shots: arr, adapted, limits })

  // ① 双轨配时路径：改编稿**没有**逐段秒数（剧集）时才走；有秒数（广告）永远走下面那条老路
  if (!cap.totalSec) {
    const plan = pacingPlan({ adapted, shots: arr, targetSec, limits })
    if (plan.ok && plan.units === cap.units) {
      if (arr.length < plan.units) return { ...noop, reason: 'align', totalSec: plan.T }
      if (arr.length < plan.Nstar) {
        const cur = groupBySegments(arr.length, plan.per, plan.B)
        const want = groupBySegments(plan.Nstar, plan.per, plan.B)
        const g = growBySegments(arr, cur, want)
        if (g.groups.length) {
          return { shots: g.out, groups: g.groups, map: g.map, added: g.out.length - arr.length,
                   reason: 'pacing', totalSec: plan.T }
        }
      }
      return { ...noop, reason: 'paced', totalSec: plan.T }
    }
    return noop                                     // 没声明 pacing / 没目标时长 → 与从前完全一致
  }

  // ② 逐段秒数路径（广告）
  if (!cap.capN) return { ...noop, reason: 'nolimit' }             // 体裁没声明镜头量上限 → 不猜
  if (!cap.aligned) return { ...noop, reason: 'align' }            // 段落秒数拿不到 → 不猜分组
  const units = cap.units
  if (arr.length < units) return { ...noop, reason: 'align' }      // 镜头比段落还少 → 是漏镜，不是容量问题
  if (cap.needTotal > cap.capN) return { ...noop, reason: 'script' } // 拆到上限也装不下 → 回上游

  const seg = cap.segSecs.slice()
  const need = cap.needSeg.slice()
  const comfort = seg.map(s => Math.max(1, Math.ceil(s / DUR_COMFORT)))
  const sum = a => a.reduce((x, y) => x + y, 0)
  // 目标条数：优先「舒适」（单镜 ~12s，尽量不贴硬顶），受体裁上限约束；退而求其次「够装」
  let want
  if (sum(comfort) <= cap.capN) want = comfort
  else if (sum(need) <= cap.capN) want = need
  else return { ...noop, reason: 'script' }

  const g = growBySegments(arr, cap.cur, want)
  if (!g.groups.length) return { ...noop, reason: 'aligned', totalSec: cap.totalSec }
  return { shots: g.out, groups: g.groups, map: g.map, added: g.out.length - arr.length,
           reason: 'capacity', totalSec: cap.totalSec }
}

/**
 * 按「每段目标条数」把各段**最长**的一条拆开（fitShotCount 两条路径共用，避免两处逻辑漂移）。
 * 一个段落已有 k 条时只拆最长的那条，拆成 (want−k+1) 段 —— 顶格的那条最可能是在硬撑。
 * @returns {{out, groups, map}} 语义与 splitAll 一致：map[旧下标] = 新下标数组
 */
function growBySegments(arr, cur, want) {
  const out = [], groups = [], map = []
  let si = 0
  for (let i = 0; i < cur.length; i++) {
    const k = cur[i]
    const owned = arr.slice(si, si + k)
    si += k
    const grow = (want[i] > owned.length) ? (want[i] - owned.length + 1) : 0
    if (grow >= 2) {
      let bi = 0
      for (let j = 1; j < owned.length; j++) {
        if ((Number(owned[j].dur) || 0) > (Number(owned[bi].dur) || 0)) bi = j
      }
      for (let j = 0; j < owned.length; j++) {
        if (j === bi) {
          const parts = splitShotParts(owned[j], grow)
          const at = out.length
          groups.push({ gid: parts[0]._split.gid, at, n: parts.length, seg: i + 1 })
          map.push(parts.map((_, kk) => at + kk))
          for (const p of parts) out.push(p)
        } else {
          map.push([out.length]); out.push(owned[j])
        }
      }
    } else {
      for (const s of owned) { map.push([out.length]); out.push(s) }
    }
  }
  return { out, groups, map }
}

/**
 * 改编稿的「叙事单元」结构（纯函数，2026-10-09；分镜自检用）。
 *   广告体裁的改编稿写成 `段落 N：地点·内外` + `时长：N 秒`；
 *   剧集体裁写成 `场次 N：地点·内外`（没有时长行）。
 * 数出：单元数 / 单元名 / 各单元秒数之和（没有时长行 → totalSec=0、hasSec=false，调用方据此跳过时长校验）。
 * 🔴 只认**行首**的 `段落 N：` / `场次 N：`（可带前置空白）；正文里叙述性的「第二段落」不算单元。
 * @returns {{count: number, heads: Array<{n:number,name:string}>, segSecs: number[], totalSec: number, hasSec: boolean}}
 *   segSecs —— 各段落声明的秒数（**按出现顺序**，容量规划按它逐段配镜；条数与 count 不一致时调用方自行降级）
 */
export function storyUnits(md) {
  const heads = []
  const segSecs = []
  let totalSec = 0, hasSec = false
  for (const raw of String(md == null ? '' : md).split(/\r?\n/)) {
    const ln = raw.trim()
    let m = ln.match(/^(?:段落|场次)\s*(\d+)\s*[：:]\s*(.+)$/)
    if (m) { heads.push({ n: Number(m[1]), name: m[2].trim() }); continue }
    m = ln.match(/^(?:时长|本段时长|段落时长)\s*[：:]\s*(\d+(?:\.\d+)?)\s*秒/)
    if (m) { const v = Number(m[1]); segSecs.push(v); totalSec += v; hasSec = true }
  }
  return { count: heads.length, heads, segSecs, totalSec: hasSec ? Math.round(totalSec) : 0, hasSec }
}

// ---------------------------------------------------------------
// 双轨配时（2026-10-13）：镜数 N 由「目标时长 T」与「画面单元数 B」两个物理量推导
//   背景：镜数此前由**字数**推（shots.md「每 1000 字 8-15 镜」）→ 两个反向事故都躲不掉：
//     · 装不下   —— V9X-4：6 镜 × 15s = 90 < 105，静默丢 15s（已由容量闭环修）
//     · 没人说要装 —— 真人剧：5 镜 × 均 4.8s = 24s，而目标是 60s
//   第二根轨就是「目标时长」：R = T ÷ B（秒/单元）**与 N 无关** ⇒ 生成分镜**之前**就能判定
//   「这份文案能不能舒服地撑到目标时长」。
//   🔴 整层由体裁声明 `limits.pacing` 门控：不声明 = 一行都不判（广告继续走老路）。
//   🔴 `beatUnit` 与 `secPerBeat` **没有全局默认值** —— 广告改编稿是「一整段画面描述」，
//      逐行数 ≈ 1 → R ≈ 25 秒/单元 → 会直接误报「素材太稀」；两体裁根本不是一个数，
//      所以必须由体裁自己声明，不声明就整层惰性，绝不猜。
// ---------------------------------------------------------------

/** 取 [lo, hi] 数值对，非法值回落 dft（pacing 的参数都按对数声明） */
function pair2(v, dft) {
  const a = Array.isArray(v) ? v : []
  const lo = Number(a[0]), hi = Number(a[1])
  return [Number.isFinite(lo) ? lo : dft[0], Number.isFinite(hi) ? hi : dft[1]]
}

/**
 * 画面单元计数（纯函数）。一个「画面单元」= 一次换空间 / 换机位 / 换情绪节拍。
 * 改编稿的**行结构本身就是它**：单元头（`场次 N：地点` / `段落 N：地点`）之下一行一个单元。
 *   · 只数单元头**之后**的内容行；`时段：`/`出场人物：`/`时长：` 这类元信息行不算；
 *   · 遇到下一个顶层小节（`五、…`）即停止 —— 免得把「节奏与情绪备注」数进来；
 *   · 单元头之前的正文（梗概 / 角色设定 / 场景设定）一律不算。
 * @param {string} md 改编稿
 * @param {{beatUnit?: 'line'|'sentence'}} opts 由体裁声明；缺省/非法 → ok:false（整层惰性）
 * @returns {{ok, reason, beatUnit, B, units, per}}
 */
export function episodeBeats(md, opts = {}) {
  const beatUnit = String((opts && opts.beatUnit) || '').trim()
  if (beatUnit !== 'line' && beatUnit !== 'sentence') {
    return { ok: false, reason: 'nobeatunit', beatUnit, B: 0, units: 0, per: [] }
  }
  const isTop = ln => /^[一二三四五六七八九十]+[、.]/.test(ln)
  const isHead = ln => /^(?:段落|场次)\s*\d+\s*[：:]/.test(ln)
  const isMeta = ln => /^(?:时段|时间|出场人物|登场人物|人物|角色|地点|场景|时长|本段时长|段落时长)\s*[：:]/.test(ln)
  const raw = []
  let cur = null, started = false, stopped = false
  for (const line of String(md == null ? '' : md).split(/\r?\n/)) {
    const ln = line.trim()
    if (isTop(ln)) { if (started) stopped = true; continue }
    if (stopped) continue
    if (isHead(ln)) { cur = []; raw.push(cur); started = true; continue }
    if (!cur || !ln || isMeta(ln)) continue
    cur.push(ln)
  }
  const cnt = b => (beatUnit === 'sentence')
    ? b.reduce((a, l) => a + l.split(/[。！？!?]/).map(x => x.trim()).filter(Boolean).length, 0)
    : b.length
  const per = raw.map(cnt)
  const B = per.reduce((a, b) => a + b, 0)
  return { ok: per.length > 0, reason: per.length > 0 ? '' : 'nobeats', beatUnit, B, units: per.length, per }
}

/**
 * 双轨配时规划（纯函数）。
 *   唯一公式：`N_floor = max(⌈T/DUR_MAX⌉, ⌈B/每镜单元上限⌉)`
 *             `N_ceil  = ⌊T/DUR_MIN⌋`
 *             `N*      = clamp(⌈B/每镜目标单元数⌉, N_floor, N_ceil)`
 *   `beatsPerShot`（目标，默认 1 = 一个画面单元一个镜头）就是那个**口味旋钮**：
 *     1 → 快剪档（B=14 → 14 镜 / 均 4.3s）；1.5 → 中档（10 镜 / 6s）；2 → 慢镜档（7 镜 / 8.6s）。
 *     三者**都不挤不拖**（R = T/B 与 N 无关），差别纯粹是审美，所以它必须由体裁声明而不是程序猜。
 *   `beatsPerShotMax`（默认 2）是**硬上限**：H3 单镜一次连续生成、镜内不能剪辑，
 *     一镜塞 >2 个画面单元，超出的那些根本演不出来（shots-ad.md rev6 的实测结论）。
 * 🔴 T 的来源：`targetSec`（用户声明的本集目标时长）优先；没给才回落到脚本自带的「时长：」之和。
 * @returns {{ok, reason, beatUnit, B, units, per, T, Tfrom, N, R, perShot, avgSec,
 *            Nfloor, Nceil, Nstar, shotSec, secPerBeat, beatsPerShot, beatsPerShotMax}}
 *   R = T/B（秒/单元，节奏刻度，**与 N 无关**）；perShot = B/N（单元/镜）；avgSec = T/N（平均镜长）
 *   reason: '' 可用 | 'nopacing' 体裁没声明 | 'nobeatunit' 没声明数法 | 'nobase' 缺 T 或 B
 */
export function pacingPlan({ adapted = '', shots = 0, targetSec = 0, limits = {} } = {}) {
  const p = (limits && limits.pacing) || null
  const empty = { ok: false, reason: 'nopacing', beatUnit: '', B: 0, units: 0, per: [],
                  T: 0, Tfrom: '', N: 0, R: 0, perShot: 0, avgSec: 0, Nfloor: 0, Nceil: 0, Nstar: 0,
                  shotSec: [0, 0], secPerBeat: [0, 0], beatsPerShot: 0, beatsPerShotMax: 0 }
  if (!p) return { ...empty }
  const beatUnit = String(p.beatUnit || '').trim()
  const eb = episodeBeats(adapted, { beatUnit })
  if (!eb.ok) return { ...empty, reason: eb.reason || 'nobeatunit', beatUnit }
  const N = Math.max(0, Math.round(Array.isArray(shots) ? shots.length : (Number(shots) || 0)))
  const u = storyUnits(adapted)
  const tgt = Math.round(Number(targetSec) || 0)
  const T = tgt || (u.hasSec ? u.totalSec : 0)
  const Tfrom = tgt ? 'target' : (u.hasSec ? 'script' : '')
  const shotSec = pair2(p.shotSec, [4, DUR_MAX])
  const secPerBeat = pair2(p.secPerBeat, [0, 0])
  const maxB = Math.max(1, Number(p.beatsPerShotMax) || 2)
  const tgtB = Math.min(maxB, Math.max(1, Number(p.beatsPerShot) || 1))
  const B = eb.B
  if (!T || !B) {
    return { ...empty, reason: 'nobase', beatUnit, B, units: eb.units, per: eb.per, T, Tfrom, N,
             shotSec, secPerBeat, beatsPerShot: tgtB, beatsPerShotMax: maxB }
  }
  const DMIN = shotSec[0], DMAX = shotSec[1]
  const Nfloor = Math.max(Math.ceil(T / DMAX), Math.ceil(B / maxB))
  const Nceil = Math.max(1, Math.floor(T / DMIN))
  // 上下夹反时（T 太小塞不下 B）以 Nfloor 为准 —— 那正是「素材太密」，交给 pace-dense 报
  const Nstar = Math.max(Nfloor, Math.min(Math.ceil(B / tgtB), Nceil))
  const R = T / B
  const perShot = N ? B / N : 0
  const avgSec = N ? T / N : 0
  return { ok: true, reason: '', beatUnit, B, units: eb.units, per: eb.per, T, Tfrom, N,
           R, perShot, avgSec, Nfloor, Nceil, Nstar, shotSec, secPerBeat,
           beatsPerShot: tgtB, beatsPerShotMax: maxB }
}

/**
 * 双轨配时体检（纯函数）。三类 issue（都只在体裁声明了 `limits.pacing` 时才可能出）：
 *   pace-cramp  单元/镜 > beatsPerShotMax —— 一镜装不下那么多画面单元（H3 单镜一次连续生成、
 *               镜内不能剪辑，超出的单元根本演不出来）→ **下游补镜**（`fitShotCount` 的 pacing 路径）
 *   pace-dense  R = T/B < secPerBeat[0] —— 素材太密 / 目标时长太短 → **上游**（延长目标或删内容）
 *   pace-thin   R = T/B > secPerBeat[1] —— 素材太稀 / 撑不满目标 → **上游**（扩写或缩短目标）
 * 🔴 后两类程序修不了（是「素材 ↔ 目标」的矛盾，不是配镜问题），如实报告回上游，绝不硬凑 ——
 *    与 capacity-script 同一个哲学：能算的算死，不能算的说清楚。
 */
export function pacingAudit({ adapted = '', shots = 0, targetSec = 0, limits = {} } = {}) {
  const plan = pacingPlan({ adapted, shots, targetSec, limits })
  const issues = []
  if (!plan.ok) return { ...plan, issues }
  const maxB = plan.beatsPerShotMax || 2
  if (plan.N > 0 && plan.perShot > maxB) {
    issues.push({
      kind: 'pace-cramp',
      text: '单元挤：' + plan.B + ' 个画面单元塞进 ' + plan.N + ' 个镜头（' + plan.perShot.toFixed(1) +
        ' 单元/镜，上限 ' + maxB + '）—— 一镜一次连续生成、镜内不能剪辑，超出的单元演不出来。建议补到 ' +
        plan.Nstar + ' 镜（约 ' + (plan.T / plan.Nstar).toFixed(1) + ' 秒/镜）'
    })
  }
  const [lo, hi] = plan.secPerBeat
  const R = plan.R
  if (lo && hi && R) {
    if (R < lo) {
      issues.push({
        kind: 'pace-dense',
        text: '素材偏密：' + plan.T + 's ÷ ' + plan.B + ' 个画面单元 = ' + R.toFixed(1) + ' 秒/单元，低于舒适下限 ' +
          lo + 's —— 每个单元只有 ' + R.toFixed(1) + 's 展示，内容会被挤掉。目标时长至少要 ' +
          Math.ceil(plan.B * lo) + 's，或者删减文案'
      })
    } else if (R > hi) {
      issues.push({
        kind: 'pace-thin',
        text: '素材偏稀：' + plan.T + 's ÷ ' + plan.B + ' 个画面单元 = ' + R.toFixed(1) + ' 秒/单元，超过舒适上限 ' +
          hi + 's —— 镜头里没有那么多内容可演，会空转拖沓。要么把文案扩写到约 ' +
          Math.ceil(plan.T / hi) + ' 个画面单元，要么把目标时长缩到 ' + Math.floor(plan.B * hi) + 's'
      })
    }
  }
  return { ...plan, issues }
}

/**
 * 分镜自检（纯函数，2026-10-09）：把「生成出来多少镜 / 多长」与「改编稿里有几个叙事单元」对一遍。
 *
 * 为什么需要：广告体裁的镜头量上限（段落数 × 1.5）与总时长（脚本各段合计 ±20%）写在
 * shots-ad.md 里，但**规范是给模型看的，程序此前零校验** —— V9X-4 出 12 镜
 * （4 段落 / 脚本 30 秒，上限 6 镜、时长上限 36 秒）时界面一声不响，用户只能自己去数。
 * 对照：场景名有 sceneCardIssues 黄标 + 缺档案自动兜底，镜头量这里此前什么都没有。
 *
 * limits 由**体裁声明**（genre json 的 `limits: {shotsPerUnit, durTol, pacing}`）——
 * 剧集体裁的镜头量不是按段落数算的（基座是「每 1000 字 8-15 镜」），声明缺席就不判，
 * 免得给剧集项目刷假警报。
 * 🔴 2026-10-12 起多一层：**时长容量**（shotCapacity）——判「N 个镜头装不装得下脚本 T 秒」，
 *    纯算术、0 容忍、不受 durTol 影响。issue.kind ∈ units | capacity-script | capacity-short |
 *    capacity-seg | dur（最后一条只在容量层没话说时才出）。
 * 🔴 2026-10-13 起再多一层：**双轨配时**（pacingAudit）—— 由体裁 `limits.pacing` 门控，
 *    不声明则 issues 恒空。issue.kind ∈ pace-cramp | pace-dense | pace-thin。
 * @returns {{units:number, shots:number, total:number, cap:object, capacity:object, pacing:object, issues:Array<{kind:string,text:string}>}}
 */
export function shotCheck({ shots = [], adapted = '', limits = {}, targetSec = 0 } = {}) {
  const list = Array.isArray(shots) ? shots : []
  const u = storyUnits(adapted)
  const n = list.length
  const total = list.reduce((a, s) => a + (Number((s || {}).dur) || 0), 0)
  const perUnit = Number(limits && limits.shotsPerUnit) || 0
  const durTol = Number(limits && limits.durTol) || 0
  const cap = { units: (u.count && perUnit) ? Math.ceil(u.count * perUnit) : 0, durLo: 0, durHi: 0 }
  const issues = []
  if (cap.units && n > cap.units) {
    issues.push({ kind: 'units', text: '镜头数 ' + n + ' 个，超过上限 ' + cap.units + ' 个（脚本 ' + u.count + ' 个段落 × ' + perUnit + '）' })
  }
  // 🔴 时长容量（2026-10-12）：纯算术判据、0 容忍，**不走 durTol**。
  //    上面那条宽松阈值（±20%）会把「结构性装不下」当成「节奏略偏」放行 ——
  //    V9X-4 实测 6 镜 90s vs 脚本 105s（偏差 14.3%）就这么溜过去了。
  const capty = shotCapacity({ shots: list, adapted, limits })
  for (const it of capty.issues) issues.push(it)
  // 容量层已经给出更精确的诊断时，不再用那条宽松判据重复报同一件事
  const durExplained = capty.issues.length > 0
  if (u.hasSec && durTol && !durExplained) {
    cap.durLo = Math.floor(u.totalSec * (1 - durTol))
    cap.durHi = Math.ceil(u.totalSec * (1 + durTol))
    if (total < cap.durLo || total > cap.durHi) {
      issues.push({ kind: 'dur', text: '总时长 ' + total + 's，超出脚本 ' + u.totalSec + 's 的 ±' + Math.round(durTol * 100) + '% 区间（' + cap.durLo + '-' + cap.durHi + 's）' })
    }
  }
  // 🔴 双轨配时（2026-10-13）：由体裁 `limits.pacing` 门控 —— 不声明则 issues 恒空，
  //    广告继续走「逐段秒数 + capacity-seg」老路，一行都不受影响。
  const pacing = pacingAudit({ adapted, shots: list, targetSec, limits })
  for (const it of pacing.issues) issues.push(it)
  return { units: u.count, shots: n, total, cap, capacity: capty, pacing, issues }
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
      out[n] = '没有任何镜头在用这个场景名（用「写入镜头」写进镜头，或删掉这张卡）'
    }
  }
  return { used, byName: out, advice, ok: Object.keys(out).length === 0 }
}

// ---------------------------------------------------------------
// 场景「声明 ↔ 落地 ↔ 引用」三方一致性（2026-10-10）
//   背景（实测三次同类事故，全是程序绿灯、用户先发现）：
//     ① V9X-4 一轮：改编稿 §三 声明了「座舱·内」，scenes.json 只落地 5 条 ·外
//        → 车内画面只能挂车外空镜（那份档案 prompt 写着「室外」「都市实景空镜」）；
//     ② V9X-4 二轮：§三 名与 §五 段落头错位一位 →「溪畔新绿·外」成了孤儿档案；
//     ③ H10：§三 声明 5 条（四季各一条），§五 4 段段落头却全写同一个名字
//        → scenes.json 只落地 1 条，四季共用一张春天参考图（用户原话「场景区分不出来」）。
//   🔴 为什么现有护栏全都查不出：sceneAlign / sceneCardIssues 都是「**分镜 → 档案**」单向
//      ——只查「镜头引用了不存在的档案」。而上面的病根在**更上游**：
//      「改编稿第三部分声明了什么」这条信息从未参与任何比对。
//   本函数补上：声明（§三，逐字解析）→ 落地（scenes.json）→ 引用（shots[].scene）。
//   解析不到 §三 声明 → declared 为空、恒 ok，绝不误报。
//   🔴 2026-10-13 纠正一处**错误假设**：原注释写「剧集体裁走 adapt.md、结构不同 → 解析不到」，
//     实际上剧集 §三 的字段清单里就有「**空间结构**」，凭它反倒能被扫出来 —— 于是一路报假警。
//     现在两种体裁的 §三 都**正式支持**：标题认「空间」或「场景」，
//     档案名兼容「裸名字」（广告 adapt-ad.md）与「场景名：名字」（剧集 adapt.md）两种写法。
//   🔴 2026-10-13 又修一处**独立的**恒误报（与上面那条前缀问题不是一回事，别混）：`missing` 必须
//     **门控在「已经生成过」之后**。原因是这个三方比对的**三方可得时机差了一个阶段**：
//       · declared 来自改编稿 §三 —— **改编完就有值**（上游）
//       · landed 来自 ep.scenes（scenes.json）—— **只在「生成分镜脚本」时**由 saveArtifact 写入（下游）
//     用「上游必有值」比「下游必然为空」→ 生成前 missing 恒等于 declared → 横幅在「只改编了剧本」
//     的阶段就必弹。实测（离线探针扫全项目）：凡能解析出 §三 的项目，未生成态 100% 报 missing。
//     🔴 与配时类护栏的**原则区别**（判断护栏该不该在生成前出声，看它报的是哪一种）：
//       · `pace-dense` 报「**生成动作不会自动解决**的矛盾」（T 撑不下 B 个画面单元）→ 生成前报**正是它的价值**；
//       · `missing`    报「**生成动作本身就会解决**的状态」（还没落地）→ 生成前报是**纯噪音**。
//     🔴 分层：`missing` 数组照旧如实计算（它是**事实**：这些还没落地），**只门控 issues**（那才是**告警**）。
//        门控判据「已经生成过」= 已有镜头 或 已有落地档案 —— 这道门**不放过真事故**：
//        V9X-4「座舱·内 丢了」发生时镜头必然非空 → 照旧报。
//        其余四种 kind（extra / orphan / undeclared / collapsed）本身就以「落地非空」为前提，
//        生成前不可能触发，无需门控。
// ---------------------------------------------------------------
export function sceneDeclIssues(adapted, scenes, shots) {
  const md = String(adapted == null ? '' : adapted)
  const lines = md.split(/\r?\n/)
  // 先定位「第 X 部分：空间…」区块（标题写法兼容「二、…」「### 三、空间与光线连续性」），找不到就整篇扫。
  // 🔴 2026-10-13 修：标题判据必须**同时认「空间」与「场景」** ——
  //    广告体裁的 adapt-ad.md 写「三、空间与光线连续性」，而**剧集体裁的 adapt.md 写「三、场景设定」**。
  //    此前只认「空间」→ 剧集改编稿定位不到区块、退化成**全文扫**，再叠上下面那条「场景名：」前缀没剥的
  //    毛病，就变成「真人剧 / 真人剧2 每集恒报『第三部分声明的空间档案没有落地』」。
  //    放宽后：剧集能正确定位到 §三（同时 §四 分场剧本里那些「场次 N：地点」不会再被顺手扫到）。
  let start = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().replace(/^#+\s*/, '')
    if (/^[一二三四五六七八九十]+\s*[、.．]\s*.*(?:空间|场景)/.test(t)) { start = i + 1; end = lines.length; continue }
    if (start > 0 && /^[一二三四五六七八九十]+\s*[、.．]\s*\S/.test(t) && i > start) { end = i; break }
  }
  // 档案名 = 一个独立成段的短行，且**它的下一个非空行以「空间结构」开头**
  // 🔴 2026-10-12 修：剥行首的写法变体必须三样一起剥 ——
  //    `### 名字`（标题符）/ `1. 名字` `2、名字`（有序列表序号）/ `- 名字`（列表符），
  //    再剥名字两侧的 `**` 加粗。**改前只剥了「列表符 + 整行加粗」**，遇到改编稿实际在用的
  //    「`1. **混沌虚空·外**`」（序号 + 加粗同时出现）就剥不干净 → declared 变成「1. **混沌虚空·外」，
  //    与 landed 的「混沌虚空·外」逐条对不上 → V9X-4 六条档案全被判「没落地 / 不在声明里 / 没声明」，
  //    三条全是误报（用户在「生成镜头」时看到的那条就是它）。剥序号必须在剥加粗**之前**。
  const declared = []
  for (let i = start; i < end; i++) {
    const t = lines[i].trim()
      .replace(/^#+\s*/, '')
      // 🔴 列表符（`- `）后面必须跟空白 —— 否则 `**甲·外**` 的第一个 `*` 会被当成列表符吃掉，
      //    剩 `*甲·外` 与落地的 `甲·外` 又不相等（同一个坑，换个写法再摔一次）。
      .replace(/^\s*(?:[-*+]\s+|\d+\s*[.、．)）]\s*)/, '')
      .replace(/^\*\*|\*\*$/g, '')
      // 🔴 2026-10-13 修：剥掉「场景名：」**字段名前缀** —— 剧集体裁的 adapt.md 规定 §三 逐条写成
      //    「场景名：沈府·婚房·内」。不剥的话 declared 是带前缀的整行，而落地的档案名是**裸名**
      //    （「沈府·婚房·内」，取自 §五 场次头的写法）→ 两边永不相等 → missing 恒报，
      //    连「场景全部落地」都消不掉（真人剧 / 真人剧2 实测：生成完也报「声明 3 条 · 落地 0 条」）。
      //    🔴 冒号是**必须项**：以「场景」开头的合法名字（如「场景大道·外」）不含冒号，不会被误剥。
      .replace(/^场景名称?\s*[:：]\s*/, '')
      .trim()
    if (!t || /^[#>|]/.test(t)) continue
    if (t.length > 40) continue            // 档案名不会这么长（护栏：避免把说明段当名字）
    let j = i + 1
    while (j < end && !lines[j].trim()) j++
    if (j >= end || !/^空间结构\s*[:：]/.test(lines[j].trim())) continue
    if (declared.indexOf(t) < 0) declared.push(t)
  }
  const uniq = (a) => a.filter((v, i) => a.indexOf(v) === i)
  const landed = uniq((Array.isArray(scenes) ? scenes : [])
    .filter(o => o && String(o.name || '').trim()).map(o => String(o.name).trim()))
  const used = shotSceneNames(shots)
  // 「已经生成过」的判据（门控用，见函数头那条 🔴）：有镜头，**或**已有落地的场景档案。
  // 为什么是「或」而不是只看镜头：用户可能把镜头全删了而档案还在 —— 那时「声明没落地」依然是真问题。
  const generated = landed.length > 0 || (Array.isArray(shots) ? shots.length : 0) > 0
  // 🔴 解析不到 §三 声明 → 一律不判（这条护栏必须在前，否则「落地档案不在声明里」会全量误报）。
  if (!declared.length) {
    return { declared, landed, used, generated, missing: [], extra: [], orphans: [], usedNotDeclared: [], collapsed: false, issues: [], ok: true }
  }

  const missing = declared.filter(n => landed.indexOf(n) < 0)
  const extra = landed.filter(n => declared.indexOf(n) < 0)
  const orphans = landed.filter(n => used.indexOf(n) < 0)
  const usedNotDeclared = used.filter(n => declared.indexOf(n) < 0)
  // 塌缩（H10 的形态）：只落地一条，且**声明里有 ≥2 条与该条同「基名」**（同一条路的四季被并成一条）。
  // 🔴 两个细节都必须对：
  //   ① 基名 = 先剥掉括号限定词（`（春）` / `（全片共用）`）再取 sceneKey —— 直接用 sceneKey
  //      会把「花海公路·外（春）」算成「花海公路外春」，与「花海公路·外」永不相等，判据恒不触发；
  //   ② 必须带「≥2 条同基名」——否则「声明 2 条只落地 1 条」的普通情况
  //      （§三 声明了公路 + 座舱·内，而座舱·内 丢了）会被误判成塌缩，两个故事完全不同。
  const sceneBase = (n) => sceneKey(String(n == null ? '' : n).replace(/[（(][^）)]*[）)]/g, ''))
  const base0 = landed.length === 1 ? sceneBase(landed[0]) : ''
  const sameBaseCount = base0 ? declared.filter(n => sceneBase(n) === base0).length : 0
  const collapsed = declared.length >= 2 && landed.length === 1 && sameBaseCount >= 2

  const issues = []
  if (collapsed) {
    issues.push({
      kind: 'collapsed',
      text: '改编稿第三部分声明了 ' + declared.length + ' 条空间档案，实际只落地 1 条（' + landed[0] +
        '）——多条声明被合并成一条，下游只会出一张参考图'
    })
  } else if (missing.length && generated) {
    // 🔴 门控：只在「已经生成过」时才报（病根见函数头那条 🔴）——生成前 landed 恒为空，
    //    这不是错误而是**待生成态**，报出来是纯噪音（用户还没点「生成分镜脚本」就先被报了警）。
    issues.push({
      kind: 'missing',
      text: '改编稿第三部分声明的空间档案没有落地：' + missing.join('、') + '（这些段落会退化成通用空镜）'
    })
  }
  if (collapsed && extra.length) {
    // 塌缩时不必再单列 extra（同一条故事的另一个说法）
  } else if (extra.length) {
    issues.push({ kind: 'extra', text: '落地档案不在第三部分声明里：' + extra.join('、') + '（手工加的档案可忽略）' })
  }
  if (orphans.length) {
    issues.push({ kind: 'orphan', text: '有档案没有任何镜头在用：' + orphans.join('、') + '（补镜头或删卡）' })
  }
  if (usedNotDeclared.length) {
    issues.push({ kind: 'undeclared', text: '镜头用了第三部分没声明的场景名：' + usedNotDeclared.join('、') })
  }
  return { declared, landed, used, generated, missing, extra, orphans, usedNotDeclared, collapsed, issues, ok: issues.length === 0 }
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
 * 不是角色的「发声者」（2026-10-08）。
 * 广告 / 解说类片子的台词行里有整类**本来就不该有角色卡**的发声者：旁白、字卡、字幕、解说。
 * 镜头名对齐时跳过它们 —— 否则广告片每一条带旁白的镜头都会黄标「旁白 没有同名角色卡，
 * 参考图会挂不上」，用户会去建一张「旁白」的角色卡（然后生成一张毫无意义的人物参考图）。
 * 剧集侧不受影响：那边「旁白」本来就写成 `听到的人名（独白）`，说话人是人名不是「旁白」。
 */
const NON_CHAR_SPEAKERS = new Set(['旁白', '字卡', '字幕', '解说', '配音'])

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
    // 旁白 / 字卡这类「不是角色的发声者」不进 missing —— 它们本来就不该有角色卡
    if (!NON_CHAR_SPEAKERS.has(n)) missing.add(n)
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

// ---------------------------------------------------------------
// 装扮变体 —— 逐镜装扮状态推导（2026-10-16）
//   一个角色的「换装变体」（婚装 / 常服 / 夜行装…）从哪来？**不重新读剧本去猜** ——
//   分镜抽取阶段本来就逐镜产出了两样东西：
//     · shots[].continuity —— 本镜的状态快照，每行「主体·维度：值」，「服装」只是其中一个维度
//     · shots[].change     —— 本镜**实际发生**的状态变化「主体·维度：旧值 → 新值（触发动作）」
//   所以「谁在第几镜换了哪套衣服」是已有数据里的**显式事实**，本块只做推导与匹配：
//     · dimEntries      —— 从 continuity/change 文本里筛出某主体某维度的条目
//     · matchOutfit     —— 拿装扮清单的 kw 把一段描述归到某套装扮（最长关键词优先）
//     · outfitStates    —— 逐镜推导「这一镜该穿哪套」（change 定换装点、continuity 校正）
//     · shotHasChar     —— 这一镜的 chars 里有没有点名这个角色（精确优先，可选子串放宽）
//     · outfitShotBrief —— 拼给大模型的「本集镜头记录」素材（只含该角色出现的镜头）
//     · parseOutfitList —— 解析大模型返回的装扮清单（宽松，容忍字段缺失与脏名字）
//     · outfitPlan      —— 「这一镜该填哪张装扮图」的逐镜计划（第 3 步：按装扮填全部镜头）
//     · mergeOutfitList —— 把本集识别结果并进**项目级**清单（跨集继承：同名沿用，不另起名字）
//     · outfitKnownBrief—— 把项目级已知装扮名单拼成 {{known}} 槽的文本（下发给模型让它沿用）
//   全部是纯函数、不依赖 Vue 与 electron —— 可被裸 node 直接单测（test/outfit-state-check.mjs）。
//   🔴 本文件必须保持**零 import**：测试会把它整份复制成 .mjs 单跑（见 test/outfit-state-check.cjs），
//      任何相对导入都会在复制后断链。所以这里不 import variant.js 的 baseOf ——
//      需要「主体名」的地方一律由调用方（StageChars 有 variant.js）算好再传进来。
// ---------------------------------------------------------------

/** 「服装类维度」的判据：维度名命中它才算换装相关（随身物 / 天气 / 时段 / 站位都不算） */
const OUTFIT_DIM_RE = /(服装|衣|装束|服饰|穿着|装扮|配饰|头饰|冠|袍|裙)/

/**
 * 从 continuity / change 文本里筛出「某主体 + 某维度」的条目。
 * 行格式「主体·维度：值」；主体名自己可能含间隔号（「礼堂·内」）→ 按**最后一个** `·` 切。
 * 主体一列为空的行（模型偶尔漏写）也收 —— 单主体场景下它是合理的。
 * @param {string} text continuity / change 原文（可多行）
 * @param {string} subject 要筛的主体名（空 = 不过滤）
 * @param {RegExp} dimRe 维度过滤（省略 = 不限维度）
 * @returns {Array<{sub:string, dim:string, val:string}>}
 */
export function dimEntries(text, subject, dimRe) {
  const out = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (!m) continue
    const head = m[1].trim()
    const at = head.lastIndexOf('·')
    const sub = (at > 0 ? head.slice(0, at) : '').trim()
    const dim = (at > 0 ? head.slice(at + 1) : head).trim()
    if (dimRe && !dimRe.test(dim)) continue
    if (subject && sub && charKey(sub) !== charKey(subject)) continue
    out.push({ sub, dim, val: m[2].trim() })
  }
  return out
}

/**
 * 拿装扮清单的 kw 把一段描述归到某套装扮（**最长关键词优先**）。
 * 关键词短于 2 字的一律不用（「衣」「红」这种会到处误命中）；装扮名本身也当关键词参与匹配。
 * @returns {string} 命中的装扮名；一个都没命中返回空串
 */
export function matchOutfit(text, outfits) {
  const t = String(text == null ? '' : text)
  if (!t) return ''
  const list = Array.isArray(outfits) ? outfits : []
  let best = '', bestLen = 0
  for (const o of list) {
    const nm = String((o && o.name) || '').trim()
    if (!nm) continue
    const words = [nm].concat(Array.isArray(o && o.kw) ? o.kw : [])
    for (const w of words) {
      const k = String(w == null ? '' : w).trim()
      if (k.length < 2) continue
      if (t.indexOf(k) >= 0 && k.length > bestLen) { best = nm; bestLen = k.length }
    }
  }
  return best
}

/**
 * 逐镜推导「这一镜该穿哪套」（纯函数）。
 * 规则（顺序即优先级）：
 *   ① 用 continuity 的快照校正当前值（命中装扮清单的某个关键词才动）
 *   ② 再用 change 的换装点覆盖 —— 它写的是「本镜实际发生的变化」，换完之后的样子才算数
 * 两块都命中不到 → 保持上一镜的状态（**绝不猜**）。基线装扮 = 清单里标 `base` 的那条（没有就取第一条）。
 * 返回值一律给值、与 shots 等长：调用方自己判「这一镜该角色有没有出现」（不出现的镜头填了也无害）。
 * @param {Array} shots 镜头数组
 * @param {string} name 角色名（主体名）
 * @param {Array} outfits 装扮清单 [{name, desc, base, kw}]
 * @returns {string[]} 每个镜头该穿的装扮名
 */
export function outfitStates(shots, name, outfits) {
  const arr = (Array.isArray(shots) ? shots : []).map(s => s || {})
  const list = Array.isArray(outfits) ? outfits : []
  const baseObj = list.find(o => o && o.base) || list[0] || null
  let cur = baseObj ? String(baseObj.name || '').trim() : ''
  const out = []
  for (const s of arr) {
    for (const e of dimEntries(s.continuity, name, OUTFIT_DIM_RE)) {
      const hit = matchOutfit(e.val, list)
      if (hit) cur = hit
    }
    for (const e of dimEntries(s.change, name, OUTFIT_DIM_RE)) {
      const p = parseChange(e.dim + '：' + e.val)
      const hit = matchOutfit(p ? p.to : e.val, list)
      if (hit) cur = hit
    }
    out.push(cur)
  }
  return out
}

/**
 * 这一镜的 `chars` 里有没有点名这个角色（纯函数）。
 * 为什么单拎出来（2026-10-16）：出场判据在**三处**都要用（识别素材 / 逐镜装扮计划 / 一键填充），
 *   而且每处对「宽严」的要求不同，写在三个地方迟早会分叉。
 * 🔴 精确与宽松的差别是**真事故**：子串匹配会让「苏锦瑟」命中「小苏锦瑟」——
 *   一个镜头里明明只有小苏锦瑟，却因为名字里带着「苏锦瑟」三个字被算成她在场，
 *   于是把她的参考图/装扮填进这一镜。所以**精确比较是默认**（按 `[、,，/]` 切分后逐项比对，
 *   比对走 charKey —— 剥掉「（主角）」这类定位标签、忽略空白与大小写）。
 * loose=true 才额外放宽成整串子串匹配：留给「素材本来就写得不规范」的场景
 *   （chars 用空格分隔、或只有半截名字），调用方自己权衡。
 * @param {string} chars 镜头的 shots[].chars 原文
 * @param {string} name 角色名（可以是卡片名，也可以是主体名 —— 由调用方决定）
 * @param {boolean} [loose] 是否在精确比对失败后再用整串子串兜底
 * @returns {boolean}
 */
export function shotHasChar(chars, name, loose) {
  const raw = String(chars == null ? '' : chars)
  const key = charKey(name)
  if (!raw || !key) return false
  const parts = raw.split(/[、,，/]/).map(x => charKey(x)).filter(Boolean)
  if (parts.indexOf(key) >= 0) return true
  return loose ? charKey(raw).indexOf(key) >= 0 : false
}

/**
 * 拼给大模型的「本集镜头记录」素材：只含**该角色出现**（chars 里点名）的镜头，
 * 逐镜带上他的服装状态与换装点。与 continuity 原文的区别：这里只留服装维度的行 ——
 * 其它维度（随身物 / 伤势 / 天气 / 站位）对这个任务是纯噪音，会挤占小模型的注意力。
 * 出场判据走 shotHasChar(…, loose=true)：**优先精确**，精确不中时才退回子串兜底 ——
 *   识别的原料是给人看的分镜记录，宁可多给一镜（噪音）也不要漏一镜（漏了模型就少认一套装扮）。
 */
export function outfitShotBrief(shots, name) {
  const arr = (Array.isArray(shots) ? shots : []).map(s => s || {})
  const out = []
  arr.forEach((s, i) => {
    if (name && !shotHasChar(s.chars, name, true)) return
    const scene = String(s.scene || '').trim()
    const act = String(s.action || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const snaps = dimEntries(s.continuity, name, OUTFIT_DIM_RE).map(e => e.dim + '：' + e.val)
    const chgs = dimEntries(s.change, name, OUTFIT_DIM_RE).map(e => e.dim + '：' + e.val)
    out.push('#' + (i + 1) + ' 【' + (scene || '未标场景') + '】' + (act || '（无动作描述）') +
      (snaps.length ? '\n  现在穿着：' + snaps.join('；') : '') +
      '\n  本镜换装：' + (chgs.length ? chgs.join('；') : '（无）'))
  })
  return out.join('\n')
}

/**
 * 清洗装束描述，让它能安全地填进换装指令的 `{装束}` 槽位。
 * 为什么需要它（2026-10-16 端到端实测两次踩到）：
 *   指令模板形如「…更换为「婚装」：{装束}，换装后衣料质感…」—— 槽位两侧写死了逗号与后续句子，
 *   所以槽里的内容**必须是一串逗号分隔的短语**，不能是自成句的句子：
 *     ① 句子以「。」结尾 → 拼出「…束发。，换装后…」（尾部标点，第一次踩到）；
 *     ② 更隐蔽的是**句中**带句号（模型把描述写成「…无配饰，黑发以素色布带束于顶。」中间又断句）
 *        → 只去尾部治不了，会在句子中间拼出「。。」→「。，」（第二次踩到）。
 *   所以这里不「只去尾部」，而是**把所有句末标点一律降级为逗号**：信息一个字不丢，只是不再断句。
 * 另外做三件事：去花括号（它是槽位语法，绝不能进正文，否则被护栏拦下）；
 *   名字/顿号/半角逗号统一成中文逗号并折叠连续分隔符；去首尾多余分隔符（避免「：，」）。
 * @param {string} s 大模型给出的（或用户手改的）装束描述
 * @returns {string} 单行、逗号分隔、无花括号的装束短语串
 */
export function tidyOutfitDesc(s) {
  return String(s == null ? '' : s)
    .replace(/[{}]/g, '')
    .replace(/(?<!\d)\.(?!\d)/g, '，')          // 半角句点降级（避开 2.5 这类小数）
    .replace(/[。．；;！!？?]/g, '，')
    .replace(/[，,、]/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/\s*，\s*/g, '，')
    .replace(/^[\s，：:]+|[\s，：:]+$/g, '')
}

/**
 * 解析大模型返回的装扮清单（宽松）。
 * 容错：整篇 JSON → 抓第一段 `{}`；清单挂在 outfits / 装扮 / 装扮清单 / list 任一键上；
 *   名字里的横杠一律剥掉（横杠是卡名 `主体--装扮` 的保留分隔符，写进去会把卡名切错）；
 *   描述走 `tidyOutfitDesc`（去花括号 + 句末标点降级，描述要填进换装指令的槽位）；
 *   kw 里补上装扮名本身；重名与超长名直接丢掉。
 * 兜底：**恰好一条 base** —— 模型没标 base 时把第一条当基线（宁可标错，也不要整个清单不可用）。
 * @returns {Array<{name:string, desc:string, base:boolean, kw:string[]}>}
 */
export function parseOutfitList(text) {
  const raw = String(text == null ? '' : text)
  let obj = null
  try { obj = JSON.parse(raw) } catch (_) { obj = null }
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) { try { obj = JSON.parse(m[0]) } catch (_) { obj = null } }
  }
  let arr = []
  if (obj) {
    for (const k of ['outfits', '装扮', '装扮清单', 'list']) {
      if (Array.isArray(obj[k])) { arr = obj[k]; break }
    }
  }
  const out = []
  const seen = new Set()
  for (const o of arr) {
    const name = String((o && o.name) || '').trim()
      .replace(/[-\uFF0D\u2013\u2014\uFE63\u2212]/g, '').replace(/\s+/g, '').trim()
    if (!name || name.length > 16 || seen.has(name)) continue
    seen.add(name)
    const desc = tidyOutfitDesc((o && o.desc) || '')
    const kw = (Array.isArray(o && o.kw) ? o.kw : [])
      .map(x => String(x == null ? '' : x).trim()).filter(Boolean)
    if (kw.indexOf(name) < 0) kw.push(name)
    out.push({ name, desc, base: !!(o && o.base), kw })
  }
  if (out.length && !out.some(o => o.base)) out[0].base = true
  return out
}

/**
 * 逐镜装扮计划（纯函数）：这个角色出现的每一镜，该填**哪张装扮图**。
 * 用于第 3 步「按装扮填全部镜头」—— 把「识别出来的装扮」真正落到每一镜的参考图区。
 * @param {Array} shots 镜头数组
 * @param {string} name 角色名（主体名；调用方给，本文件不算 baseOf —— 见块首注释）
 * @param {Array} outfits 装扮清单 [{name, desc, base, kw}]
 * @returns {Array<{i:number, outfit:string}>} 只含**该角色出现**且推导出了装扮的镜头，按镜号升序
 */
export function outfitPlan(shots, name, outfits) {
  const arr = (Array.isArray(shots) ? shots : []).map(s => s || {})
  const st = outfitStates(arr, name, outfits)
  const out = []
  arr.forEach((s, i) => {
    // 🔴 出场判据这里必须**精确**（loose 不传 = false）：本函数的产物会被写进参考图区，
    //    子串放宽容错会把别人的图填到这一镜里（「苏锦瑟」命中「小苏锦瑟」）——
    //    「多填一张」在生成时是实打实的错误输入，比「少填一镜」严重得多。
    if (!shotHasChar(s.chars, name, false)) return
    const o = String(st[i] || '').trim()
    if (!o) return
    out.push({ i, outfit: o })
  })
  return out
}

/** 装扮条目归一化（mergeOutfitList 用）：名字去空白、描述走 tidyOutfitDesc、kw 去重、base 布尔化 */
function normOutfitOne(o) {
  const name = String((o && o.name) || '').trim()
  const kw = (Array.isArray(o && o.kw) ? o.kw : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean)
  if (kw.indexOf(name) < 0 && name) kw.push(name)     // 装扮名本身永远是关键词（matchOutfit 也这么算）
  return { name, desc: tidyOutfitDesc((o && o.desc) || ''), kw: kw, base: !!(o && o.base) }
}

/**
 * 把一个角色的「本集识别结果」并进**项目级**装扮清单（跨集继承的核心，纯函数）。
 * 为什么需要：装扮是**人物属性**，不是某一集的私事。第 1 集识别出「苏锦瑟--婚装」，
 *   第 3 集若不知道这名字已存在，模型会另起一个（「苏锦瑟--大红嫁衣」）→ 同一套装扮长出两张卡、
 *   两套图，跨集参考图彻底错位。所以每次识别后都要把结果并回项目清单，下次识别再当「已知」下发。
 * 规则（顺序即优先级）：
 *   · **同名（精确字符串）合并成一条**：名字沿用旧的（先到先得 —— 跨集稳定优先于本集叫法）；
 *     描述取新的（本次识别更新鲜），新的为空则留旧的；kw 取**并集**。
 *   · 新名字追加到末尾（旧的在前面 → 卡片顺序稳定，不会因为重识别把老装扮挤到后面）。
 *   · 🔴 **基线归属沿用旧清单**：旧清单里标 `base` 的那条继续当基线（模型每集都可能把 base 标在
 *     不同条上，跟着它漂移会让基线装扮逐集换成不同的衣服）。旧清单没有 base 时才采用新的。
 *   · 兜底与 parseOutfitList 一致：非空清单恰好一条 base（都没有就第一条）。
 * @param {Array} oldList 项目清单里该主体已有的装扮（可为空/未定义）
 * @param {Array} curList 本次识别的结果（parseOutfitList 的产物）
 * @returns {Array} 合并后的清单（新数组，不改动入参）
 */
export function mergeOutfitList(oldList, curList) {
  const olds = (Array.isArray(oldList) ? oldList : []).map(normOutfitOne).filter(o => o.name)
  const curs = (Array.isArray(curList) ? curList : []).map(normOutfitOne).filter(o => o.name)
  const out = []
  const at = new Map()
  for (const o of olds) { at.set(o.name, out.length); out.push(o) }
  for (const c of curs) {
    const i = at.get(c.name)
    if (i == null) { at.set(c.name, out.length); out.push(c); continue }
    const o = out[i]
    const kw = o.kw.slice()
    for (const w of c.kw) if (kw.indexOf(w) < 0) kw.push(w)
    out[i] = { name: o.name, desc: c.desc || o.desc, kw, base: o.base }
  }
  if (!out.length) return out
  const oldBase = olds.find(o => o.base)
  const curBase = curs.find(c => c.base)
  const baseName = (oldBase || curBase || out[0]).name
  return out.map(o => ({ name: o.name, desc: o.desc, kw: o.kw, base: o.name === baseName }))
}

/**
 * 把项目级已知装扮名单拼成 `outfits.md` 的 `{{known}}` 槽文本（下发给模型，让它优先沿用旧名字）。
 * 只给名字 + 一句描述：模型要的是「这个名字指哪套装束」，不需要 kw（那是程序匹配用的）。
 * 空清单返回 `（暂无）` 而不是空串 —— 模板里这行后面紧跟着镜头记录，留空会让模型以为素材缺了一段。
 * @param {Array} list 该项目里该主体已有的装扮
 * @returns {string}
 */
export function outfitKnownBrief(list) {
  const arr = (Array.isArray(list) ? list : []).map(normOutfitOne).filter(o => o.name)
  if (!arr.length) return '（暂无）'
  return arr.map(o => '- ' + o.name + (o.base ? '（基线装扮）' : '') + '：' +
    (o.desc ? o.desc.slice(0, 60) : '（无描述）')).join('\n')
}

/* ============================================================================
 * 集级设定 setting（rev28 · 2026-10-16）
 *
 * 分镜环节现在**多产出一个 `setting` 对象**（`光线基调` / `轴线铁律` / `声音基底` / `禁止项`），
 * 它承载「镜头之间必须一致、但又不该逐镜重复写」的那部分内容。为什么不让模型每镜自己抄
 * （方案 A）：rev27 已经在 shots.md 里写下「光有这条纪律没用」——同一件事每镜各写一遍，
 * 模型必然会换说法（「主光自右侧窗照入」/「右侧窗光为主」），等于没定。
 * 所以这里走方案 B：**写一次、由程序逐镜复制**。
 *
 * 三个函数的职责边界：
 *   normSetting   —— 宽松解析模型给的对象（键名容错、字符串/数组容错、老集无 setting → null）
 *   settingBlock  —— 拼「continuity 段头」那几行（集级四项 + 该场主光），空则返回空串
 *   audioBaseBlock—— 拼 `{{audioBase}}` 槽文本（集级声音基底 + 该场环境音）
 * 🔴 一律**不改动入参**、一律**返回新对象/新字符串**（纯函数，便于离线单测）。
 * ========================================================================== */

/** setting 的四个字段（顺序 = 注入顺序 = 用户界面的显示顺序） */
export const SETTING_FIELDS = ['光线基调', '轴线铁律', '声音基底', '禁止项']

/** 每个字段的收词别名（模型偶尔用近义键名或英文键） */
const SETTING_ALIAS = {
  光线基调: ['光线基调', '基调', '光线', 'light', 'lightTone', 'lighting'],
  轴线铁律: ['轴线铁律', '轴线', 'axis', 'axisRule', 'axisRuleOf180'],
  声音基底: ['声音基底', '声音', '声底', 'sound', 'soundBase', 'audioBase', 'soundscape'],
  禁止项: ['禁止项', '禁止', '禁令', '禁忌', 'forbid', 'forbidden', 'bans', 'ban']
}

/** 禁止项归一化：数组 / 多行字符串 / 分隔符串都收成字符串数组 */
function normBanList(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n\r|；;、]+/)
  const out = []
  for (const x of raw) {
    const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim()
    if (s && out.indexOf(s) < 0) out.push(s)
  }
  return out
}

/**
 * 宽松解析 setting（纯函数）。
 * 容错：对象 / JSON 字符串（含 ```` ```json ```` 包裹或前后有解释文字）；对象可能被嵌在 `setting` 键下；
 *   键名走 SETTING_ALIAS 别名；`禁止项` 收数组或多行字符串。
 * 兜底：**四项全空 → 返回 null**（老集没有 setting 文件时也是 null），
 *   调用方据此降级成改造前的行为，而不是往提示词里塞一个空块。
 * @param {object|string|null} raw LLM 给的 setting、或磁盘上读回的 setting
 * @returns {{lightTone:string, axisRule:string, soundBase:string, bans:string[]}|null}
 */
export function normSetting(raw) {
  let obj = raw
  if (typeof obj === 'string') {
    const raw2 = obj
    obj = null
    try { obj = JSON.parse(raw2) } catch (_) { obj = null }
    if (!obj) {
      const m = raw2.match(/\{[\s\S]*\}/)
      if (m) { try { obj = JSON.parse(m[0]) } catch (_) { obj = null } }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const src = (obj.setting && typeof obj.setting === 'object' && !Array.isArray(obj.setting)) ? obj.setting : obj
  const pick = (field) => {
    for (const k of SETTING_ALIAS[field]) {
      if (src[k] != null && src[k] !== '') return src[k]
    }
    return ''
  }
  const lightTone = String(pick('光线基调') == null ? '' : pick('光线基调')).replace(/\s+/g, ' ').trim()
  const axisRule = String(pick('轴线铁律') == null ? '' : pick('轴线铁律')).replace(/\s+/g, ' ').trim()
  const soundBase = String(pick('声音基底') == null ? '' : pick('声音基底')).replace(/\s+/g, ' ').trim()
  const bans = normBanList(pick('禁止项'))
  if (!lightTone && !axisRule && !soundBase && !bans.length) return null
  return { lightTone, axisRule, soundBase, bans }
}

/** 从 `「字段名：值」每行一条` 的档案文本里取某个字段的值（取不到返回空串） */
export function pickProfileField(text, field) {
  const src = String(text == null ? '' : text)
  const f = String(field == null ? '' : field).trim()
  if (!src || !f) return ''
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    const m = line.match(/^([^：:]+)[：:]\s*([\s\S]*)$/)
    if (!m) continue
    if (m[1].trim() !== f) continue
    const v = m[2].replace(/\s+/g, ' ').trim()
    if (v) return v
  }
  return ''
}

/**
 * 拼「continuity 段头」的集级 + 场级常量块（纯函数）。
 * 产出形如（只列有值的行）：
 *   【集级设定（本集恒定不变，逐字照抄）】
 *   光线基调：…
 *   轴线铁律：…
 *   声音基底：…
 *   禁止项：…；…
 *   本场主光：…
 * 🔴 尾部带换行：调用方直接 `block + 本镜 continuity` 即可拼成完整段，不必再补分隔符。
 * @param {object|string} setting normSetting 的入参形态
 * @param {{mainLight?:string}} [opt] 该场主光（来自场景档案的「主光」行）
 * @returns {string} 四项与主光都为空时返回空串（→ 调用方原样下发旧内容，行为等价改造前）
 */
export function settingBlock(setting, opt = {}) {
  const s = normSetting(setting)
  const lines = []
  if (s) {
    const head = []
    if (s.lightTone) head.push('光线基调：' + s.lightTone)
    if (s.axisRule) head.push('轴线铁律：' + s.axisRule)
    if (s.soundBase) head.push('声音基底：' + s.soundBase)
    if (s.bans.length) head.push('禁止项：' + s.bans.join('；'))
    if (head.length) {
      lines.push('【集级设定（本集恒定不变，逐字照抄到本镜的每个维度里）】')
      for (const h of head) lines.push(h)
    }
  }
  const ml = String((opt && opt.mainLight) || '').replace(/\s+/g, ' ').trim()
  if (ml) {
    if (!lines.length) lines.push('【本场固定光线（逐字照抄，本场不许换光源方向）】')
    lines.push('本场主光：' + ml)
  }
  if (!lines.length) return ''
  return lines.join('\n') + '\n'
}

/**
 * 拼 `{{audioBase}}` 槽文本（纯函数）：集级声音基底 + 该场环境音。
 * 为什么两块都要：集级管「整集是什么配乐」（BGM 不许重启），场级管「这一场在响什么」（底噪不许消失），
 * 二者合起来才是「这件声音一直在响」的完整交代 —— 只给一半，另一半点会空。
 * 空则返回 `（无）` 而不是空串：模板里这块前后都是英文说明行，留空会让模型以为素材缺了一段。
 * @param {object|string} setting
 * @param {string} [sceneAmbient] 该场「环境音」字段的值
 * @returns {string}
 */
export function audioBaseBlock(setting, sceneAmbient) {
  const s = normSetting(setting)
  const lines = []
  if (s && s.soundBase) lines.push('本集声音基底（整集不中断）：' + s.soundBase)
  if (s && s.bans.length) lines.push('声音方面的禁止项：' + s.bans.join('；'))
  const amb = String(sceneAmbient == null ? '' : sceneAmbient).replace(/\s+/g, ' ').trim()
  if (amb && amb !== '安静') lines.push('本场环境音（本场持续底噪）：' + amb)
  return lines.length ? lines.join('\n') : '（无）'
}

/**
 * 角色/场景的**锚点摘要**（纯函数，决策 4）。
 * 起因（2026-10-16）：参考模式下 `<Subject N>` 由参考图定义外观，此时再发一份含完整外貌的
 *   `prompt` 全文是**双描述** —— 图里因生成误差没出现的纹样、文字还写着，模型会照文字加回去；
 *   还会与 `<Subject N>` 的「不要变成什么」边界句打架。
 * 做法：只留**最稳定的区分维度**（模型靠它们把分镜里的人名对上画面里的主体就够了），
 *   去掉摄影术语 / 光线 / 画质 / 负面词，以及「面部基线」（它已改由本镜 `action` 承载，见 rev26）
 *   与「依据」（给人看的线索来源，对画面零信息）。
 * 🔴 只用于**参考模式**：基础模式没有任何图，`prompt` 是唯一外观来源，仍发全文。
 * @param {object|string} card 卡片对象（取 .profile）或档案文本本身
 * @returns {string} 逗号分隔的短语串；档案为空返回空串
 */
export function anchorBrief(card) {
  const src = String(
    (card && typeof card === 'object')
      ? ((card.profile != null && card.profile !== '') ? card.profile : '')
      : (card == null ? '' : card)
  )
  if (!src.trim()) return ''
  const parts = []
  for (const f of ANCHOR_DIMS) {
    const v = pickProfileField(src, f)
    if (v) parts.push(f + '：' + v)
  }
  return parts.join('，')
}

/**
 * 锚点维度（顺序 = 输出顺序）。
 * 取「一眼能区分人与物」的稳定视觉维度：性别 / 年龄段 / 身形体态 / 脸型骨架 / 发型发饰 / 服装 / 配饰道具 / 主色调。
 * 不含：妆容（近距离细节，参考图已给）、面部基线（归本镜 action）、依据（线索来源）、身份（不是画面信息）。
 */
const ANCHOR_DIMS = ['性别', '年龄段', '身形体态', '脸型骨架', '发型发饰', '服装', '配饰道具', '主色调']

/**
 * 批量锚点摘要（发给参考模式 `{{characters}}` / `{{scenes}}` 的文本）。
 * 与 `variant.js` 的 `groupProfiles` 同形：**每个主体一行**、键用主体名（分镜里写的是主体名）。
 * 场景侧的字段名与角色不同，所以用同一个 pick 逻辑、按传入的维度表取。
 * @param {Array} list 卡片数组
 * @param {function} [renderOne] 单卡取文本（默认 anchorBrief）
 * @returns {string}
 */
export function anchorProfiles(list, renderOne) {
  const fn = renderOne || anchorBrief
  const rows = []
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.name) continue
    const body = fn(c)
    if (!body) continue
    rows.push(String(c.name) + '：' + body)
  }
  return rows.join('\n')
}

