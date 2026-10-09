'use strict';
/**
 * 视频档位解析（声明式）—— UI 与调度只认「档位 × 支路」，不认任何模型细节。
 *
 * 档位表本身**不再写在这里**，而是属于「模型方案」（electron/profiles/<id>.json 的 tiers 段）：
 * 换模型 = 换方案文件，本模块一行都不用改。
 *
 * 档位（UI 只显示名字，不透出任何模型 / 参数信息）：
 *   fast     速度优先 —— 8 步蒸馏（非 768p 版），批量验证节奏用；没有该文件才退 4 步
 *   balanced 平衡（默认）—— 8 步蒸馏，质量接近上限、速度快
 *   hq       质量优先 —— 基础模型直跑 20 步，质量上限最高、最慢
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
 * @returns {{key,label,desc,default:boolean}[]} 供 IPC 透传给渲染层
 */
function list(p) {
  const d = defaultTier(p);
  return orderOf(p).map(k => ({
    key: k,
    label: labelOf(p)[k] || k,
    desc: descOf(p)[k] || '',
    default: k === d
  }));
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
  videoProfile, tiersOf, orderOf, labelOf, descOf,
  // —— 兼容旧导出（按当前激活的视频方案求值）——
  get TIERS() { return tiersOf(null); },
  get LABELS() { return labelOf(null); },
  get DESCS() { return descOf(null); },
  get TIER_ORDER() { return orderOf(null); },
  get DEFAULT_TIER() { return defaultTier(null); }
};
