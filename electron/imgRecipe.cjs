'use strict';
/**
 * 生图「档位配方」—— 基础模型 / 加速 LoRA / 风格 LoRA 三件事的收口点。
 *
 * 一份方案（qwen-image.json）里的 models / loras / styles 三段声明：
 *   models[]  基础模型：用哪个 unet 槽、是否走加速模板、参数候选值、可挂哪些加速 LoRA
 *   loras[]   加速 LoRA：文件名 / 出品方 / 自己的参数（步数 + σ 网格）
 *   styles    风格 LoRA：约定目录（默认 loras/qwen-image/），目录里有谁就列谁
 *
 * 参数规则（用户在 UI 上看到的一切锁定状态都由这里推出来）：
 *   · params 里每个键是**候选值数组**，长度 1 = 该控件锁死；
 *   · 加速 LoRA 的 params 覆盖基础模型的 params（σ 网格是训练定死的，不能乱配）；
 *   · 有风格 LoRA 且当前档 CFG 只有唯一值时，CFG 解锁为 accel.cfgWithStyle（默认 1 / 1.6）。
 *
 * 装配规则（apply）只做四件事，全部可逆、按节点 id 定位，不猜结构：
 *   1. 加速 LoRA → 模板 14 号节点（没有就摘掉并把下游接回 unet）
 *   2. σ 网格   → 文生图走 ManualSigmas(33)，图生图/编辑走 BasicScheduler(34)
 *   3. 位移修正 → 档位声明了 modelSampling 才插 ModelSamplingFlux
 *   4. 风格 LoRA → 依次串 LoraLoaderModelOnly，链尾接回所有 model 消费者
 *
 * 🔴 只有「图片生成」页会传 imageModel / imageLora / imageStyle。其它生图入口
 *    （角色卡 / 场景卡 / 三视图 / 装扮 / 片头封面 / 素材库）不传 → resolve 返回 null
 *    → 整段逻辑跳过，模板与参数与改造前完全一致。
 */
const fs = require('fs');
const path = require('path');
const models = require('./models.cjs');
const loraFormat = require('./loraFormat.cjs');

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function asArr(v) {
  if (Array.isArray(v)) return v.slice();
  return (v === null || v === undefined || v === '') ? [] : [v];
}

/** 从一个候选数组里挑值：唯一值直接锁死；多值取用户选的，选不中退回第一个 */
function pickOne(cand, want, dflt) {
  const arr = asArr(cand);
  if (!arr.length) return dflt;
  if (arr.length === 1) return arr[0];
  const has = arr.some(x => String(x) === String(want));
  return has ? want : arr[0];
}

/**
 * 配置里的 LoRA 路径统一用正斜杠写（loras/qwen-image/xxx.safetensors 里的 "qwen-image/xxx"），
 * 但 ComfyUI 的 lora_name 候选值是按平台分隔符给的 —— Windows 上是反斜杠
 * （实测候选：`qwen-image\\turbo8_lora_step2500.safetensors`）。
 * 送进工作流前必须转一次，否则 ComfyUI 报「不认这个值」。
 */
function loraName(file) {
  return String(file || '').split('/').join(path.sep);
}

/** 配置里声明的加速 LoRA（id → 定义） */
function loraTable(profile) {
  const out = {};
  for (const l of asArr(profile && profile.loras)) if (l && l.id) out[l.id] = l;
  return out;
}

/** 风格 LoRA 目录（绝对路径），没配或模型根没设返回 null */
function styleDir(profile) {
  const cfg = (profile && profile.styles) || {};
  const name = String(cfg.dir || 'qwen-image').trim();
  const root = models.resolveDir('loras');
  if (!root || !name) return null;
  return path.join(root, name);
}

/**
 * 加速 LoRA 的文件名集合（只取裸名、小写）。
 * 🔴 加速 LoRA 和风格 LoRA 现在都放在同一个子目录里（loras/qwen-image/），
 *    扫目录列风格时必须把它们剔掉，否则 turbo 会同时出现在两个下拉里。
 *    用 basename 比对，是因为 loras[].file 可能写成 "qwen-image/xxx" 也可能只写 "xxx"。
 */
