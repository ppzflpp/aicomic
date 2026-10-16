/**
 * 脏标记（上游变化提示）共享工具。
 * 链路：章节改 → 改编稿⚠；改编稿改 → 角色&场景⚠ + 分镜⚠；
 *       分镜行改 → 本行提示词⚠；提示词/素材图改 → 本行视频⚠。
 * 规则：重新生成后提示消失；不处理则一直在；点击提示本身也消失（ack 持久化）。
 */

/** 当前集的 revs 计数器（revs.json，随 getEpisodeFull 返回） */
export function revsOf(st) {
  return (st.current && st.current.revs) || {}
}

/** 修改并持久化 revs 计数器（fn 就地改对象） */
export async function touchRevs(st, fn) {
  const ep = st.current
  if (!ep) return
  const revs = JSON.parse(JSON.stringify(ep.revs || {}))
  fn(revs)
  ep.revs = revs
  await st.saveArtifact('revs', revs)
}

/**
 * 模块级脏标记：统一判定 + 文案（各展示块的标题行统一显示，避免各组件各写一套）。
 *  - adapt：章节在上次改编之后又被改过 → 改编块标题后提示
 *  - chars：改编稿在档案（角色&场景）生成之后又被改过 → 角色&场景块标题后提示
 *  - shots：改编稿在分镜生成之后又被改过 → 分镜脚本块标题后提示
 */
export const MODULE_STALE_KINDS = {
  adapt: { ackKey: 'ackAdaptedChapter', text: '章节已修改 · 建议重新改编（重新改编后消失）' },
  chars: { ackKey: 'ackCharsAdapted', text: '改编稿已修改 · 建议重新出图（重新生成后消失）' },
  shots: { ackKey: 'ackShotsAdapted', text: '改编稿已修改 · 分镜可能需要重新生成（重新生成后消失）' }
};

/** 该模块是否有未处理的脏标记（revs 计数器比对，纯读取） */
export function moduleStale(revs, kind) {
  const r = revs || {}
  const def = MODULE_STALE_KINDS[kind];
  if (!def) return false;
  if (kind === 'adapt') {
    return r.adaptedChapter != null && r.chapter != null &&
           r.adaptedChapter !== r.chapter && r[def.ackKey] !== r.chapter;
  }
  return r.adapted != null && r.shotsAdapted != null &&
         r.shotsAdapted !== r.adapted && r[def.ackKey] !== r.adapted;
}

/** 点击脏标签 → 记下「已提示过」的版本（不重新生成也让它消失） */
export async function ackModule(st, kind) {
  const def = MODULE_STALE_KINDS[kind];
  if (!def) return;
  const r = revsOf(st);
  const cur = (kind === 'adapt' ? r.chapter : r.adapted) || 0;
  await touchRevs(st, x => { x[def.ackKey] = cur; });
}

/** 签名相等判断（key 顺序无关的浅比较，值只可能是数字/字符串/扁平对象） */
export function sigEq(a, b) {
  const norm = (o) => {
    o = o || {}
    return Object.keys(o).sort().map(k => k + '=' + JSON.stringify(o[k])).join('&')
  }
  return norm(a) === norm(b)
}

/* ------------------------------------------------------------------ *
 * 素材签名 v2（2026-10-16）：参考图的**顺序**与**文件内容**也算签名的一部分
 *
 *   为什么加：脏标记（「分镜/素材已变化」）原先只看两样 —— 分镜版本号、以及「这张图出自
 *   哪张卡的哪个版本」。于是两种真实操作不会使提示词/视频标脏：
 *     ① 参考图**拖动排序**：顺序决定提示词里 <Picture N> 的编号，模型看到的第一张图变了，
 *        但路径集合没变、数量没变、卡片版本没变 → 旧签名一模一样。
 *     ② **手工换图**（拿另一张图覆盖掉同名文件 / 换掉素材目录里的图）：卡片版本不动。
 *   现在把「有序的 路径#文件指纹」串成一条摘要塞进签名 → 两者都能发现。
 *
 *   🔴 兼容存量数据的做法：**不动老字段**（shotRev / assets / refs 原样保留），只**新增**
 *      `v` 与 `order`。于是 sigSame() 对「升级前生成的签名」（没有 order）只比老字段 ——
 *      绝不会因为「签名格式升级了」就把全库已生成的提示词一律判成过期（那种全屏假 ⚠
 *      比漏报更难查：用户会直接不信任这个提示）。新维度的判定从**下一次生成**开始生效。
 * ------------------------------------------------------------------ */

