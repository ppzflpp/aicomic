'use strict';
/**
 * 大模型来源（provider）—— 决定某个环节走「本地 llama-server」还是「云端 OpenAI 兼容 API」。
 *
 * 为什么要这一层：全项目的 LLM 调用只有一个收口（前端 window.studio.llmChat →
 * IPC infer:llm → inference.llmChat），而它请求的是 POST <端点>/v1/chat/completions。
 * 本地 llama-server 与云端（DeepSeek 等）都是 OpenAI 兼容，所以「换后端」本质上
 * 只是换 baseUrl + apiKey + model —— 抽象层可以很薄。
 *
 * 粒度 = 环节（stage），共 7 个，与调用点一一对应：
 *   adapt   阶段2 内容AI优化（改编稿）      StageAdapt.vue
 *   shots   阶段3 分镜脚本                StageShots.vue
 *   chars   阶段4 角色&场景档案            StageChars.vue
 *   outfits 阶段4 装扮清单（换装识别）      StageChars.vue（2026-10-16 新增）
 *   library 阶段4 素材库提示词（单条）      StageLibrary.vue
 *   prompt  阶段5 H3提示词                StageShots.vue
 *   split   拆分镜头重写                  StageShots.vue
 *
 * 三个约定（2026-10-15 用户拍板）：
 *   ① 设置页是**唯一持久入口**；阶段页上的切换只影响本次打开（不落库）。
 *   ② 云端失败**直接报错停在原地**，绝不偷偷回退本地（免得「结果来自哪个模型」说不清）。
 *   ③ 密钥用主进程的 safeStorage 加密后落库（注入式：本模块不直接 require('electron')，
 *      离线自测时可只跑纯函数）。
 */

/** 环节（顺序即设置页展示顺序）；label 统一「菜单名·功能名」格式（2026-10-22 Dragon 拍板） */
const STAGES = [
  { id: 'adapt', label: '创作台·剧本改编' },
  { id: 'shots', label: '创作台·分镜脚本' },
  { id: 'chars', label: '创作台·角色与场景' },
  { id: 'outfits', label: '创作台·装扮清单' },
  { id: 'library', label: '素材库·提示词' },
  { id: 'prompt', label: '创作台·分镜提示词' },
  { id: 'split', label: '创作台·拆分镜头重写' },
  // 视频生成·提示词重写（2026-10-22）：独立环节，不跟随「分镜提示词」，
  // 用户可单独决定视频生成里的「提示词重写」走云端还是本地。
  { id: 'vidgen-rewrite', label: '视频生成·提示词重写' },
  // 🔴 图片生成·提示词反推（reverse）恢复为独立环节（2026-10-23 第二次调整）：
  //    用户明确要求「反推单独拆出来」，不再跟随「素材库·提示词」。独立开关，
  //    用户可在设置页单独决定「反推提示词」走云端还是本地。
  { id: 'reverse', label: '图片生成·提示词反推' }
];
const STAGE_IDS = STAGES.map(s => s.id);

// 默认云端：DeepSeek V4.1 Flash（当前主力模型）。
// 原默认 deepseek-chat 已于 2026-07-24 15:59 UTC 完全退役（现仅作兼容别名，随时可能下线）。
const DEFAULT_CLOUD = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

const K_STAGE = (id) => 'llm.provider.' + id;
const K_BASE = 'llm.cloud.baseUrl';
const K_MODEL = 'llm.cloud.model';
const K_KEY = 'llm.cloud.key';

let db = null;
/* 加解密实现由主进程注入（safeStorage）；离线自测下为 null，此时退回 base64 标记存储 */
let _crypto = null;

function init(dbRef, cryptoProvider) {
  db = dbRef;
  // 只有**显式传入**加解密实现时才改写它（传 null 也算显式 = 撤掉，退回 base64 兜底）。
  // 这样 inference.init(db) 这种「只补 db」的调用不会把 ipc 层注入的 safeStorage 抹掉。
  if (cryptoProvider !== undefined) _crypto = cryptoProvider || null;
}

/** 环节标识归一化：接受环节 id，也兼容调用点里原有的中文 label（含「阶段N xxx」形态） */
function normalizeStage(v) {
  const s = String(v || '').trim();
  if (!s) return 'shots';
  if (STAGE_IDS.includes(s)) return s;
  // 🔴 反推恢复独立环节（2026-10-23 第二次调整）：'reverse' / 「反推」归一化到自己的 id，不再重定向 library。
  //    注意「反推」必须排在 /素材/ 规则之前，否则会被 /阶段4|角色|素材/ 吞成 chars。
  if (s === 'reverse' || /反推/.test(s)) return 'reverse';
  if (/视频生成|视频.*重写/.test(s)) return 'vidgen-rewrite';  // 也必须在「提示词」规则之前
  if (/阶段2|改编/.test(s)) return 'adapt';
  if (/阶段3|分镜脚本/.test(s)) return 'shots';
  if (/装扮/.test(s)) return 'outfits';
  if (/阶段4|角色|素材/.test(s)) return 'chars';
  if (/拆分/.test(s)) return 'split';
  if (/阶段5|提示词/.test(s)) return 'prompt';
  return 'shots';
}

