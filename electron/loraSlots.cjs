'use strict';
/**
 * 视频「动作 / 交互 LoRA」清单 —— 目录即清单，**只服务「视频生成」页**。
 *
 * ■ 为什么单独一个模块（不并进 imgRecipe.cjs）
 *   图片侧的配方里绑着 qwen 模板的节点号、CFG 解锁规则、PEFT 自动转换那一整套；
 *   视频侧只有三件事：列目录、判架构、把 LoRA 串进模型链。
 *   两边混在一起改一个功能会连带另一边的风险 —— 这一版**不动图片模块一行代码**。
 *
 * ■ 目录约定（由方案 profiles/h3.json 的 loraSlots 声明，代码里不写死）
 *   loras/<slot.dir>/<xxx>.safetensors
 *   用户把文件丢进目录就会出现，不用改代码、不用重新打包。
 *
 * ■ 旁边可选的 .json（增强，不是必需）
 *   xxx.safetensors.json 或 xxx.json，两种命名都认：
 *   {
 *     "label": "打斗交互 V2",
 *     "note":  "双人/多人连续对打",
 *     "triggers": ["Unarmed combat interaction.", "Melee weapon interaction."],
 *     "trigger":  "Unarmed combat interaction.",   // 默认拼进提示词的那一句
 *     "branch":   "ref2v",                          // ref2v = 要参考图 / fl2v = 纯文字首尾帧
 *     "weight":   0.65
 *   }
 *   json 里的 weight 是「选中时强度框带出的推荐值」。
 *   🔴 2026-11-17 起，步数 / 采样器 / 分辨率 / 加速 LoRA 一律按用户在「视频质量」档位区
 *      自己选的那档走，LoRA 侧不再覆盖（历史上写过的 requires / canvas 字段已不再生效，
 *      仍可解析但没有任何作用，写进 json 只会误导，别写）。
 *
 * ■ 与图片侧的两处关键差异
 *   1. **不自动转换格式**：实测 H3 系 LoRA 是标准 `diffusion_model.blocks.N...lora_A.weight`，
 *      没有 PEFT 的 `.default.`。这里只报 needFix，不做转换（真遇上再开，避免凭空多一层文件搬运）。
 *   2. **分支（ref2v / fl2v）** 必须标出来：H3 的同一个 LoRA 常分两条支路发布，
 *      文件挂错支路时模型不报错、只是不起作用。
 */
const fs = require('fs');
const path = require('path');
const models = require('./models.cjs');
const loraFormat = require('./loraFormat.cjs');

/** 方案里的槽位声明（数组，方便以后加第二类：运镜 / 白模…） */
function slots(profile) {
  const arr = profile && profile.loraSlots;
  return Array.isArray(arr) ? arr.filter(s => s && s.id) : [];
}

function slotOf(profile, slotId) {
  const id = String(slotId || 'action');
  return slots(profile).find(s => String(s.id) === id) || null;
}

function dirName(profile, slotId) {
  const s = slotOf(profile, slotId);
  return s ? String(s.dir || '').trim() : '';
}

/** 槽位目录的绝对路径；模型根没设 / 没声明目录 → null */
function slotDir(profile, slotId) {
  const sub = dirName(profile, slotId);
  const root = models.resolveDir('loras');
  if (!root || !sub) return null;
  return path.join(root, sub);
}

/**
 * 配置里统一用正斜杠写（`h3-action/xxx.safetensors`），
 * 但 ComfyUI 的 lora_name 候选值在 Windows 上是反斜杠 —— 送进工作流前必须转一次。
 */
function loraName(file) {
  return String(file || '').split('/').join(path.sep);
}

/** 读 LoRA 旁边的同名 .json（可选）；两种命名都认，坏 JSON 不静默吞 */
function metaOf(dir, relName) {
  const cands = [relName + '.json'];
  const bare = String(relName).replace(/\.safetensors$/i, '');
  if (bare !== relName) cands.push(bare + '.json');
  for (const c of cands) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, c), 'utf-8'); } catch (_) { continue; }
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return o;
    } catch (_) {
      console.warn('[loraSlots] 忽略无法解析的元数据：' + c);
    }
  }
  return {};
}

/**
 * 从文件名猜支路（只在没写 json 时兜底）：
 *   ...fl2va... / fl2v → fl2v；...ref2va... / ref2v / r2v → ref2v
 * 猜不出来就留空 —— 空 = 不限制，宁可放过不误拦。
 */
function inferBranch(name) {
  const s = String(name || '');
  if (/fl2v/i.test(s)) return 'fl2v';
  if (/ref2v|r2v/i.test(s)) return 'ref2v';
  return '';
}

