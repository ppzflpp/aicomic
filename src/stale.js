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
 *  - adapt：章节在上次改编之后又被改过 → 漫剧改编块标题后提示
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