function _get(k) { return db ? db.getSetting(k) : ''; }
function _set(k, v) { if (db) db.setSetting(k, v); }

/** 密钥加密存储：safeStorage 可用则用它，否则退化成 base64（仅离线自测场景会走到） */
function encryptKey(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (_crypto) { try { return 'enc:' + _crypto.encrypt(s); } catch (_) { /* 落到 base64 */ } }
  return 'raw:' + Buffer.from(s, 'utf8').toString('base64');
}

function decryptKey(stored) {
  const v = String(stored || '');
  if (v.startsWith('enc:')) {
    if (!_crypto) return '';
    try { return _crypto.decrypt(v.slice(4)); } catch (_) { return ''; }
  }
  if (v.startsWith('raw:')) {
    try { return Buffer.from(v.slice(4), 'base64').toString('utf8'); } catch (_) { return ''; }
  }
  return '';
}

/** 界面上展示用的掩码（前 6 后 4；短 key 只留前 2） */
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 10 ? s.slice(0, 2) + '****' : s.slice(0, 6) + '…' + s.slice(-4);
}

/** 当前配置（给设置页）：每个环节的来源 + 云端地址/模型/是否已存密钥（不回传明文） */
function getConfig() {
  const stages = {};
  STAGE_IDS.forEach(id => { stages[id] = _get(K_STAGE(id)) === 'cloud' ? 'cloud' : 'local'; });
  // 🔴 「有没有 Key」必须看**能不能解密出非空明文**，而不是「库里有没有值」：
  //    safeStorage 的 AES 密钥存在 <userData>\Local State 里，换 userData（开发版 ↔ 打包版、
  //    重装、清过系统数据）就解不开了。若只判断「库里有值」，界面会显示「已保存」，
  //    而生成时却报「未配置 API Key」—— 用户完全无从下手（2026-10-15 实测踩到）。
  const stored = _get(K_KEY);
  const plain = stored ? decryptKey(stored) : '';
  return {
    stages,
    stagesMeta: STAGES.map(s => ({ id: s.id, label: s.label })),
    cloud: {
      baseUrl: _get(K_BASE) || DEFAULT_CLOUD.baseUrl,
      model: _get(K_MODEL) || DEFAULT_CLOUD.model,
      hasKey: !!plain,
      keyBroken: !!stored && !plain,     // 有密文但解不开 → 界面提示「重新粘贴一次」
      keyMask: plain ? maskKey(plain) : ''
    }
  };
}

/** 设置某环节的来源；返回最新配置 */
function setStage(id, provider) {
  const sid = normalizeStage(id);
  _set(K_STAGE(sid), provider === 'cloud' ? 'cloud' : 'local');
  return getConfig();
}

/**
 * 写云端配置。
 * apiKey 语义：undefined/null = 保持原密钥；'' = 清除；非空 = 覆盖。
 */
function setCloud(patch) {
  const p = patch || {};
  if (typeof p.baseUrl === 'string') _set(K_BASE, p.baseUrl.trim() || DEFAULT_CLOUD.baseUrl);
  if (typeof p.model === 'string') _set(K_MODEL, p.model.trim() || DEFAULT_CLOUD.model);
  if (p.apiKey !== undefined && p.apiKey !== null) {
    _set(K_KEY, p.apiKey === '' ? '' : encryptKey(String(p.apiKey).trim()));
  }
  return getConfig();
}

/** 云端配置本身（不看环节设置）—— 连通性测试与「本环节走云端」共用 */
function resolveCloud() {
  return {
    kind: 'cloud',
    stage: '',
    baseUrl: (_get(K_BASE) || DEFAULT_CLOUD.baseUrl).replace(/\/+$/, ''),
    apiKey: decryptKey(_get(K_KEY)),
    model: _get(K_MODEL) || DEFAULT_CLOUD.model
  };
}

/**
 * 某个环节最终用谁 —— llmChat / engine 编排都问这一个函数。
 * @param {string} stage 环节 id（也兼容调用点原有的中文 label）
 * @param {string} [override] 'local' | 'cloud'：阶段页上的**本次运行**覆盖（见 src/llmSource.js）
 */
function resolve(stage, override) {
  const sid = normalizeStage(stage);
  const want = (override === 'cloud' || override === 'local') ? override : _get(K_STAGE(sid));
  if (want !== 'cloud') return { kind: 'local', stage: sid, baseUrl: '', apiKey: '', model: '' };
  return Object.assign(resolveCloud(), { stage: sid });
}

/** 是否至少有一个环节走了云端（设置页/健康检查用来决定要不要提示本地引擎未启） */
function anyCloud() {
  return STAGE_IDS.some(id => _get(K_STAGE(id)) === 'cloud');
}

module.exports = {
  init, STAGES, STAGE_IDS, DEFAULT_CLOUD,
  normalizeStage, getConfig, setStage, setCloud, resolve, resolveCloud, anyCloud,
  encryptKey, decryptKey, maskKey
};
