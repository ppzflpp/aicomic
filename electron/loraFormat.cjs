'use strict';
/**
 * LoRA 文件格式适配 —— 让用户把权重丢进目录就能直接用，不需要手动转格式。
 *
 * ■ 为什么需要这一层
 *   魔搭 / DiffSynth / 大部分训练脚本导出的都是 **PEFT 命名**：
 *     transformer_blocks.0.img_mlp.gate_layer.lora_A.default.weight
 *   ComfyUI 的加载器按 key 名去匹配底模权重，对不上就跳过。而且它**只打 WARNING
 *   不报错**，节点照样执行、图照样出，用户完全看不出丢了权重。
 *
 *   实测一个 PEFT 风格的 Qwen-Image 2.1 LoRA（448 个张量）：
 *     · 320 个（attn / txt_mlp 等）走通用匹配，能容忍 `.default` → 加载成功
 *     · 128 个（32 层 × img_mlp.gate_layer + proj × A/B）走 Qwen21 专属的
 *       gate/proj 融合映射（comfy/lora.py:337），那段代码硬拼裸 key 字符串，
 *       带 `.default` 就匹配不上 → 全部静默丢弃（29% 权重失效）
 *
 * ■ 转换做了什么
 *   只把 `.default.` 换成 `.`，**张量数据一个字节不动**（data_offsets 是相对数据区
 *   起点算的，改 header 不影响它），所以不存在精度损失。
 *   🔴 绝对不能加 `diffusion_model.` 前缀 —— Qwen 分支注册的是裸 key，加了前缀
 *      反而让 gate_layer/proj 全部失配（同样丢 128 个）。
 *
 * ■ 产物放哪
 *   `<loras>/_auto-<styles.dir>/`，与风格目录同级、**不被 listStyles 扫描**
 *   （否则转换产物会作为新条目重复出现在下拉里 —— 之前踩过：3 份副本列 3 项）。
 *   送进 ComfyUI 的 lora_name 是 `_auto-qwen-image\xxx.safetensors`，与已验证可用的
 *   `qwen-image\xxx.safetensors` 同为一级子目录。
 *
 * ■ 何时转
 *   懒转换：列清单时只读 header 判断（几十毫秒），真正选中用它生成时才转，转完缓存。
 *   源文件 mtime 变了（重新下载）就重转。
 */
const fs = require('fs');
const path = require('path');

const PEFT_TAG = '.default.';
const MAX_HEADER = 64 * 1024 * 1024;   // header 异常大就不碰，防止读爆内存
const CHUNK = 4 * 1024 * 1024;

/** 自动转换产物的目录名（相对 loras 根） */
function autoDirName(sub) {
  return '_auto-' + String(sub || 'misc').replace(/[\\/]+/g, '-');
}

/** 读 safetensors 的头部 JSON（不含数据区），失败返回 null */
function readHeader(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= 8) return null;
    fd = fs.openSync(file, 'r');
    const lb = Buffer.alloc(8);
    if (fs.readSync(fd, lb, 0, 8, 0) !== 8) return null;
    const hlen = Number(lb.readBigUInt64LE(0));
    if (!hlen || hlen > MAX_HEADER || hlen + 8 > st.size) return null;
    const hb = Buffer.alloc(hlen);
    if (fs.readSync(fd, hb, 0, hlen, 8) !== hlen) return null;
    const header = JSON.parse(hb.toString('utf8'));
    if (!header || typeof header !== 'object') return null;
    return { header, hlen, size: st.size, mtimeMs: st.mtimeMs };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/**
 * 从 key 命名猜 LoRA 是给哪个架构训练的。
 * 挂错底模时 ComfyUI 一样不报错 —— 它只会把对不上的 key 全跳过，
 * 相当于这个 LoRA 完全没加载，用户看到的就是「选了没反应」。所以要先判出来。
 */
function detectArch(keys) {
  let qwen = 0, flux = 0, sd = 0, h3 = 0;
  for (const k of keys) {
    if (/transformer_blocks\.\d+\./.test(k)) { qwen++; continue; }         // Qwen-Image / 混元
    // Flux / 混元 MMDiT（diffusers 命名与 kohya 命名都算）
    if (/(double_blocks|single_blocks)[._]\d+[._]/.test(k)) { flux++; continue; }
    // SD1.5 / SDXL：只认 UNet 特有的段名 ——
    // 🔴 不能见 `lora_unet_` 就当 SD：ComfyUI 会把 `lora_unet_<state_dict key>` 反过来映射
    //    到 `diffusion_model.*`（comfy/lora.py:model_lora_keys_unet），所以 H3 的
    //    `lora_unet_blocks_0_attn_out_proj.lora_down.weight` 是**能加载的**，
    //    当成 SD 会把好文件误判成「架构不符」直接禁用（实测 wushu v7 就是这种命名）。
    if (/lora_unet_(input_blocks|middle_block|output_blocks|down_blocks|up_blocks)_/.test(k)) { sd++; continue; }
    if (/(^|\.)(input_blocks|down_blocks|up_blocks)\./.test(k)) { sd++; continue; }
    // MiniMax H3（视频）：DiT 是 blocks.N.*，另有 token_refiner 段。
    // 两种命名都算：diffusers（blocks.0.attn）与 kohya（lora_unet_blocks_0_attn）。
    if (/(^|\.)blocks\.\d+\./.test(k) || /lora_unet_blocks_\d+_/.test(k) || /token_refiner/.test(k)) { h3++; continue; }
  }
  const max = Math.max(qwen, flux, sd, h3);
  if (!max) return { id: 'unknown', label: '未知架构' };
  if (qwen === max) return { id: 'qwen', label: 'Qwen-Image' };
  if (flux === max) return { id: 'flux', label: 'Flux / 混元' };
  if (h3 === max) return { id: 'h3', label: 'MiniMax H3' };
  return { id: 'sd', label: 'SD / SDXL' };
}

