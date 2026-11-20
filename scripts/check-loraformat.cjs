'use strict';
/* loraFormat.cjs 自检（不连 ComfyUI、不出图）
 *
 * 造一个 PEFT 格式的 safetensors，验证：
 *   1. inspect 能识别 PEFT（.default）与非 PEFT
 *   2. ensure 转出的文件：key 全部去掉 .default、张量数不变、数据区逐字节一致
 *   3. 转换后 header 的 data_offsets 仍与数据区自洽（safetensors 规范）
 *   4. 二次调用命中缓存（不重复转）
 *   5. 源文件更新后缓存失效、重新转
 *   6. 非 PEFT 文件原样返回，不产生多余产物
 *   7. 坏文件不炸，返回原路径
 *   8. 风格元数据 sidecar 两种命名（xxx.safetensors.json / xxx.json）都认
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = 'E:/DragonProject/AIComic/comic-studio/electron';
const loraFormat = require(path.join(ROOT, 'loraFormat.cjs'));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

/* ---------- 造 safetensors ---------- */
function writeSafetensors(file, keys, dataBuf, meta) {
  const header = meta ? { __metadata__: meta } : {};
  let off = 0;
  for (const k of keys) {
    const n = k.bytes;
    header[k.name] = { dtype: 'F32', shape: [n / 4], data_offsets: [off, off + n] };
    off += n;
  }
  let js = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (8 - (js.length % 8)) % 8;
  if (pad) js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(js.length), 0);
  fs.writeFileSync(file, Buffer.concat([head, js, dataBuf]));
}

function readRaw(file) {
  const buf = fs.readFileSync(file);
  const hlen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.slice(8, 8 + hlen).toString('utf8'));
  return { header, data: buf.slice(8 + hlen), hlen };
}