function accelFileNames(profile) {
  const out = new Set();
  for (const l of asArr(profile && profile.loras)) {
    const f = String((l && l.file) || '').trim();
    if (f) out.add(path.basename(f).toLowerCase());
  }
  return out;
}

/**
 * 读风格 LoRA 旁边同名的 .json（可选）：{ label, note, trigger }
 *
 * 两种命名都认（用户手写时几乎都会用后者）：
 *   xxx.safetensors.json   ← 规范写法
 *   xxx.json               ← 省略扩展名的写法
 * 先试规范写法；它不存在再退到短名。两个都有时以规范写法为准。
 */
function styleMeta(dir, fileName) {
  const cands = [fileName + '.json'];
  const bare = String(fileName).replace(/\.safetensors$/i, '');
  if (bare !== fileName) cands.push(bare + '.json');
  for (const c of cands) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, c), 'utf-8'); } catch (_) { continue; }
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return o;
    } catch (_) {
      // JSON 写坏了（多余逗号、中文引号等）—— 别静默吞掉，留个线索
      console.warn('[imgRecipe] 忽略无法解析的元数据：' + c);
    }
  }
  return {};
}

/**
 * 风格 LoRA 清单：目录里有多少 .safetensors 就列多少
 * （档位声明里用到的加速 LoRA 除外，见 accelFileNames）。
 * 不内置任何固定名单 —— 用户把文件丢进 loras/qwen-image/ 就会出现，
 * 不需要改代码、不需要重新打包。
 *
 * 每个条目附带 needFix：魔搭/DiffSynth 导出的 PEFT 权重（key 带 `.default.`）
 * 会被标出来，真正使用时由 resolve() 自动转格式，用户不必手动处理。
 */
