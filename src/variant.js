/**
 * 角色 / 产品卡的「主体 ↔ 变体」两级命名（2026-10-08，Dragon 需求）
 *
 * 两级约定（互不冲突，写法只差一个横杠）：
 *   **单横杠 = 形态变体**：外观本身就变了（如「李白-少年」/「李白-老年」）。
 *     → 各自一份档案，分镜里写全名，系统不合并任何东西。（这条是既有约定，见新增卡弹窗提示语）
 *   **双横杠 = 视角变体**：外观不变、只是看点不同（如「魏牌 V9X--正面」/「魏牌 V9X--内饰」）。
 *     → 归为同一主体、共用「父卡」（名字正好等于主体名的那张）的档案；
 *        发给视频模型时**只发父卡那一份**；分镜里只写主体名。
 *
 * 为什么分隔符放宽成「连续 2 个以上的横杠类字符」而不是死认 ASCII 的 `--`：
 *   中文输入法在中文态敲连字符常出全角「－」，中文破折号本身又是两个「—」。
 *   只认 ASCII 的话，用户「自己命名容易出错」的老问题会原样回来。
 *   仍然要求 **2 个以上**，所以「李白-少年」这种单横杠形态变体不会被误并。
 *
 * 🔴 视角组名（baseOf）与库的「基础名」（library.cjs 的 baseNameOf / StageChars 的 libBase）**不是同一层**：
 *   前者是「主体」（只切双横杠），后者是「形态家族」（双横杠后再切单横杠）。两者用途不同，别互相替代。
 */

/** 分隔符：连续 2 个以上的横杠类字符（ASCII 连字符 / 全角连字符 / 短破折号 / 长破折号 / 小连字符 / 减号） */
const VARIANT_SEP_RE = /[-\uFF0D\u2013\u2014\uFE63\u2212]{2,}/

/**
 * 解析一个卡名 → { base, variant }
 * - 「魏牌 V9X--正面」→ { base: '魏牌 V9X', variant: '正面' }
 * - 「魏牌 V9X」      → { base: '魏牌 V9X', variant: '' }
 * - 「--正面」（只有视角没主体）/「魏牌 V9X--」（只有主体没视角）→ 都不算变体，按原名整张处理
 * 不变式：isVariant(name) === (baseOf(name) !== name)
 */
function parseName(name) {
  const s = String(name == null ? '' : name).trim()
  const m = VARIANT_SEP_RE.exec(s)
  if (m) {
    const base = s.slice(0, m.index).trim()
    const variant = s.slice(m.index + m[0].length).trim()
    if (base && variant) return { base: base, variant: variant }
  }
  return { base: s, variant: '' }
}

/** 视角组名（= 主体名）。没有双横杠时原样返回卡名 */
export function baseOf(name) { return parseName(name).base }

/** 视角名（「正面」/「内饰」…）；不是视角变体时返回空串 */
export function variantOf(name) { return parseName(name).variant }

/** 是否视角变体（双横杠写法） */
export function isVariant(name) { return parseName(name).variant !== '' }

/**
 * 字符串里是否含「视角变体分隔符」（连续 ≥2 个横杠类字符）。
 * 用途：**禁止用户手写**「主体名--视角」这种卡名（2026-10-08，Dragon）——
 *   视角卡只允许从主体卡的「+」派生，那里主体名固定，用户只填视角名，改名冲突从源头消失。
 * 🔴 必须复用同一个 VARIANT_SEP_RE，不能只查 ASCII 的 `--`：
 *   中文输入法在中文态敲连字符出的是全角「－」，只查半角的话 `V9X－－正面`（全角）照样能建出来，
 *   而 parseName 照样把它当视角变体 —— 等于拦了个假的。
 */
export function hasSep(s) { return VARIANT_SEP_RE.test(String(s == null ? '' : s)) }

/**
 * 按主体归组（顺序稳定：组的先后 = 组内第一张卡在原数组里的下标）。
 * @returns [{ base, items: [{ c, i }], parent: { c, i } | null, first, variantCount }]
 *   parent = 名字正好等于 base 的那张「父卡」；没有则为 null（调用方可据此提示「本组缺规范档案」）
 */
export function groupCards(list) {
  const src = Array.isArray(list) ? list : []
  const map = new Map()
  src.forEach((c, i) => {
    const base = baseOf(c && c.name)
    let g = map.get(base)
    if (!g) { g = { base: base, items: [], parent: null }; map.set(base, g) }
    g.items.push({ c: c, i: i })
  })
  const out = []
  map.forEach(g => {
    g.parent = g.items.find(o => !isVariant(o.c && o.c.name)) || null
    g.first = g.items[0].i
    g.variantCount = g.items.filter(o => isVariant(o.c && o.c.name)).length
    out.push(g)
  })
  return out
}

/**
 * 档案块（发给大模型的 `characters` / `scenes`）：**每个主体只产出一行**，键用主体名（baseOf）。
 * 🔴 用主体名而不是卡名：分镜的 chars / continuity 里写的是主体名，两边对不上模型就会当成两个人。
 * 档案优先级：父卡（且非空）→ 组内第一份非空档案 → 父卡（空也发）→ 组内第一张。
 */
export function groupProfiles(list) {
  const out = []
  for (const g of groupCards(list)) {
    const cards = g.items.map(o => o.c).filter(Boolean)
    const nonEmpty = (c) => !!(c && String(c.prompt || '').trim())
    let pick = (g.parent && nonEmpty(g.parent.c)) ? g.parent.c : null
    if (!pick) pick = cards.find(nonEmpty) || (g.parent && g.parent.c) || cards[0] || null
    out.push(g.base + ': ' + String((pick && pick.prompt) || ''))
  }
  return out.join('\n')
}

/**
 * 名字 → 稳定哈希（FNV-1a）。同一主体名在任何会话 / 任何项目里都得到同一个数，
 * 组色才能「同一个主体永远同一个颜色」，而不是按出现顺序忽红忽蓝。
 */
export function hashName(s) {
  const t = String(s == null ? '' : s)
  let h = 2166136261
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * 主体组色相板（8 档循环）。
 * 只给「有多张卡的主体组」上色 —— 单张卡保持原有配色，避免满屏花。
 * 🔴 2026-10-08（Dragon）二改：从「贴近蓝紫基调的 8 个近邻色」改成**等距 45° 的 8 个色相** ——
 *    用户要求「不同组颜色区别大点」（该色现只落在**边框**与名称徽标上，不染底色），
 *    而旧板里 210/190（蓝 vs 青蓝）、265/290（紫 vs 品红）、25/45（橙 vs 黄橙）只差 20°，
 *    哈希随机配对时两组看着几乎同色。等距之后任意两组的色差都 ≥45°，是「哈希取色」的最大区分度。
 */
export const GROUP_HUES = [20, 65, 110, 155, 200, 245, 290, 335]

/** 主体名 → 组色相（hsl 的 H 分量，0-360） */
export function hueOf(name) {
  return GROUP_HUES[hashName(baseOf(name)) % GROUP_HUES.length]
}