const tmp = path.join(os.tmpdir(), 'loraformat-check-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const sub = 'qwen-image';
const styleDirAbs = path.join(tmp, sub);
fs.mkdirSync(styleDirAbs, { recursive: true });

/* 三个 key：两个 img_mlp（gate_layer / proj，就是实测丢权重的那类）+ 一个 attn */
const PEFT_KEYS = [
  'transformer_blocks.0.img_mlp.gate_layer.lora_A.default.weight',
  'transformer_blocks.0.img_mlp.gate_layer.lora_B.default.weight',
  'transformer_blocks.0.img_mlp.proj.lora_A.default.weight',
  'transformer_blocks.0.attn.to_k.lora_A.default.weight'
];
const DATA = crypto.randomBytes(64 * 4);           // 4 个张量 × 64 字节

const srcPeft = path.join(styleDirAbs, 'peft_test.safetensors');
writeSafetensors(srcPeft, PEFT_KEYS.map(n => ({ name: n, bytes: 64 })), DATA, { trigger_word: 'nanko' });

console.log('\n[1] inspect 识别格式');
{
  const r = loraFormat.inspect(srcPeft);
  ok(r.ok === true, 'PEFT 文件可解析');
  ok(r.tensors === 4, '张量数 = 4（实际 ' + r.tensors + '）');
  ok(r.peft === 4, '四个 key 都带 .default（实际 ' + r.peft + '）');
  ok(r.needFix === true, 'needFix = true');
}

console.log('\n[2] ensure 自动转换');
let out1;
{
  out1 = loraFormat.ensure(tmp, sub, 'peft_test.safetensors');
  ok(out1.converted === true, '首次调用执行了转换');
  ok(out1.file === loraFormat.autoDirName(sub) + '/peft_test.safetensors',
    '产物路径 = ' + out1.file);
  const dstAbs = path.join(tmp, out1.file);
  ok(fs.existsSync(dstAbs), '产物文件已落盘');
  ok(!fs.existsSync(dstAbs + '.part'), '没有残留 .part 临时文件');
}

console.log('\n[3] 转换结果正确性');
{
  const src = readRaw(srcPeft);
  const dst = readRaw(path.join(tmp, out1.file));
  const srcKeys = Object.keys(src.header).filter(k => k !== '__metadata__');
  const dstKeys = Object.keys(dst.header).filter(k => k !== '__metadata__');

  ok(dstKeys.length === srcKeys.length, '张量数不变（' + dstKeys.length + '）');
  ok(dstKeys.every(k => k.indexOf('.default.') < 0), '产物里没有 .default');
  const expect = srcKeys.map(k => k.split('.default.').join('.').split('.').join('.'));
  ok(expect.every(k => dstKeys.includes(k)), '每个 key 都能找到对应新名');
  ok(dst.header.__metadata__ && dst.header.__metadata__.trigger_word === 'nanko',
    '__metadata__ 原样保留（trigger_word）');

  // 数据区逐字节一致 —— 转换只改名字，绝不能动数值
  ok(src.data.length === dst.data.length, '数据区长度一致（' + dst.data.length + ' 字节）');
  ok(Buffer.compare(src.data, dst.data) === 0, '数据区逐字节相同');

  // data_offsets 与数据区自洽
  let maxEnd = 0, selfConsistent = true;
  for (const k of dstKeys) {
    const o = dst.header[k];
    if (!Array.isArray(o.data_offsets) || o.data_offsets[0] < 0 || o.data_offsets[1] > dst.data.length) selfConsistent = false;
    maxEnd = Math.max(maxEnd, o.data_offsets[1]);
  }
  ok(selfConsistent, '所有 data_offsets 落在数据区范围内');
  ok(maxEnd === dst.data.length, 'data_offsets 恰好覆盖整个数据区（' + maxEnd + '/' + dst.data.length + '）');
  ok(dst.hlen % 8 === 0, 'header 长度 8 字节对齐（' + dst.hlen + '）');
}

console.log('\n[4] 缓存复用');
{
  const r = loraFormat.ensure(tmp, sub, 'peft_test.safetensors');
  ok(r.cached === true, '二次调用命中缓存');
  ok(r.converted === false, '没有重复转换');
  ok(r.file === out1.file, '返回同一路径');
}

console.log('\n[5] 源文件更新 → 缓存失效');
{
  const future = Date.now() / 1000 + 10;
  fs.utimesSync(srcPeft, future, future);
  const r = loraFormat.ensure(tmp, sub, 'peft_test.safetensors');
  ok(r.cached === false, '源文件 mtime 变新后重新转换');
  ok(r.converted === true, '确实执行了转换');
}

console.log('\n[6] 非 PEFT 文件不产生多余产物');
{
  const plain = path.join(styleDirAbs, 'plain_test.safetensors');
  const keys = ['lora_unet_double_blocks_0_img_mod_lin.lora_A.weight'];
  writeSafetensors(plain, keys.map(n => ({ name: n, bytes: 64 })), crypto.randomBytes(64));
  const ins = loraFormat.inspect(plain);
  ok(ins.needFix === false, 'ComfyUI 格式判定为无需转换（peft=' + ins.peft + '）');
  const r = loraFormat.ensure(tmp, sub, 'plain_test.safetensors');
  ok(r.file === sub + '/plain_test.safetensors', '返回原路径');
  ok(r.converted === false, '没有生成产物');
  ok(!fs.existsSync(path.join(tmp, loraFormat.autoDirName(sub), 'plain_test.safetensors')),
    '缓存目录里没有它的副本');
}

console.log('\n[7] 坏文件不炸');
{
  const bad = path.join(styleDirAbs, 'broken.safetensors');
  fs.writeFileSync(bad, Buffer.from('this is not a safetensors file at all'));
  const ins = loraFormat.inspect(bad);
  ok(ins.ok === false, 'inspect 报告不可解析');
  const r = loraFormat.ensure(tmp, sub, 'broken.safetensors');
  ok(r.file === sub + '/broken.safetensors', '退回原路径，不让生成直接失败');
  ok(!!r.error, '带回了错误信息：' + (r.error || ''));
}

console.log('\n[8] 子目录内的文件也能转（listInDir 是递归的）');
{
  const deepDir = path.join(styleDirAbs, 'pack');
  fs.mkdirSync(deepDir, { recursive: true });
  const deep = path.join(deepDir, 'deep_test.safetensors');
  writeSafetensors(deep, PEFT_KEYS.map(n => ({ name: n, bytes: 64 })), DATA);
  const r = loraFormat.ensure(tmp, sub, 'pack/deep_test.safetensors');
  ok(r.file === loraFormat.autoDirName(sub) + '/pack/deep_test.safetensors',
    '保留子目录结构：' + r.file);
  ok(fs.existsSync(path.join(tmp, r.file)), '嵌套产物已落盘');
}

console.log('\n[9] 架构识别与触发词提取');
{
  const q = loraFormat.inspect(srcPeft);
  ok(q.arch.id === 'qwen', 'transformer_blocks → Qwen-Image（实际 ' + q.arch.id + '）');
  ok(q.trigger === 'nanko', 'metadata.trigger_word 被读出来（' + q.trigger + '）');

  const fluxPath = path.join(styleDirAbs, 'flux_test.safetensors');
  writeSafetensors(fluxPath, [
    { name: 'double_blocks.0.img_attn.qkv.lora_A.weight', bytes: 64 },
    { name: 'single_blocks.3.linear1.lora_A.weight', bytes: 64 }
  ], crypto.randomBytes(128));
  ok(loraFormat.inspect(fluxPath).arch.id === 'flux', 'double_blocks → Flux');

  const sdPath = path.join(styleDirAbs, 'sd_test.safetensors');
  writeSafetensors(sdPath, [
    { name: 'lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn1_to_q.lora_A.weight', bytes: 64 }
  ], crypto.randomBytes(64));
  ok(loraFormat.inspect(sdPath).arch.id === 'sd', 'lora_unet_ → SD / SDXL');

  const kW = path.join(styleDirAbs, 'kohya_test.safetensors');
  writeSafetensors(kW, [{ name: 'transformer_blocks.0.attn.to_q.lora_A.weight', bytes: 64 }], crypto.randomBytes(64),
    { ss_trigger_words: '["inkwash","chinese"]' });
  ok(loraFormat.inspect(kW).trigger === 'inkwash, chinese',
    'ss_trigger_words 数组被展开（' + loraFormat.inspect(kW).trigger + '）');

  const noMeta = path.join(styleDirAbs, 'nometa_test.safetensors');
  writeSafetensors(noMeta, [{ name: 'transformer_blocks.0.attn.to_q.lora_A.weight', bytes: 64 }], crypto.randomBytes(64));
  ok(loraFormat.inspect(noMeta).trigger === '', '没有 metadata 时触发词为空而不是 undefined');
}

console.log('\n[8] 风格元数据 sidecar：两种命名都要认');
{
  // listStyles 需要 models.resolveDir → 注入一个只认 loras 路径的假 db
  const models = require(path.join(ROOT, 'models.cjs'));
  models.init({
    getSetting: k => (k === 'modelpath.loras' ? tmp : null),
    setSetting() {}, get() { return null }, all() { return [] }, run() { return {}; },
    prepare() { return { get() { return null }, all() { return [] }, run() { return {} } }; }
  });
  const imgRecipe = require(path.join(ROOT, 'imgRecipe.cjs'));
  const profile = { styles: { dir: sub, arch: 'qwen' } };
  const find = name => imgRecipe.listStyles(profile).find(x => x.rel === name) || {};

  // 造三个骨架权重（内容不重要，只看元数据怎么取）
  const K = [{ name: 'transformer_blocks.0.attn.to_q.lora_A.weight', bytes: 64 }];
  for (const n of ['long_name.safetensors', 'short_name.safetensors', 'both.safetensors']) {
    writeSafetensors(path.join(styleDirAbs, n), K, crypto.randomBytes(64));
  }

  fs.writeFileSync(path.join(styleDirAbs, 'long_name.safetensors.json'),
    JSON.stringify({ label: '长名写法', trigger: 't-long' }), 'utf8');
  fs.writeFileSync(path.join(styleDirAbs, 'short_name.json'),
    JSON.stringify({ label: '短名写法', trigger: 't-short' }), 'utf8');
  fs.writeFileSync(path.join(styleDirAbs, 'both.safetensors.json'),
    JSON.stringify({ label: '以长名为准' }), 'utf8');
  fs.writeFileSync(path.join(styleDirAbs, 'both.json'),
    JSON.stringify({ label: '不该用到我' }), 'utf8');

  ok(find('long_name.safetensors').label === '长名写法', 'xxx.safetensors.json 生效（规范写法）');
  ok(find('short_name.safetensors').label === '短名写法', 'xxx.json 生效（省略扩展名，用户最常这么写）');
  ok(find('short_name.safetensors').trigger === 't-short'
    && find('short_name.safetensors').triggerFrom === 'json', '短名文件里的 trigger 被读到且标记来源 json');
  ok(find('both.safetensors').label === '以长名为准', '两种都存在时以 .safetensors.json 为准');

  // 坏 JSON 不能把整个列表搞崩
  fs.writeFileSync(path.join(styleDirAbs, 'broken_meta.safetensors'),
    fs.readFileSync(path.join(styleDirAbs, 'long_name.safetensors')));
  fs.writeFileSync(path.join(styleDirAbs, 'broken_meta.json'), '{ "label": "没闭合 ', 'utf8');
  const bk = find('broken_meta.safetensors');
  ok(bk.rel === 'broken_meta.safetensors' && bk.label === 'broken_meta',
    '元数据 JSON 写坏时回退文件名，不抛异常');
}

console.log('\n---');
console.log((fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