function listStyles(profile) {
  const cfg = (profile && profile.styles) || {};
  const dir = styleDir(profile);
  if (!dir || !fs.existsSync(dir)) return [];
  const sub = String(cfg.dir || 'qwen-image').trim();
  const expectArch = String(cfg.arch || 'qwen').trim();     // 这套方案要什么架构的 LoRA
  const skip = accelFileNames(profile);
  const files = models.listInDir(dir, ['.safetensors'], null);
  const out = [];
  for (const f of files) {
    if (skip.has(path.basename(f.name).toLowerCase())) continue;   // 加速 LoRA 不算风格
    // 自动转换的产物不在这个目录（见 loraFormat 的 autoDirName），防御性跳过
    if (f.name.split('/').some(seg => seg.startsWith('_auto-'))) continue;
    const meta = styleMeta(dir, f.name);
    const fmt = loraFormat.inspect(path.join(dir, f.name));
    const arch = fmt.arch || { id: 'unknown', label: '未知架构' };
    out.push({
      id: sub + '/' + f.name,
      rel: f.name,                       // 相对风格目录（resolve 里转格式要用）
      label: String(meta.label || f.name.replace(/\.safetensors$/i, '')),
      note: String(meta.note || ''),
      // 触发词：同名 .json 手写的优先，没有就用文件 metadata 里训练时写的那条
      trigger: String(meta.trigger || fmt.trigger || ''),
      triggerFrom: meta.trigger ? 'json' : (fmt.trigger ? 'meta' : ''),
      size: f.size || 0,
      needFix: !!fmt.needFix,            // PEFT 格式：首次使用时自动转换
      fixKeys: fmt.peft || 0,            // 需要改名的 key 数（排障用）
      tensors: fmt.tensors || 0,
      arch: arch.id,
      archLabel: arch.label,
      // 挂错底模的 LoRA 加载 0 个 key、也不报错 —— 提前标出来，不让用户白等
      mismatch: arch.id !== 'unknown' && arch.id !== expectArch,
      expectArch
    });
  }
  // 有中文名的排前面？不 —— 按文件名排序，用户自己改名来控制顺序更直观
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** 加速 LoRA 是否真的在硬盘上（在 loras 目录的文件清单里找精确同名） */
function installedLoraFiles() {
  const root = models.resolveDir('loras');
  if (!root) return new Set();
  return new Set(models.listInDir(root, ['.safetensors'], null).map(f => f.name));
}

/* ------------------------------------------------------------------ *
 * 给界面的清单
 * ------------------------------------------------------------------ */

/**
 * 图片生成页要用的全部档位信息（渲染层不做任何文件判断）。
 * @returns {{models:Array, styles:Array, defaultModel:string, styleMax:number,
 *            styleDefaultWeight:number, weightMin:number, weightMax:number, cfgWithStyle:Array}}
 */
function list(profile) {
  const p = profile || {};
  const loraFiles = installedLoraFiles();
  const slots = {};
  for (const a of asArr(p.assets)) if (a && a.slot) slots[a.slot] = models.resolveAsset(a);
  const lt = loraTable(p);
  const accelCfg = asArr(p.accel && p.accel.cfgWithStyle);

  const outModels = asArr(p.models).map(m => {
    const slotRes = m.unet ? slots[m.unet] : null;
    const ids = asArr(m.loras);
    const loras = ids.map(id => lt[id]).filter(Boolean).map(l => ({
      id: l.id,
      label: l.label || l.id,
      tag: l.tag || '',
      by: l.by || '',
      note: l.note || '',
      installed: loraFiles.has(String(l.file || '')),
      // 参数原样给渲染层：步数/CFG/调度器的候选值就靠它决定锁不锁
      params: { ...(l.params || {}) }
    }));
    return {
      id: m.id,
      label: m.label || m.id,
      desc: m.desc || '',
      accel: !!m.accel,
      installed: !!(slotRes && slotRes.name),
      params: { ...(m.params || {}) },
      loras
    };
  });

  const st = p.styles || {};
  return {
    models: outModels,
    styles: listStyles(p),
    defaultModel: outModels.length ? outModels[0].id : '',
    styleMax: Number(st.max) > 0 ? Number(st.max) : 1,
    styleDefaultWeight: Number(st.defaultWeight) > 0 ? Number(st.defaultWeight) : 0.7,
    weightMin: Number.isFinite(Number(st.weightMin)) ? Number(st.weightMin) : 0.2,
    weightMax: Number(st.weightMax) > 0 ? Number(st.weightMax) : 1,
    cfgWithStyle: accelCfg,
    maxCount: Number(st.max) > 0 ? Number(st.max) : 1
  };
}

/* ------------------------------------------------------------------ *
 * 解析：选了什么 → 用哪个模板 / 哪些参数 / 哪些 LoRA
 * ------------------------------------------------------------------ */

/**
 * @param {object} profile   生图方案（profiles.active('image')）
 * @param {object} sel       { modelId, loraId, styleId, styleW, mode:'t2i'|'edit'|'i2i', want:{steps,cfg,sampler,scheduler} }
 * @returns {object|null}    拿不到（没选模型 / 方案没这套配置）返回 null
 */
function resolve(profile, sel) {
  const p = profile || {};
  const s = sel || {};
  const ms = asArr(p.models);
  if (!ms.length) return null;                    // 方案没声明档位 → 当作不支持，走原路径

  const model = ms.find(m => m.id === s.modelId) || ms[0];
  const lt = loraTable(p);
  const allowed = asArr(model.loras);
  const lora = (s.loraId && allowed.includes(s.loraId)) ? (lt[s.loraId] || null) : null;

  // —— 组合参数：加速 LoRA 覆盖基础模型（σ 网格训练定死，不能混配）——
  const merged = { ...(model.params || {}), ...((lora && lora.params) || {}) };

  // —— 风格 LoRA：只认目录里真实存在的，且一次最多 styleMax 个 ——
  const styleCfg = p.styles || {};
  const styleSub = String(styleCfg.dir || 'qwen-image').trim();
  const styleList = listStyles(p);
  const wantStyle = String(s.styleId || '').trim();
  const styles = [];
  if (wantStyle) {
    const hit = styleList.find(x => x.id === wantStyle);
    if (hit) {
      // 挂错底模：ComfyUI 不会报错，只会把 key 全部跳过（等于没加载），
      // 用户白等几十秒还以为是「LoRA 效果差」。宁可这里直接拦住说清楚。
      if (hit.mismatch) {
        return { ok: false, error: '风格 LoRA「' + hit.label + '」是 ' + hit.archLabel + ' 用的，'
          + '挂到「' + (model.label || model.id) + '」上不会加载任何权重（key 对不上）。'
          + '请换成 Qwen-Image 版本的 LoRA。' };
      }
      const lo = Number.isFinite(Number(styleCfg.weightMin)) ? Number(styleCfg.weightMin) : 0.2;
      const hi = Number(styleCfg.weightMax) > 0 ? Number(styleCfg.weightMax) : 1;
      const w = Number(s.styleW);
      const weight = Number.isFinite(w) ? Math.min(hi, Math.max(lo, w)) : (Number(styleCfg.defaultWeight) || 0.7);

      // PEFT 权重（魔搭/DiffSynth 导出）在这里自动转成 ComfyUI 能完整加载的格式。
      // 产物落在 loras/_auto-<dir>/，不污染用户目录、也不会重复出现在下拉里；
      // 转好后按 mtime 缓存，第二次用零开销。用户全程不需要知道这件事。
      let styleFile = hit.id;
      let fixed = null;
      if (hit.needFix) {
        const root = models.resolveDir('loras');
        if (root) {
          fixed = loraFormat.ensure(root, styleSub, hit.rel || path.basename(hit.id));
          if (fixed && fixed.file) styleFile = fixed.file;
        }
      }
      styles.push({
        file: loraName(styleFile),
        weight,
        trigger: hit.trigger || '',
        label: hit.label,
        converted: !!(fixed && fixed.converted),
        cached: !!(fixed && fixed.cached),
        fixError: (fixed && fixed.error) || ''
      });
    }
  }

  // —— 参数候选：有风格 LoRA 且当前档 CFG 唯一 → 解锁为 cfgWithStyle ——
  let cfgCand = asArr(merged.cfg);
  const cfgWithStyle = asArr(p.accel && p.accel.cfgWithStyle);
  if (styles.length && cfgCand.length === 1 && cfgWithStyle.length) cfgCand = cfgWithStyle;

  const want = s.want || {};
  const accel = !!lora || !!model.accel;
  const isEdit = s.mode === 'edit';
  const tpl = accel
    ? (isEdit ? (p.accel && p.accel.workflowEdit) : (p.accel && p.accel.workflow))
    : (isEdit ? (p.workflowEdit || p.workflow) : p.workflow);

  // unet 槽位 → 实际文件名（没装就明确报缺，不许静默退回别的底模）
  const slots = {};
  for (const a of asArr(p.assets)) if (a && a.slot) slots[a.slot] = models.resolveAsset(a);
  const unetName = (slots[model.unet] && slots[model.unet].name) || null;
  if (model.unet && !unetName) {
    return { ok: false, error: '「' + (model.label || model.id) + '」所需的生图主模型没装：'
      + '请到 设置 → 模型管家 补齐 ' + model.unet + ' 槽位（' + (model.desc || '') + '）' };
  }

  // 配置里写的是正斜杠（installedLoraFiles 的键也是），送进工作流前转成平台分隔符
  const loraFileRaw = lora ? String(lora.file || '').trim() : '';
  if (loraFileRaw && !installedLoraFiles().has(loraFileRaw)) {
    return { ok: false, error: '加速 LoRA「' + (lora.label || lora.id) + '」没装：'
      + '请把文件放到模型目录的 loras\\' + loraFileRaw.replace(/\//g, '\\') + '，或改选「不使用」' };
  }
  const loraFile = loraName(loraFileRaw);

  return {
    ok: true,
    modelId: model.id,
    loraId: lora ? lora.id : '',
    accel,
    tpl,
    unet: unetName,
    loraFile,
    loraStrength: 1,
    modelSampling: (lora && lora.modelSampling) || null,
    styles,
    // 最终生效的采样参数（唯一值直接锁死；多值取用户选的）
    steps: pickOne(merged.steps, want.steps, 25),
    cfg: pickOne(cfgCand, want.cfg, 2.5),
    sampler: pickOne(merged.sampler, want.sampler, 'euler'),
    scheduler: pickOne(merged.scheduler, want.scheduler, 'simple'),
    // 有 σ 网格 = 蒸馏档：文生图必须走 ManualSigmas；没有 = 交给 BasicScheduler（turbo8）
    sigmas: merged.sigmas ? String(merged.sigmas) : '',
    options: {
      steps: asArr(merged.steps),
      cfg: cfgCand,
      sampler: asArr(merged.sampler),
      scheduler: asArr(merged.scheduler)
    }
  };
}

/* ------------------------------------------------------------------ *
 * 装配：把工作流 JSON 改成这一档该有的样子
 * ------------------------------------------------------------------ */

/** 把工作流里所有指向 from 的输入改成指向 to（skipId 是新插入的那个节点自己） */
function repoint(wf, from, to, skipId) {
  const fid = String(from[0]);
  const fo = from[1];
  for (const [id, node] of Object.entries(wf)) {
    if (id === String(skipId)) continue;
    const inp = node && node.inputs;
    if (!inp) continue;
    for (const k of Object.keys(inp)) {
      const v = inp[k];
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === fid && v[1] === fo) inp[k] = to;
    }
  }
}

/** 在 ref 后面串一串节点，返回链尾；每串一个就把原来的下游接过来 */
function chain(wf, ref, specs, startId) {
  let cur = ref;
  let id = startId;
  for (const sp of specs) {
    const nid = String(id++);
    wf[nid] = { class_type: sp.class_type, inputs: { ...sp.inputs, model: cur } };
    repoint(wf, cur, [nid, 0], nid);
    cur = [nid, 0];
  }
  return cur;
}

/**
 * @param {object} wf     已 JSON.parse 的工作流
 * @param {object} r      resolve() 的返回值
 * @param {object} o      { customSampler:boolean, useManual:boolean, width, height }
 */
function apply(wf, r, o) {
  const opt = o || {};
  if (!wf || !r || !r.ok) return wf;

  const unetId = Object.keys(wf).find(k => wf[k] && wf[k].class_type === 'UNETLoader') || '10';
  let tail = [unetId, 0];
  const custom = !!opt.customSampler;

  if (custom) {
    // ① 加速 LoRA 槽（模板 14 号）：没选就整节点摘掉，下游接回 unet
    if (r.loraFile) {
      wf['14'] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: [unetId, 0], lora_name: r.loraFile, strength_model: r.loraStrength }
      };
      tail = ['14', 0];
    } else if (wf['14']) {
      repoint(wf, ['14', 0], [unetId, 0]);
      delete wf['14'];
    }

    // ② σ 网格：蒸馏档（有 sigmas）且 denoise=1 → ManualSigmas；否则按 denoise 截断走 BasicScheduler
    if (opt.useManual) {
      if (wf['34']) delete wf['34'];
      if (wf['35']) wf['35'].inputs.sigmas = ['33', 0];
    } else {
      if (wf['33']) delete wf['33'];
      if (wf['35']) wf['35'].inputs.sigmas = ['34', 0];
    }
  }

  // ③④ 位移修正 + 风格 LoRA：按顺序串在模型链尾，链尾自动接回 CFGGuider / BasicScheduler
  const specs = [];
  if (r.loraFile && !custom) {
    specs.push({ class_type: 'LoraLoaderModelOnly', inputs: { lora_name: r.loraFile, strength_model: r.loraStrength } });
  }
  if (r.modelSampling) {
    specs.push({
      class_type: 'ModelSamplingFlux',
      inputs: {
        max_shift: Number(r.modelSampling.max_shift),
        base_shift: Number(r.modelSampling.base_shift),
        width: Number(opt.width) || 1024,
        height: Number(opt.height) || 1024
      }
    });
  }
  for (const s of (r.styles || [])) {
    specs.push({ class_type: 'LoraLoaderModelOnly', inputs: { lora_name: s.file, strength_model: s.weight } });
  }
  if (specs.length) chain(wf, tail, specs, 40);

  return wf;
}

module.exports = { list, resolve, apply, listStyles, styleDir, repoint, loraName };