function asTriggers(meta, fmtTrigger) {
  const raw = meta.triggers;
  const arr = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  if (arr.length) return arr;
  const one = String(meta.trigger || fmtTrigger || '').trim();
  return one ? [one] : [];
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 列某个槽位的全部可用 LoRA。
 * @returns {{
 *   slotId, label, dir, dirLabel, note,
 *   weight: {default,min,max}, canvas: object|null,
 *   requires: object, max: number, items: Array
 * }}
 */
function list(profile, slotId) {
  const s = slotOf(profile, slotId);
  const id = s ? String(s.id) : String(slotId || 'action');
  const dir = slotDir(profile, id);
  const sub = dirName(profile, id);
  const weight = {
    default: num(s && s.weight && s.weight.default, 0.7),
    min: num(s && s.weight && s.weight.min, 0),
    max: num(s && s.weight && s.weight.max, 1.5)
  };
  const expectArch = String((s && s.arch) || 'h3').trim();
  const out = {
    slotId: id,
    label: String((s && s.label) || '动作 LoRA'),
    dir: sub,
    dirLabel: sub ? ('loras\\' + sub.replace(/\//g, '\\')) : '',
    note: String((s && s.note) || ''),
    weight,
    canvas: (s && s.canvas) || null,
    requires: (s && s.requires) || {},
    max: Math.max(1, num(s && s.max, 1)),
    items: []
  };
  if (!dir || !fs.existsSync(dir)) return out;

  const files = models.listInDir(dir, ['.safetensors'], null);
  for (const f of files) {
    // 自动转换产物 / 隐藏目录不进清单（与图片侧同一约定）
    if (String(f.name).split('/').some(seg => seg.startsWith('_auto-') || seg.startsWith('.'))) continue;
    const meta = metaOf(dir, f.name);
    const fmt = loraFormat.inspect(path.join(dir, f.name));
    const arch = fmt.arch || { id: 'unknown', label: '未知架构' };
    const triggers = asTriggers(meta, fmt.trigger);
    const defaultTrigger = String(meta.trigger || triggers[0] || '').trim();
    const branch = String(meta.branch || inferBranch(f.name)).trim();
    const req = (meta.requires && typeof meta.requires === 'object') ? meta.requires : (out.requires || {});
    const known = arch.id !== 'unknown';
    const mismatch = known && arch.id !== expectArch;
    out.items.push({
      id: sub + '/' + f.name,
      rel: f.name,
      file: loraName(sub + '/' + f.name),      // 直接喂工作流的 lora_name（平台分隔符）
      label: String(meta.label || String(f.name).split('/').pop().replace(/\.safetensors$/i, '')),
      note: String(meta.note || ''),
      triggers,
      // 触发词的中文标签（可选，与 triggers 同序）：界面显示中文，真正写进提示词的是 triggers 原文
      triggerLabels: Array.isArray(meta.triggerLabels) ? meta.triggerLabels.map(String) : [],
      trigger: defaultTrigger,
      triggerFrom: (meta.trigger || (Array.isArray(meta.triggers) && meta.triggers.length)) ? 'json'
        : (fmt.trigger ? 'meta' : ''),
      branch,
      branchFrom: meta.branch ? 'json' : (branch ? 'name' : ''),
      weight: num(meta.weight, weight.default),
      weightMin: num(meta.weightMin, weight.min),
      weightMax: num(meta.weightMax, weight.max),
      requires: req,
      canvas: (meta.canvas && typeof meta.canvas === 'object') ? meta.canvas : null,
      size: f.size || 0,
      tensors: fmt.tensors || 0,
      needFix: !!fmt.needFix,
      arch: arch.id,
      archLabel: arch.label,
      mismatch,
      mismatchWhy: mismatch
        ? ('这个 LoRA 是 ' + arch.label + ' 用的，当前视频方案（' + expectArch + '）加载不了它')
        : '',
      expectArch
    });
  }
  out.items.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * 按 id 取一条（生成时用）。id 不在清单里（文件被删/改名）→ null。
 * 返回的条目已带平台分隔符的 file，可直接写进工作流。
 */
function resolve(profile, slotId, loraId) {
  const want = String(loraId || '').trim();
  if (!want) return null;
  return list(profile, slotId).items.find(it => it.id === want) || null;
}

/** 当前激活视频方案的槽位清单（IPC 用） */
function summary(slotId) {
  const profiles = require('./profiles.cjs');
  return list(profiles.active('video'), slotId);
}

module.exports = { slots, slotOf, slotDir, loraName, list, resolve, summary, inferBranch };
