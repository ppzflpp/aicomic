'use strict';
/**
 * 视频生成档位注册表（声明式）—— UI 与调度只认「档位 × 模型族」，不认任何模型细节。
 * 新增模型库 = 在这里加条目（必要时加工作流模板），SettingsPanel / inference 零改动。
 *
 * 档位（UI 只显示这三个名字，不透出任何模型 / 参数信息）：
 *   fast     速度优先 —— 4 步蒸馏，批量验证节奏用
 *   balanced 平衡（默认）—— 8 步蒸馏，质量接近上限、速度快
 *   hq       质量优先 —— 基础模型直跑 20 步，质量上限最高、最慢
 *
 * family（模型族，与生成模式一一对应，由「有没有参考媒体」决定）：
 *   fl2v  —— 文生图 / 首尾帧（MiniMaxH3ImageToVideo 支路）
 *   ref2v —— 参考图 / 参考视频（MiniMaxH3ReferenceToVideo 支路）
 *
 * 每族是一个候选列表（按顺序匹配，第一个文件命中的生效）：
 *   re    —— LoRA 文件名正则；null = 基础模型直跑（不挂 LoRA）
 *   steps —— 采样步数（蒸馏 LoRA 必须等于其训练步数，多一步少一步都毁画面）
 *   shift —— [视频σ, 音频σ]；蒸馏训练 shift 与模型默认（12/3）不同时才注入
 *            MiniMaxH3SigmaShift 节点；null = 模型默认调度，不注入
 *
 * 🔴 蒸馏 LoRA 的「步数 / shift / 参考图缩放」是训练时定死的配对参数：
 *    换任何一个都必须同步换其余两个（来源：ModelTC/Minimax-H3-Turbo 规范表）。
 *    参考图缩放固定 match（蒸馏训练用 match），不随档位变化。
 */

const TIERS = {
  fast: {
    fl2v: [
      { re: /fl2v.*4step/i, steps: 4, shift: [6, 3] },          // 4-step 768p（v1.0）
      { re: /fl2v.*8step/i, steps: 8, shift: [12, 3] },         // 没有 4step 时的退路
    ],
    ref2v: [
      { re: /ref2v/i, steps: 4, shift: null },                  // ref2v 4-step v0.1（12/3 = 模型默认）
    ],
  },
  balanced: {
    fl2v: [
      { re: /fl2v.*8step.*768p/i, steps: 8, shift: [6, 3] },    // 首选 768p 训练版（官方 Studio 同款）
      { re: /fl2v.*8step/i, steps: 8, shift: [12, 3] },         // 只有 544p 版时按它的训练值
    ],
    ref2v: [
      { re: /ref2v/i, steps: 4, shift: null },                  // 官方暂无 ref2v 8-step，出了解锁即升级
    ],
  },
  hq: {
    fl2v:  [ { re: null, steps: 20, shift: null } ],            // 基础模型直跑，官方基线步数
    ref2v: [ { re: null, steps: 20, shift: null } ],
  },
};

const DEFAULT_TIER = 'balanced';

/** 档位显示名（日志 / toast 用，不含模型信息） */
const LABELS = { fast: '速度优先', balanced: '平衡', hq: '质量优先' };

/**
 * 对外档位清单（渲染层下拉直接用这个渲染，绝不硬编码档位名）。
 * 新增档位 / 换模型库时，只改这里，UI 与调度逻辑都不动。
 */
const TIER_ORDER = ['fast', 'balanced', 'hq'];
const DESCS = {
  fast: '最快出片，适合批量验证分镜节奏',
  balanced: '质量接近最佳、速度适中',
  hq: '质量上限最高，出片最慢，适合关键镜头与终稿',
};

/** @returns {{key,label,desc,default:boolean}[]} 供 IPC 透传给渲染层 */
function list() {
  return TIER_ORDER.map(k => ({
    key: k, label: LABELS[k] || k, desc: DESCS[k] || '', default: k === DEFAULT_TIER,
  }));
}

/** 非法 / 缺失档位回默认档 */
function normalizeTier(tier) {
  const t = String(tier || '').trim().toLowerCase();
  return TIERS[t] ? t : DEFAULT_TIER;
}

/**
 * 解析档位 → 实际执行参数。
 * @param {string} tier      档位 key（非法值回默认档）
 * @param {string} family    'fl2v' | 'ref2v'
 * @param {string[]} loraFiles  LoRA 目录文件名列表（models.cjs 提供）
 * @returns {{tier, family, lora, steps, shift, downgraded}}
 *    lora       —— LoRA 文件名；null = 基础模型直跑（工作流摘掉 LoRA 节点）
 *    shift      —— [v, a] 需注入 MiniMaxH3SigmaShift；null = 模型默认调度，不注入
 *    downgraded —— true = 候选 LoRA 全缺，已兜底成基础模型 20 步
 */
function resolveTier(tier, family, loraFiles) {
  const t = normalizeTier(tier);
  const fam = TIERS[t][family] || TIERS[t].fl2v;
  const files = Array.isArray(loraFiles) ? loraFiles : [];
  for (const spec of fam) {
    if (!spec.re) {
      return { tier: t, family, lora: null, steps: spec.steps, shift: spec.shift || null, downgraded: false };
    }
    const hit = files.find(f => spec.re.test(String(f).split(/[\\/]/).pop()));
    if (hit) {
      return { tier: t, family, lora: hit, steps: spec.steps, shift: spec.shift || null, downgraded: false };
    }
  }
  // 候选 LoRA 全缺：兜底基础模型。步数必须抬到 20 —— 4/8 步打在无蒸馏的底模上画面会崩
  return { tier: t, family, lora: null, steps: 20, shift: null, downgraded: true };
}

module.exports = { TIERS, LABELS, TIER_ORDER, DESCS, DEFAULT_TIER, normalizeTier, resolveTier, list };
