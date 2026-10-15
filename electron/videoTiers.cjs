'use strict';
/**
 * 视频档位解析（声明式）—— UI 与调度只认「档位 × 支路」，不认任何模型细节。
 *
 * 档位表本身**不再写在这里**，而是属于「模型方案」（electron/profiles/<id>.json 的 tiers 段）：
 * 换模型 = 换方案文件，本模块一行都不用改。
 *
 * 档位（UI 只显示名字，不透出任何模型 / 参数信息）：
 *   fast     速度优先 —— 4 步加速模型 + 小画布，批量验证节奏用
 *   balanced 平衡（默认）—— 8 步加速模型 + 中画布，日常出片首选
 *   hq       质量最优 —— 8 步加速模型 + 大画布，细节最足、最慢（关键镜头 / 终稿）
 *
 * 🔴 档位定义（挂哪个 LoRA / 几步 / 注不注 shift）全在 electron/profiles/h3.json 的 tiers 段，
 *   换档位 = 改那份 JSON，本模块一行都不用改。推荐画布在 tierCanvas 段，随 list() 一起下发。
 *
 * 🔴 2026-10-15 重设计**参考图支路**（ref2v）三档 —— 三档都经过实测（2026-10-15.md §20/§21/§22）：
 *   速度优先 = ref2v 4step（544p 训）  + 4 步 + 不注 shift + 480×864 族     →  2.4 min ✅
 *   平衡     = fl2v  8step（544p 训）  + 8 步 + shift 12/3  + 544×960 族     →  3.4 min ✅
 *   质量最优 = ref2v 8step（768p 训）  + 8 步 + shift 6/3   + 1344×768 族    → 16   min ✅
 *
 * 🔴 **决定画质的第一要素是「LoRA 的训练分辨率 = 画布分辨率」，不是步数、也不是 σ-shift**（实测）：
 *   · 768p 训练的 LoRA 配 768p 画布 → 正常
 *   · 768p 训练的 LoRA 配**小画布**（768p 的 40% 像素量）→ **镜头构图漂到全景、人物变得很小**
 *     （今早的 A0：8 步 LoRA + 480×864，画面飘、码率只有 780k；改成 768×1344 立刻恢复，B3）
 *   · 544p 训练的 LoRA 配小画布（79%）→ 正常
 *   · σ-shift 在 6/3 ↔ 12/3 之间换来换去，对上面这些结论**没有影响**（B1/B2 做过夹逼对照）
 *   ⇒ 每个档位的推荐画布写在 tierCanvas 段随档位下发，**前端不许硬编码这张表**。
 *
 * ⚠️ **混配（fl2v 的 LoRA 挂 ref2va 底模）实测可行**：B4 实验里 fl2v_8step(544p) 挂 ref2va
 *   出片正常、构图不漂、画质还是那批里最好的（2026-10-15.md §22）。所以本模块的 resolve()
 *   **只按正则挑文件、不做支路校验** —— 「fl2v 配 fl2va」是**底模**的约束，不是 LoRA 的约束。
 *   （平衡档用的就是这条：ref2v 系没有 8 步 + 544p 训练的文件，借 fl2v 的那个。）
 *
 * ⚠️ fl2v（**无参考图**）支路本次**未重新设计**，仍是旧三档（4 步 / 8 步都用 768p 训的那个，
 *   hq 仍直跑 20 步）。待办：无参考图场景缺「4 步 + 544p 训练」的 LoRA，小画布档无从谈起。
 *   ⚠️ minimax_h3_fl2v_turbo_8step_v1.0（544p）已于 2026-10-15 从 models/loras-disabled/
 *   **搬回 loras/**（Dragon 为了平衡档）—— 搬回后它同时也是 fl2v 支路两档的兜底候选。
 *
 * ⚠️ 2026-10-14 移走并**真删**了 minimax_h3_turbo_v4_step600：它不属 fl2v / ref2v 任何系列，
 *   且与 pruned int8 底模的 adaln_proj 形状不匹配 —— ComfyUI 会静默跳过该层、任务照样 success。
 *
 * ⚠️ 每档的末尾都留了「次一档」兜底：对应 LoRA 没装时退到还能用的那一档，
 *   而不是掉进「候选全缺 → 基础模型 20 步」的兜底（那会让「速度优先」悄悄变成最慢的）。
 *
 * 支路（branch，与生成模式一一对应，由「有没有参考媒体」决定，见方案的 branches 段）：
 *   fl2v  —— 文生视频 / 首尾帧
 *   ref2v —— 参考图 / 参考视频
 *
 * 每支路是一个候选列表（按顺序匹配，第一个文件命中的生效）：
 *   match  —— LoRA 文件名正则；null = 基础模型直跑（不挂 LoRA）
 *   steps  —— 采样步数（蒸馏 LoRA 必须等于其训练步数，多一步少一步都毁画面）
 *   shift  —— [视频σ, 音频σ]；蒸馏训练 shift 与模型默认不同时才注入 σ-shift 节点；
 *             null = 模型默认调度，不注入
 *   sigmas —— 直接给采样序列（逗号分隔的 σ 列表，模板用 ManualSigmas 节点接）。
 *             蒸馏模型的 sigma 网格是训练时定死的（LTX-2.5），给序列比给步数更准确；
 *             走 LoRA 步数派的模型（H3）不声明这一项。
 *
 * 🔴 蒸馏 LoRA 的「步数 / shift」是训练时定死的配对参数，换任何一个都必须同步换另一个。
 */
