'use strict';
/* 把 DiffSynth / PEFT 导出的 Qwen-Image LoRA 转成 ComfyUI 能完整加载的格式
 *
 *   DiffSynth 原始：
 *     transformer_blocks.0.img_mlp.gate_layer.lora_A.default.weight
 *   ComfyUI 需要的：
 *     transformer_blocks.0.img_mlp.gate_layer.lora_A.weight
 *
 * 只做一件事：去掉 PEFT 的 `.default` 适配器名。
 * 🔴 绝对不要加 `diffusion_model.` 前缀 —— ComfyUI 的 QwenImage 分支
 *    （comfy/lora.py:337）注册的是**裸 key**，而 img_mlp 的 gate_layer/proj
 *    只在那个分支里有切片映射（底模把两半融成了 gate_up）。
 *    加了前缀 → 只剩通用分支能命中，gate_layer/proj 全丢（实测 128/448 丢失）。
 *
 * 用法: node convert-qwen-lora.cjs <源> <目标> [--prefix]
 *   --prefix  额外加 diffusion_model.（一般不要用，仅排障对比时用）
 */
const fs = require('fs');
const path = require('path');

function convert(src, dst, addPrefix) {
  const buf = fs.readFileSync(src);
  const hlen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.slice(8, 8 + hlen).toString('utf8'));
  const data = buf.slice(8 + hlen);

  const nh = {};
  let dropped = 0, prefixed = 0;
  for (const [k, v] of Object.entries(header)) {
    if (k === '__metadata__') { nh[k] = v; continue; }
    let nk = k.replace(/\.default\./g, '.');
    if (/\.default\./.test(k)) dropped++;
    if (addPrefix && !nk.startsWith('diffusion_model.')) { nk = 'diffusion_model.' + nk; prefixed++; }
    nh[nk] = v;
  }

  let js = Buffer.from(JSON.stringify(nh), 'utf8');
  const pad = (8 - (js.length % 8)) % 8;
  if (pad) js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(js.length), 0);
  fs.writeFileSync(dst, Buffer.concat([head, js, data]));

  console.log('源   :', path.basename(src), (fs.statSync(src).size / 1048576).toFixed(1), 'MB');
  console.log('目标 :', path.basename(dst), (fs.statSync(dst).size / 1048576).toFixed(1), 'MB');
  console.log('张量 :', Object.keys(nh).filter(x => x !== '__metadata__').length);
  console.log('去 .default :', dropped, '| 加前缀 :', prefixed);
  console.log('样例 :', Object.keys(nh).filter(x => x !== '__metadata__')[0]);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node convert-qwen-lora.cjs <源.safetensors> <目标.safetensors> [--prefix]');
  process.exit(1);
}
convert(args[0], args[1], args.includes('--prefix'));