/** 当前签名格式版本（老记录没有这个字段 = v1） */
export const SIG_V = 2

/** 老签名（v1）能表达的那几个字段 —— 只有这些参与「跨版本」比较 */
const SIG_LEGACY_KEYS = ['shotRev', 'promptRev', 'assets', 'refs']

/** 取签名的老字段视图（v2 签名也照取，值原样 —— v2 没改过这几个字段的语义） */
export function sigLegacyView(s) {
  const o = {}
  for (const k of SIG_LEGACY_KEYS) if (s && s[k] !== undefined) o[k] = s[k]
  return o
}

/** 短摘要（djb2 → base36）：把一串长指纹压成几个字符，落库的签名字段不至于膨胀 */
export function shortHash(str) {
  let h = 5381
  const s = String(str == null ? '' : str)
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * 参考素材的**有序**指纹：`图1#指纹,图2#指纹|视频…|首帧…|尾帧…` 的摘要。
 * @param {object} refs  prompts[i].refs（{ images, videos, first, last }）
 * @param {(p:string)=>string} sigOf 绝对路径 → 文件指纹（来自主进程 files:sig；拿不到回空串）
 * 顺序是语义的一部分（<Picture N> 编号），所以**绝不能**排序后比较；
 * 文件名/指纹任一变化都会改变摘要 —— 换图、换顺序、增删、素材被删（指纹变空）都会命中。
 */
export function refOrderSig(refs, sigOf) {
  const r = refs || {}
  const one = (p) => (p ? String(p) + '#' + (String((sigOf && sigOf(p)) || '')) : '-')
  const list = []
  for (const p of (r.images || [])) list.push('i' + one(p))
  for (const p of (r.videos || [])) list.push('v' + one(p))
  list.push('f' + one(r.first))
  list.push('l' + one(r.last))
  return shortHash(list.join('|'))
}

/**
 * 两个签名是否等价 —— 脏标记的唯一判据入口（提示词与视频共用）。
 *  - 老字段（分镜版本 / 卡片版本 / 素材数量）必须一致；
 *  - `order` 是 v2 新增的**内容**维度：**任一侧没有就不比**（老签名没记过；指纹还没取回来时
 *    当前签名也没有）→ 都按「比不出来 = 不算变」处理，宁可漏报也不放假警报。
 */
export function sigSame(a, b) {
  if (!a || !b) return false
  if (!sigEq(sigLegacyView(a), sigLegacyView(b))) return false
  const oa = a.order, ob = b.order
  if (oa == null || ob == null) return true
  return oa === ob
}

/**
 * 脏标记三态：签名不同 **且** 用户没点掉 → 显示提示。
 * @param {object} rec 生成时记录的签名（p._sig / v._sig）
 * @param {object} cur 当下应该匹配的签名
 * @param {object} ack 用户点掉提示时记下的签名（p._ack / v._ack）
 */
export function sigStale(rec, cur, ack) {
  if (!sigSame(rec, cur)) return !ack || !sigSame(ack, cur)
  return false
}

/**
 * ⚠ 提示里说清**哪里变了**（分镜 / 素材），别让用户对着一句笼统的「已变化」自己猜。
 * 只在确定要显示提示时调用（`staleOk` 已为真）；比不出来时回落到笼统说法。
 */
export function staleReason(rec, cur) {
  if (!rec || !cur) return ''
  const lr = sigLegacyView(rec), lc = sigLegacyView(cur)
  const shotChanged = lr.shotRev !== lc.shotRev
  const assetsChanged = !sigEq(lr.assets, lc.assets) || !sigEq(lr.refs, lc.refs)
  const orderChanged = rec.order != null && cur.order != null && rec.order !== cur.order
  const byShot = shotChanged || (!assetsChanged && !orderChanged)
  const byAsset = assetsChanged || orderChanged
  if (byShot && byAsset) return '分镜与参考素材都已变化'
  if (byAsset) return '参考素材已变化'
  return '分镜已变化'
}