const profiles = require('./profiles.cjs');

/** 取生效的视频方案（不传则用当前激活的那份） */
function videoProfile(p) { return p || profiles.active('video'); }

function tiersOf(p) { const v = videoProfile(p); return (v && v.tiers) || {}; }
function orderOf(p) {
  const v = videoProfile(p);
  const order = (v && Array.isArray(v.tierOrder)) ? v.tierOrder.filter(k => tiersOf(v)[k]) : [];
  return order.length ? order : Object.keys(tiersOf(v));
}
function labelOf(p) { const v = videoProfile(p); return (v && v.tierLabels) || {}; }
function descOf(p) { const v = videoProfile(p); return (v && v.tierDescs) || {}; }

/** 方案声明的默认档位（拿不到就取第一个档位） */
function defaultTier(p) {
  const v = videoProfile(p);
  const d = v && v.defaultTier;
  const order = orderOf(v);
  return (d && tiersOf(v)[d]) ? d : (order[0] || 'balanced');
}

/**
 * 对外档位清单（渲染层下拉直接用这个渲染，绝不硬编码档位名）。
 * 换模型 / 改档位时只改方案的 tiers 段，UI 与调度逻辑都不动。
 *
 * 🔴 2026-10-15：list() 额外带出 `canvas`（方案 tierCanvas 段：档位 → 比例 → 推荐画布）。
 *    它是「档位 + 比例 → 图片 / 视频 / 成片三个分辨率推荐值」的**唯一真相源** ——
 *    前端不硬编码这张表，否则改档位时两处会漂。键不存在时为 {}，前端当「无推荐」处理。
 *
 * ⚠️ canvas 里的画布必须与 tiers 里该档位实际挂的那个 LoRA 的**训练分辨率**一致：
 *    768p 训练的 LoRA 配小画布会让镜头构图漂到全景（2026-10-15 实测，见 2026-10-15.md §21）。
 *
 * @returns {{key,label,desc,default:boolean,canvas:object}[]} 供 IPC 透传给渲染层
 */
function list(p) {
  const v = videoProfile(p);
  const d = defaultTier(p);
  const canvasOf = (v && v.tierCanvas) || {};
  return orderOf(p).map(k => ({
    key: k,
    label: labelOf(p)[k] || k,
    desc: descOf(p)[k] || '',
    default: k === d,
    canvas: canvasOf[k] || {}
  }));
}

/** 某档位在指定比例下的推荐画布（渲染层联动用）；没声明 / 比例不支持 → null */
function canvasFor(tier, aspect, p) {
  const v = videoProfile(p);
  const c = (v && v.tierCanvas && v.tierCanvas[normalizeTier(tier, v)]) || {};
  const hit = c[String(aspect || '').trim()];
  return hit || null;
}

/**
 * 某档位**可接受**的画布清单（tierCanvas[x].accept）。
 * 🔴 为什么不能拿「必须等于推荐值」当判据：同档位的两个候选画布像素量差 26%（544×960 vs 864×480），
 *    而该档挂的加速模型是 544p 训练的 —— 实测**两者都正常**（480×864 是 79%，C0 验证过）。
 *    所以「与推荐值不等」≠「有问题」，只有落到 accept 之外才是真不匹配（会构图漂到全景）。
 *    无声明 → 空数组 = 「不拦，一律放行」（宁可放过，不可误禁）。
 */