/**
 * 触发词：优先读训练时写进 metadata 的字段。
 * 魔搭 / DiffSynth 会写 trigger_word；kohya 系常写 ss_trigger_words（可能是 JSON 数组字符串）。
 */
function pickTrigger(md) {
  if (!md || typeof md !== 'object') return '';
  const raw = md.trigger_word || md.trigger_words || md.ss_trigger_words
    || md.activation_text || md['modelspec.trigger_phrase'] || '';
  if (Array.isArray(raw)) return raw.map(String).join(', ');
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return a.map(String).join(', ');
    } catch (_) { /* 不是合法数组就当普通字符串 */ }
  }
  return s;
}

/**
 * 判断一个 LoRA 需不需要转换，顺便报告它的架构与触发词。
 * @returns {{ok:boolean, tensors:number, peft:number, needFix:boolean,
 *            arch:{id:string,label:string}, trigger:string, error?:string}}
 */
function inspect(file) {
  const r = readHeader(file);
  const fallback = { id: 'unknown', label: '未知架构' };
  if (!r) return { ok: false, tensors: 0, peft: 0, needFix: false, arch: fallback, trigger: '', error: 'not-safetensors' };
  const keys = Object.keys(r.header).filter(k => k !== '__metadata__');
  let peft = 0;
  for (const k of keys) if (k.indexOf(PEFT_TAG) >= 0) peft++;
  return {
    ok: true,
    tensors: keys.length,
    peft,
    needFix: peft > 0,
    arch: detectArch(keys),
    trigger: pickTrigger(r.header.__metadata__)
  };
}

/**
 * 流式转换：重写 header（去 .default），数据区原样拷贝。内存占用恒定 4MB。
 * 先写 .part 再 rename，避免崩在中间留下半个文件。
 */
function convertTo(srcPath, dstPath) {
  const r = readHeader(srcPath);
  if (!r) throw new Error('不是有效的 safetensors：' + path.basename(srcPath));

  const nh = {};
  let renamed = 0;
  for (const [k, v] of Object.entries(r.header)) {
    if (k === '__metadata__') { nh[k] = v; continue; }
    const nk = k.split(PEFT_TAG).join('.');
    if (nk !== k) renamed++;
    nh[nk] = v;
  }
  if (!renamed) throw new Error('没有需要改名的 key：' + path.basename(srcPath));

  let js = Buffer.from(JSON.stringify(nh), 'utf8');
  const pad = (8 - (js.length % 8)) % 8;               // safetensors 惯例：空格补齐到 8 字节
  if (pad) js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(js.length), 0);

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const tmp = dstPath + '.part';
  const inFd = fs.openSync(srcPath, 'r');
  const outFd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(outFd, Buffer.concat([head, js]));
    const dataStart = 8 + r.hlen;
    const buf = Buffer.alloc(CHUNK);
    let pos = dataStart;
    while (pos < r.size) {
      const want = Math.min(CHUNK, r.size - pos);
      const n = fs.readSync(inFd, buf, 0, want, pos);
      if (!n) break;
      fs.writeSync(outFd, buf, 0, n);
      pos += n;
    }
  } finally {
    try { fs.closeSync(outFd); } catch (_) { /* ignore */ }
    try { fs.closeSync(inFd); } catch (_) { /* ignore */ }
  }

  // Windows 上 rename 覆盖已存在文件会失败，先删
  try { fs.unlinkSync(dstPath); } catch (_) { /* 不存在就算了 */ }
  fs.renameSync(tmp, dstPath);
  return { renamed, tensors: Object.keys(nh).filter(k => k !== '__metadata__').length };
}

/**
 * 保证拿到一个 ComfyUI 能完整加载的 LoRA。
 *
 * @param {string} lorasRoot  loras 根的绝对路径
 * @param {string} sub        风格目录名（styles.dir，如 'qwen-image'）
 * @param {string} relName    相对风格目录的文件名（可能带子目录）
 * @returns {{file:string|null, converted:boolean, cached:boolean, error?:string}}
 *          file 是相对 loras 根的正斜杠路径，直接喂 loraName() 转分隔符
 */
function ensure(lorasRoot, sub, relName) {
  const srcRel = String(sub || '') + '/' + String(relName || '');
  const src = path.join(lorasRoot, String(sub || ''), String(relName || ''));
  const info = inspect(src);
  if (!info.ok) return { file: srcRel, converted: false, cached: false, error: info.error };
  if (!info.needFix) return { file: srcRel, converted: false, cached: false };

  const dstDir = path.join(lorasRoot, autoDirName(sub));
  const dst = path.join(dstDir, String(relName || ''));
  const dstRel = autoDirName(sub) + '/' + String(relName || '');

  // 缓存命中：产物存在、非空、不比源文件旧
  try {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    if (d.size > 0 && d.mtimeMs >= s.mtimeMs) {
      return { file: dstRel, converted: false, cached: true };
    }
  } catch (_) { /* 没缓存，往下转 */ }

  try {
    convertTo(src, dst);
    return { file: dstRel, converted: true, cached: false };
  } catch (e) {
    // 转不了就用原文件：主体 320/448 权重仍能加载，比直接失败强
    return { file: srcRel, converted: false, cached: false, error: e.message };
  }
}

module.exports = { inspect, ensure, autoDirName, convertTo };