function canvasAccept(tier, p) {
  const v = videoProfile(p);
  const c = (v && v.tierCanvas && v.tierCanvas[normalizeTier(tier, v)]) || {};
  return Array.isArray(c.accept) ? c.accept.slice() : [];
}

/** 非法 / 缺失档位回默认档 */
function normalizeTier(tier, p) {
  const t = String(tier || '').trim().toLowerCase();
  return tiersOf(p)[t] ? t : defaultTier(p);
}

/** 安全编译用户配置里的正则（写错了不能让生成整个挂掉） */
function safeRe(src) {
  if (!src) return null;
  try { return new RegExp(src, 'i'); } catch (_) { return null; }
}

/**
 * 解析档位 → 实际执行参数。
 * @param {object|null} p          模型方案（null = 当前激活的视频方案）
 * @param {string} tier            档位 key（非法值回默认档）
 * @param {string} family          支路 key（见方案的 branches 段）
 * @param {string[]} loraFiles     LoRA 目录文件名列表（models.cjs 提供）
 * @returns {{tier, family, lora, steps, shift, downgraded}}
 *    lora       —— LoRA 文件名；null = 基础模型直跑（工作流摘掉 LoRA 节点）
 *    shift      —— [v, a] 需注入 σ-shift 节点；null = 模型默认调度，不注入
 *    downgraded —— true = 候选 LoRA 全缺，已兜底成基础模型（按方案 params.steps）
 */
function resolve(p, tier, family, loraFiles) {
  const v = videoProfile(p);
  const t = normalizeTier(tier, v);
  const table = tiersOf(v)[t] || {};
  const fam = Array.isArray(table[family]) ? table[family] : (Object.values(table)[0] || []);
  const files = Array.isArray(loraFiles) ? loraFiles : [];
  const baseSteps = Number((v && v.params && v.params.steps) || 20) || 20;

  for (const spec of fam) {
    if (!spec || !spec.match) {
      return {
        tier: t, family, lora: null, steps: Number(spec && spec.steps) || baseSteps,
        shift: null, sigmas: (spec && spec.sigmas) || null, downgraded: false
      };
    }
    const re = safeRe(spec.match);
    const hit = re ? files.find(f => re.test(String(f).split(/[\\/]/).pop())) : null;
    if (hit) {
      return {
        tier: t, family, lora: hit, steps: Number(spec.steps) || baseSteps,
        shift: spec.shift || null, sigmas: spec.sigmas || null, downgraded: false
      };
    }
  }
  // 候选 LoRA 全缺：兜底基础模型。步数必须抬到基础步数 —— 4/8 步打在无蒸馏的底模上画面会崩
  return { tier: t, family, lora: null, steps: baseSteps, shift: null, sigmas: null, downgraded: true };
}

/** 兼容旧签名（老调用 / 离线自测）：等价于「用当前激活的视频方案解析」 */
function resolveTier(tier, family, loraFiles) { return resolve(null, tier, family, loraFiles); }

/**
 * 按「有没有参考媒体」判本次走哪条支路。
 * 支路名不写死在代码里 —— 由方案的 branches 段声明（when: 'ref' | 'noref'）。
 */
function branchKey(hasRef, p) {
  const v = videoProfile(p);
  const bs = (v && Array.isArray(v.branches)) ? v.branches : [];
  const hit = bs.find(b => b && b.when === (hasRef ? 'ref' : 'noref'));
  return (hit && hit.key) || (hasRef ? 'ref' : 'noref');
}

/** 支路显示名（日志用） */
function branchLabel(key, p) {
  const v = videoProfile(p);
  const bs = (v && Array.isArray(v.branches)) ? v.branches : [];
  const hit = bs.find(b => b && b.key === key);
  return (hit && hit.label) || key;
}

module.exports = {
  defaultTier, list, normalizeTier, resolve, resolveTier, branchKey, branchLabel,
  videoProfile, tiersOf, orderOf, labelOf, descOf, canvasFor, canvasAccept,
  // —— 兼容旧导出（按当前激活的视频方案求值）——
  get TIERS() { return tiersOf(null); },
  get LABELS() { return labelOf(null); },
  get DESCS() { return descOf(null); },
  get TIER_ORDER() { return orderOf(null); },
  get DEFAULT_TIER() { return defaultTier(null); }
};
