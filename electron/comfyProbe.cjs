'use strict';
/**
 * ComfyUI 侧「真相」探测器（2026-10-18）
 *
 * 【为什么需要这个文件】
 * 软件自己扫文件系统得到一份模型清单（models.cjs），ComfyUI 又有它自己的一份
 * （`extra_model_paths.yaml` / Desktop 的 `extra_models_config.yaml` 决定它扫哪些目录）。
 * 两份清单从来没对过账 —— 于是出现：
 *
 *   Value not in list, unet_name: 'minimax_h3_fl2va_...safetensors' not in []
 *
 * 这句话的真相是「ComfyUI 的 diffusion_models 目录里它一个文件都没扫到」，
 * 但界面上只有一段英文 JSON，用户完全不知道该做什么。
 *
 * ComfyUI 提交工作流（`POST /prompt`）时的校验依据，就是 `GET /object_info` 里
 * 每个节点的输入定义：
 *   · 节点 class_type 不在表里        → `missing_node_type`（版本太旧 / 自定义节点没装）
 *   · combo 输入的值不在候选列表里    → `value_not_in_list`
 * 所以「提交前先拿 object_info 对一遍账」可以从结构上把这两类失败变成一句可照做的话。
 *
 * 【本文件不做的事】
 *   · 不改任何模型文件、不写 ComfyUI 配置（写配置在 ipc 的 `comfy:alignModels` 里，
 *     是用户点按钮才发生的动作）
 *   · 探测失败（老 ComfyUI 没有单节点路由 / 请求超时）一律**放行**，绝不阻断生成
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const comfySetup = require('./comfySetup.cjs');

/** 只对「模型文件类」的 combo 输入做校验：值是这些后缀才当模型看。
 *  这样 LoadImage 的 `studio_xxx.png`、weight_dtype 的 `default` 都不会被误判。 */
const MODEL_EXT_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|pkl)$/i;

/** 节点类 → 中文说明（报错时把 UNETLoader 这种黑话翻成人话） */
const NODE_LABEL = {
  UNETLoader: '主模型加载器',
  CheckpointLoaderSimple: '底模加载器',
  unCLIPCheckpointLoader: '底模加载器',
  CLIPLoader: '文本编码器加载器',
  DualCLIPLoader: '双文本编码器加载器',
  VAELoader: 'VAE 加载器',
  LoraLoader: 'LoRA 加载器',
  LoraLoaderModelOnly: 'LoRA 加载器',
  ControlNetLoader: 'ControlNet 加载器',
  CLIPVisionLoader: 'CLIP 视觉加载器',
  UpscaleModelLoader: '放大模型加载器',
  LoadImage: '图片载入',
  LoadVideo: '视频载入',
  LoadAudio: '音频载入'
};

function nodeLabel(cls) {
  const s = NODE_LABEL[cls];
  return s ? s + '（' + cls + '）' : cls;
}

/** ComfyUI 的模型名统一用 `/` 分隔（Windows 下它自己会 replace(os.sep,'/')），这里对齐 */
function normRel(s) {
  return String(s == null ? '' : s).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

/* ------------------------------------------------------------------ *
 * object_info 探测（带短 TTL 缓存）
 * ------------------------------------------------------------------ */

/** 单节点定义的短缓存：同一次生成里会反复校验同一批 class，别每次都打 ComfyUI */
const CACHE_TTL = 20000;
let _cache = { key: '', at: 0, val: null };

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}

/**
 * 批量取节点定义。
 * @returns {{ok:boolean, reason:string, defs:Object, known:Set, missing:Set}}
 *   ok=false  → 一个都没问到（老版本没有单节点路由 / ComfyUI 没起）→ 调用方必须放行
 *   known     → 确认存在的 class；missing → 确认**不存在**的 class（`{}` 也算确认不存在）
 *   defs      → { cls: info }
 */
async function objectInfo(ep, classes, { timeoutMs = 6000, fresh = false } = {}) {
  const list = [...new Set((classes || []).filter(Boolean))].sort();
  if (!list.length) return { ok: true, reason: '', defs: {}, known: new Set(), missing: new Set() };

  const key = String(ep || '') + '|' + list.join(',');
  if (!fresh && _cache.key === key && Date.now() - _cache.at < CACHE_TTL) return _cache.val;

  const base = String(ep || '').replace(/\/+$/, '');
  const rows = await Promise.all(list.map(async cls => {
    try {
      const r = await getJson(base + '/object_info/' + encodeURIComponent(cls), timeoutMs);
      // ComfyUI 对不存在的节点返回 200 + `{}`；路由本身不存在则是 404
      if (!r.ok || !r.json || typeof r.json !== 'object') return { cls, state: 'unknown' };
      const def = r.json[cls];
      return { cls, state: def ? 'ok' : 'missing', def: def || null };
    } catch (_) {
      return { cls, state: 'unknown' };
    }
  }));

  const defs = {}, known = new Set(), missing = new Set();
  let answered = 0;
  for (const r of rows) {
    if (r.state === 'unknown') continue;
    answered++;
    if (r.state === 'ok') { defs[r.cls] = r.def; known.add(r.cls); }
    else missing.add(r.cls);
  }
  const val = {
    ok: answered > 0,
    reason: answered > 0 ? '' : 'ComfyUI 没有响应 /object_info（可能版本过旧或未启动）',
    defs, known, missing
  };
  // 全都没问到就别缓存（下次立刻重试，避免一次网络抖动把校验永久关掉）
  if (val.ok) _cache = { key, at: Date.now(), val };
  return val;
}

/** 把一个 combo 输入的候选值取出来，兼容三种形态：
 *  1) 老节点：`[['a.safetensors','b.safetensors'], {…}]`
 *  2) V3 schema 的 COMBO：`['COMBO', { options: ['a','b'] }]`
 *  3) 老版本把 COMBO 写成字典：`[['k1','k2'], …]` 或 `[{k1:'显示名'}, …]`（少见）
 *  不是 combo 时返回 null。 */
function comboOptions(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  const head = spec[0];
  const opts = spec[1] && typeof spec[1] === 'object' ? spec[1] : {};
  if (Array.isArray(head)) return head.map(String);
  if (typeof head === 'string' && head.toUpperCase() === 'COMBO') {
    const o = opts.options;
    if (Array.isArray(o)) return o.map(String);
    if (o && typeof o === 'object') return Object.keys(o);
    return [];
  }
  return null;
}

/** 节点的输入定义表（required + optional 合一） */
function inputSpecs(def) {
  const inp = (def && def.input) || {};
  return { ...(inp.required || {}), ...(inp.optional || {}) };
}

/* ------------------------------------------------------------------ *
 * 提交前对账
 * ------------------------------------------------------------------ */

/**
 * 校验一份已经填好参数的工作流能不能被 ComfyUI 接住。
 * @param {string} ep   ComfyUI 地址（http://127.0.0.1:8188）
 * @param {object} wf   API 格式工作流（{ "10": {class_type, inputs}, … }）
 * @returns {{ok:boolean, skipped:boolean, problems:Array, message:string}}
 *   ok=true + skipped=true → 没查成，按「不拦」处理
 */
async function verifyWorkflow(ep, wf, opts = {}) {
  const nodes = Object.entries(wf || {}).filter(([, n]) => n && typeof n.class_type === 'string');
  if (!nodes.length) return { ok: true, skipped: true, problems: [], message: '' };

  const probe = await objectInfo(ep, nodes.map(([, n]) => n.class_type), opts);
  if (!probe.ok) return { ok: true, skipped: true, problems: [], message: '', reason: probe.reason };

  const problems = [];
  for (const [id, n] of nodes) {
    const cls = n.class_type;
    // 请求失败（unknown）的节点不判；确认不存在（missing）才报
    if (probe.missing.has(cls)) {
      problems.push({ kind: 'node', nodeId: id, cls });
      continue;
    }
    const def = probe.defs[cls];
    if (!def) continue;
    const specs = inputSpecs(def);
    for (const [inName, val] of Object.entries(n.inputs || {})) {
      if (typeof val !== 'string') continue;          // 连线（[id, slot]）不校验
      const cand = comboOptions(specs[inName]);
      if (!cand) continue;                            // 不是下拉 → 跳过
      if (!MODEL_EXT_RE.test(val)) continue;          // 不是模型文件 → 跳过（图片/枚举/文本）
      const want = normRel(val);
      const hit = cand.some(c => normRel(c) === want);
      if (hit) continue;
      problems.push({ kind: 'file', nodeId: id, cls, input: inName, value: want, candidates: cand });
    }
  }

  if (!problems.length) return { ok: true, skipped: false, problems: [], message: '' };
  return { ok: false, skipped: false, problems, message: problemsToMessage(problems, opts) };
}

/** 把问题清单拼成一段中文（尽量让用户「读一遍就知道下一步点哪」） */
function problemsToMessage(problems, opts = {}) {
  const lines = [];
  const nodeMiss = problems.filter(p => p.kind === 'node');
  const fileMiss = problems.filter(p => p.kind === 'file');
  const modelsRoot = opts.modelsRoot || '';

  if (nodeMiss.length) {
    const uniq = [...new Set(nodeMiss.map(p => p.cls))];
    lines.push('ComfyUI 缺少节点：' + uniq.join('、'));
    lines.push('  原因：你的 ComfyUI 内核较旧，或缺少配套的自定义节点。');
    lines.push('  处理：把 ComfyUI 升级到最新版（Qwen-Image 2.1 相关节点需要 v0.37.0 及以上）；');
    lines.push('        配套节点包 comic_studio_qwen21 会在启动 ComfyUI 时自动拷贝到 custom_nodes，装完需重启 ComfyUI。');
  }

  for (const p of fileMiss) {
    const cand = p.candidates || [];
    lines.push('ComfyUI 看不到模型文件：' + p.value);
    lines.push('  用到的位置：' + nodeLabel(p.cls) + ' → ' + p.input + '（节点 #' + p.nodeId + '）');
    if (!cand.length) {
      lines.push('  ComfyUI 的候选列表是空的 —— 它这个类目下一个文件都没扫到。');
    } else {
      const show = cand.slice(0, 6).map(s => '  · ' + s).join('\n');
      lines.push('  ComfyUI 当前能看到的 ' + cand.length + ' 个候选：');
      lines.push(show + (cand.length > 6 ? '\n  · …（还有 ' + (cand.length - 6) + ' 个）' : ''));
    }
    if (modelsRoot) lines.push('  软件扫描的模型目录：' + modelsRoot);
    lines.push('  处理：让 ComfyUI 的模型目录指向上面这个目录（设置 → 模型管家 →「让 ComfyUI 读取此目录」），改完重启 ComfyUI。');
  }

  if (lines.length) lines.push('（这是软件在提交前对照 ComfyUI 的节点表做的检查，不会再提交一次注定失败的任务。）');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * `/prompt` 400 响应的中文翻译（提交前对账失败/被绕过时的兜底）
 * ------------------------------------------------------------------ */

/**
 * 把 ComfyUI 的校验失败 JSON 翻译成中文。
 * 认三种：missing_node_type / prompt_outputs_failed_validation / 其它
 * @returns {string} 空串 = 不认识，调用方保留原文
 */
function explainPromptError(json) {
  if (!json || typeof json !== 'object') return '';
  const err = json.error || {};
  const type = String(err.type || '');
  const msg = String(err.message || err.details || '');

  if (type === 'missing_node_type' || /not found\. The custom node may not be installed/i.test(msg)) {
    const m = msg.match(/Node\s*'([^']+)'\s*not found/i) || msg.match(/Node\s+(\S+)\s+not found/i);
    const cls = m ? m[1] : '';
    return 'ComfyUI 缺少节点' + (cls ? '「' + cls + '」' : '') + '：\n'
      + '  原因：你的 ComfyUI 内核较旧（Qwen-Image 2.1 相关节点需要 v0.37.0 及以上），或配套自定义节点没装。\n'
      + '  处理：升级 ComfyUI 后重启；配套节点包 comic_studio_qwen21 会自动装进 custom_nodes，装完同样要重启 ComfyUI。';
  }

  const nodeErrors = json.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object') {
    const lines = [];
    for (const [id, ent] of Object.entries(nodeErrors)) {
      const cls = (ent && ent.class_type) || '';
      for (const e of (ent && ent.errors) || []) {
        const et = String(e.type || '');
        const details = String(e.details || e.message || '');
        if (et === 'value_not_in_list' || /not in \[/i.test(details)) {
          // 形如 `unet_name: 'x.safetensors' not in []`
          const m = details.match(/^([\w.]+):\s*'([^']*)'\s*not in\s*(\[[\s\S]*\])$/);
          const field = m ? m[1] : String(e.input_name || e.extra_info && e.extra_info.input_name || '');
          const value = m ? m[2] : String(e.received_value || '');
          let cand = [];
          // 🔴 这个列表是 Python repr（单引号），不是 JSON —— JSON.parse 会 100% 失败，
          //    失败后就误报「候选列表是空的」。直接抽引号里的字符串。
          if (m) cand = (m[3].match(/'[^']*'|"[^"]*"/g) || []).map(s => s.slice(1, -1));
          lines.push('ComfyUI 不认这个值' + (value ? '：' + value : '') + (field ? '（' + (cls ? nodeLabel(cls) + ' → ' : '') + field + '，节点 #' + id + '）' : ''));
          if (!cand.length) lines.push('  ComfyUI 这个类目的候选列表是空的 —— 它的模型目录里一个文件都没扫到。');
          else lines.push('  ComfyUI 能看到的候选：' + cand.slice(0, 6).join('、') + (cand.length > 6 ? ' …' : ''));
          lines.push('  处理：确认 ComfyUI 的模型目录指向软件用的模型目录（设置 → 模型管家 →「让 ComfyUI 读取此目录」），改完重启 ComfyUI。');
        } else if (et === 'required_input_missing') {
          lines.push('节点 #' + id + (cls ? '（' + nodeLabel(cls) + '）' : '') + ' 缺少必填输入：' + details);
        } else if (et === 'exception_during_validation') {
          lines.push('节点 #' + id + (cls ? '（' + nodeLabel(cls) + '）' : '') + ' 校验时报错：' + details);
        } else if (et === 'bad_linked_input' || et === 'invalid_input_type') {
          lines.push('节点 #' + id + (cls ? '（' + nodeLabel(cls) + '）' : '') + ' 输入类型不对：' + details);
        } else if (details) {
          lines.push('节点 #' + id + (cls ? '（' + nodeLabel(cls) + '）' : '') + '：' + details);
        }
      }
    }
    if (lines.length) {
      lines.push('（这是 ComfyUI 自己返回的校验结果，已翻译。）');
      return lines.join('\n');
    }
  }

  if (type === 'prompt_outputs_failed_validation') return 'ComfyUI 校验工作流失败：' + (msg || '未知原因');
  return '';
}

/* ------------------------------------------------------------------ *
 * ComfyUI 实际读的是哪个模型目录
 * ------------------------------------------------------------------ */

/** 极简 YAML 读取：只需要 base_path 与几行「类目: 相对路径」，不引第三方库 */
function readYamlLite(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const out = { _file: file, base_path: '', dirs: {} };
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const top = raw.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (top && !/^\s/.test(raw)) {
      cur = top[1];
      const v = top[2].trim();
      if (cur === 'base_path' && v) out.base_path = v;
      continue;
    }
    const kv = raw.match(/^\s+([\w.-]+)\s*:\s*(.*)$/);
    if (kv) {
      const k = kv[1];
      let v = kv[2].trim().replace(/^['"]|['"]$/g, '');
      if (k === 'base_path' && v) out.base_path = v;
      else if (v) out.dirs[k] = v;
    }
  }
  return out;
}

/** Desktop 版配置：%APPDATA%\ComfyUI\extra_models_config.yaml */
function desktopConfigFiles() {
  const out = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  out.push(path.join(appData, 'ComfyUI', 'extra_models_config.yaml'));
  out.push(path.join(appData, 'ComfyUI', 'extra_model_paths.yaml'));
  // 老版 Desktop 把配置放在安装目录里
  return out;
}

/**
 * Comfy Desktop **真正下发给 ComfyUI** 的配置（2026-10-18 新增）
 *
 * Desktop 启动实例时带的是：
 *   `--extra-model-paths-config "%APPDATA%\Comfy Desktop\instance-model-paths\inst-XXXX.yaml"`
 * 每个实例一个文件，内容形如：
 *   comfy.desktop_0:
 *     base_path: 'E:\Comfy-Desktop\ComfyUI-Shared\models'
 *     is_default: true
 *     vae: 'vae/'
 *
 * 🔴 为什么不读 %APPDATA%\ComfyUI\extra_models_config.yaml：
 *    那是 Desktop 早期版本的全局文件，现在既不更新、也不会被传给 ComfyUI。
 *    本机就被它坑过 —— base_path 指向一个**早已不存在**的目录，界面据此报了「不一致」，
 *    而用户实际的模型目录完全正确。**只认真正生效的这份，不做降级兜底。**
 */
function desktopInstanceConfigFiles() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(appData, 'Comfy Desktop', 'instance-model-paths');
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)); } catch (_) { return []; }
  return names
    .map(f => { const p = path.join(dir, f); let t = 0; try { t = fs.statSync(p).mtimeMs; } catch (_) { /* 忽略 */ } return { p, t }; })
    .sort((a, b) => b.t - a.t)          // 最新生成的那份最可能是当前实例
    .map(x => x.p);
}

/**
 * 按 section 解析配置（一个 yaml 里可以有多个 section，各自有 base_path）
 * @returns {Array<{name:string, base_path:string, dirs:Object}>}
 */
function readYamlSections(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const top = raw.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (top && !/^\s/.test(raw)) {
      cur = { name: top[1], base_path: '', dirs: {} };
      out.push(cur);
      continue;
    }
    const kv = raw.match(/^\s+([\w.-]+)\s*:\s*(.*)$/);
    if (!kv || !cur) continue;
    const k = kv[1];
    const v = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (!v) continue;
    if (k === 'base_path') cur.base_path = v;
    else cur.dirs[k] = v;
  }
  return out.filter(s => s.base_path);
}

/** 把一个 section 的 base_path / 类目换算成 models 根目录 */
function sectionModelsDir(sec, configFile, installDir) {
  const base = sec.base_path ? String(sec.base_path).replace(/[\\/]+$/, '') : '';
  const ck = String(sec.dirs.checkpoints || sec.dirs.diffusion_models || sec.dirs.vae || '');
  const dl = String(sec.dirs.download_model_base || '');
  let dir = '';
  // 🔴 三种真实写法都见过：
  //   ① Desktop：base_path + `download_model_base: models` → 模型在 <base_path>\models
  //   ② 便携包：base_path + `checkpoints: models/checkpoints/` → 同上
  //   ③ base_path 本身就是 models 目录
  if (base) {
    if (/[\\/]models$/i.test(base)) dir = base;
    else if (dl) dir = path.join(base, dl);
    else if (/^models[\\/]/.test(ck)) dir = path.join(base, 'models');
    else dir = base;
  } else if (installDir) {
    dir = path.join(installDir, 'models');
  }
  if (dir && !path.isAbsolute(dir)) dir = path.resolve(path.dirname(configFile), dir);
  if (/[\\/]models[\\/](checkpoints)([\\/].*)?$/i.test(dir)) dir = dir.replace(/[\\/](checkpoints)([\\/].*)?$/i, '');
  return dir;
}

/**
 * 推断 ComfyUI 实际读取的模型根目录（只读，绝不写）。
 * @param {string} installDir ComfyUI 安装目录（launcher.comfyInfo().installDir）
 * @param {string} [desktopExeDir] Desktop 安装目录（有 Comfy Desktop.exe 的那层）
 * @returns {{modelsDir:string, basePath:string, source:string, configFile:string, dirs:Object}}
 */
function comfyModelPaths(installDir, desktopExeDir) {
  const cands = [];

  // ① Desktop：它真正传给 ComfyUI 的实例配置（唯一权威来源）
  for (const f of desktopInstanceConfigFiles()) cands.push({ f, src: 'Comfy Desktop 实例配置' });
  // ② 便携包 / 源码：安装目录下的 extra_model_paths.yaml
  for (const d of [installDir, desktopExeDir]) {
    if (!d) continue;
    cands.push({ f: path.join(d, 'extra_model_paths.yaml'), src: 'ComfyUI extra_model_paths.yaml' });
    cands.push({ f: path.join(d, 'ComfyUI', 'extra_model_paths.yaml'), src: 'ComfyUI extra_model_paths.yaml' });
    cands.push({ f: path.join(d, '..', 'extra_model_paths.yaml'), src: 'ComfyUI extra_model_paths.yaml' });
  }

  for (const c of cands) {
    if (!fs.existsSync(c.f)) continue;
    const secs = readYamlSections(c.f);
    if (!secs.length) continue;
    // 有 is_default: true 的优先（Desktop 用它标记主目录）
    const sec = secs.find(s => /^true$/i.test(String(s.dirs.is_default || ''))) || secs[0];
    const modelsDir = sectionModelsDir(sec, c.f, installDir);
    if (!modelsDir) continue;
    return {
      modelsDir, basePath: sec.base_path || '', source: c.src, configFile: c.f, dirs: sec.dirs,
      // 配置里写的目录可能早就被删/搬走 —— 如实标出来，由界面直接报错
      exists: fs.existsSync(modelsDir)
    };
  }

  // ③ 没有任何配置 → ComfyUI 自己的默认 models
  if (installDir) {
    for (const d of [path.join(installDir, 'models'), path.join(installDir, 'ComfyUI', 'models')]) {
      if (fs.existsSync(d)) return { modelsDir: d, basePath: '', source: 'ComfyUI 安装目录下的 models（默认）', configFile: '', dirs: {}, exists: true };
    }
  }
  return { modelsDir: '', basePath: '', source: '', configFile: '', dirs: {}, exists: false };
}

/**
 * ComfyUI 会读取的**全部** models 根目录（存在的才算）。
 *
 * extra_model_paths 的语义是「追加」而不是「替换」：ComfyUI 始终会扫自己根目录下的
 * `models`，再把配置里的 base_path 加进来。所以判断「用户选对没有」要看集合，而不是单个路径。
 */
function comfyModelsRoots(info) {
  const installDir = (info && info.installDir) || '';
  const out = [];
  const add = (d) => {
    if (!d) return;
    let a = '';
    try { a = path.resolve(d); } catch (_) { return; }
    if (!out.some(x => samePath(x, a))) out.push(a);
  };
  const p = comfyModelPaths(installDir, (info && info.exe) ? path.dirname(info.exe) : '');
  if (p.modelsDir) add(p.modelsDir);
  if (installDir) {
    add(path.join(installDir, 'models'));
    add(path.join(installDir, 'ComfyUI', 'models'));
  }
  try {
    for (const c of comfySetup.customNodesCandidates(installDir)) {
      if (c.comfyRoot) add(path.join(c.comfyRoot, 'models'));
    }
  } catch (_) { /* 实例探测失败不影响 */ }
  return out.filter(d => isDirPath(d));
}

/**
 * 用户选了「ComfyUI 安装目录」之后，自动推出它下面的 models 目录。
 * 只返回**真实存在**的目录；推不出来就 ok:false（界面直接报错，不猜、不兜底）。
 * @returns {{ok:boolean, modelsRoot:string, source:string, reason:string}}
 */
function resolveModelsFromInstall(dir) {
  const abs = dir ? path.resolve(String(dir).trim()) : '';
  if (!abs || !isDirPath(abs)) return { ok: false, modelsRoot: '', source: '', reason: '这个目录不存在。' };

  const cand = [];
  const push = (d, src) => { if (d && isDirPath(d)) cand.push({ d, src }); };

  // 只认真正像 ComfyUI 本体的目录 —— 否则随便选个文件夹也会"推导成功"（错得很隐蔽）
  // ComfyUI-Shared / ComfyUI-Installs 是 Comfy Desktop 的安装根特征（没建实例时也有）
  const looksComfy = fs.existsSync(path.join(abs, 'main.py'))
    || fs.existsSync(path.join(abs, 'ComfyUI', 'main.py'))
    || fs.existsSync(path.join(abs, 'custom_nodes'))
    || fs.existsSync(path.join(abs, 'Comfy Desktop.exe'))
    || fs.existsSync(path.join(abs, 'ComfyUI-Shared'))
    || fs.existsSync(path.join(abs, 'ComfyUI-Installs'));

  // ① 已经选到 models 本身
  if (path.basename(abs).toLowerCase() === 'models') push(abs, '所选目录就是 models');
  // ② ComfyUI 本体所在目录（源码/便携实例）
  if (looksComfy) push(path.join(abs, 'models'), 'ComfyUI 安装目录下的 models');
  // ③ 便携包根目录：<root>\ComfyUI\models
  push(path.join(abs, 'ComfyUI', 'models'), '便携包的 ComfyUI\\models');
  // ④ Desktop：实例配置里写的共享目录（只对 ComfyUI 目录可信，避免随便选个目录也"推导成功"）
  if (looksComfy) {
    try {
      const p = comfyModelPaths(abs, '');
      if (p.modelsDir) push(p.modelsDir, 'Comfy Desktop 实例配置');
      for (const c of comfySetup.customNodesCandidates(abs)) {
        if (c.comfyRoot) push(path.join(c.comfyRoot, 'models'), 'ComfyUI 实例下的 models');
      }
    } catch (_) { /* 忽略 */ }
  }
  // ⑤ Desktop 布局：共享目录（实例之外，装完 Desktop 就有）/ 各实例自己的 models
  if (looksComfy) push(path.join(abs, 'ComfyUI-Shared', 'models'), 'ComfyUI Desktop 共享目录');
  const parent = path.dirname(abs);
  if (looksComfy && parent && parent !== abs) {
    push(path.join(parent, 'ComfyUI-Shared', 'models'), 'ComfyUI Desktop 共享目录');
    // 用户可能选在「安装根」或直接选在「ComfyUI-Installs」这一层，两种都要能扫到实例
    for (const instRoot of [path.join(parent, 'ComfyUI-Installs'), path.join(abs, 'ComfyUI-Installs')]) {
      try {
        for (const e of fs.readdirSync(instRoot, { withFileTypes: true })) {
          if (e.isDirectory()) push(path.join(instRoot, e.name, 'ComfyUI', 'models'), 'ComfyUI 实例下的 models');
        }
      } catch (_) { /* 不是 Desktop 布局 */ }
    }
  }

  const hit = cand[0];
  if (hit) return { ok: true, modelsRoot: hit.d, source: hit.src, reason: '' };
  return {
    ok: false, modelsRoot: '', source: '',
    reason: '这个目录里没找到 models。请选 ComfyUI 本体所在目录（含 main.py 或 ComfyUI 文件夹的那层）。'
  };
}


/* ------------------------------------------------------------------ *
 * ComfyUI 版本（2026-10-18）
 * ------------------------------------------------------------------ *
 * 工作流里用到 `TextEncodeQwenImage21`，这个节点 **v0.37.0** 才有。
 * 版本不够 = 出图必报「Node not found」，所以模型管家选完目录就顺手查一次。
 *
 * 判定顺序：
 *   ① 它在跑 → 直接问 `/object_info/TextEncodeQwenImage21` 在不在（最硬，绕开版本号）
 *              再问 `/system_stats` 拿 `system.comfyui_version`（用于显示）
 *   ② 没在跑 → 读 ComfyUI 根目录的 `comfyui_version.py`（不开 ComfyUI 也能知道）
 *   ③ 都拿不到 → ok:null（未知）。⚠ 未知不标红、不拦人，只提示「启动后可识别」。
 */
const MIN_COMFY_VERSION = '0.37.0';
/** 版本不够时出问题的那条工作流节点（存在性比版本号更可靠） */
const VERSION_NODE = 'TextEncodeQwenImage21';
/** 软件自带的节点：只有运行中的 ComfyUI 真的加载了它，才算「节点已就绪」 */
const OWN_NODE = 'EmptyQwenImage21LatentImage';

/** '0.37.4' → [0,37,4]；取不到数字返回 null */
function parseVer(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** 1 = a 新、0 = 相同、-1 = a 旧、null = 有一边看不懂 */
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/**
 * 探测 ComfyUI 版本。
 *
 * 🔴 只在 ComfyUI **运行中**才判版本（2026-10-18 用户拍板）。
 *    原因：磁盘上可能装了多个实例（本机就有一个 v0.34.0 和一个 v0.37.4），
 *    读 `comfyui_version.py` 永远不知道当前用的是哪一个 —— 之前就因为读到旧实例
 *    误报「版本太低」，等 ComfyUI 启动后又变正常，用户看到的是「玄学」。
 *    运行中的实例自报的 `/system_stats` + `/object_info/TextEncodeQwenImage21`
 *    才是唯一准确的答案。
 *    没启动 → `pending: true`，界面显示「请先启动 ComfyUI 实例」。
 *
 * @returns {Promise<{text:string,num:string,min:string,ok:boolean|null,source:string,
 *                    hasNode:boolean|null,pending:boolean}>}
 */
async function detectVersion(info, running, ep) {
  const out = {
    text: '', num: '', min: MIN_COMFY_VERSION, ok: null, source: '',
    hasNode: null, pending: false
  };
  const base = String(ep || '').replace(/\/+$/, '');
  if (!running || !base) { out.pending = true; return out; }

  // ① 版本号（用于显示）
  try {
    const r = await getJson(base + '/system_stats', 3000);
    const v = r && r.ok && r.json && r.json.system && r.json.system.comfyui_version;
    if (v) { out.num = String(v); out.text = 'v' + String(v).replace(/^v/i, ''); out.source = 'system_stats'; }
  } catch (_) { /* 老版本可能没有这个字段 */ }

  // ② 节点存不存在 = 最终答案（比版本号硬：自编译/打补丁的版本号可能不准）
  try {
    const q = await objectInfo(base, [VERSION_NODE], { fresh: true, timeoutMs: 3000 });
    if (q && q.ok) {
      out.hasNode = !!q.defs[VERSION_NODE];
      out.ok = out.hasNode;
      if (out.hasNode && !out.source) out.source = 'object_info';
      return out;
    }
  } catch (_) { /* 问不到就退回版本号比较 */ }

  // ③ 兜底：只按版本号比
  if (out.num) {
    const c = cmpVer(out.num, MIN_COMFY_VERSION);
    out.ok = c === null ? null : c >= 0;
  }
  return out;
}

/**
 * 给「模型管家」用的体检：把软件视角与 ComfyUI 视角并排摆出来。
 * 只做只读探测，不改任何东西。
 * @param {{installDir:string, kind:string, label:string, endpoint:string}} info launcher.comfyInfo()
 * @param {{modelsRoot:string}} mopt  软件侧的模型根
 */
async function diagnose(info, mopt = {}) {
  const installDir = (info && info.installDir) || '';
  const ep = (info && info.endpoint) || 'http://127.0.0.1:8188';
  const paths = comfyModelPaths(installDir, (info && info.exe) ? path.dirname(info.exe) : '');
  const roots = comfyModelsRoots(info);

  let running = false, totalFiles = 0, dirs = {};
  let hasOwnNode = null;          // 运行中的 ComfyUI 是否真的加载了自带节点
  try {
    const r = await getJson(ep.replace(/\/+$/, '') + '/object_info/UNETLoader', 3000);
    running = !!(r && r.ok && r.json);
  } catch (_) { running = false; }

  // 版本：选完模型目录就自动查一次（版本不够 → 出图必报节点不存在）
  const ver = await detectVersion(info, running, ep);

  if (running) {
    // 真的在跑 → 直接问它「你认识哪些模型」，比猜配置准
    const names = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoader', 'CheckpointLoaderSimple'];
    const probe = await objectInfo(ep, names, { fresh: true, timeoutMs: 5000 });
    const pick = (cls, field) => {
      const def = probe.defs[cls];
      const cand = def ? comboOptions(inputSpecs(def)[field]) : null;
      return cand || [];
    };
    dirs = {
      diffusion_models: pick('UNETLoader', 'unet_name'),
      text_encoders: [...new Set([...pick('CLIPLoader', 'clip_name'), ...pick('DualCLIPLoader', 'clip_name1')])],
      vae: pick('VAELoader', 'vae_name'),
      loras: pick('LoraLoader', 'lora_name'),
      checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name')
    };
    totalFiles = Object.values(dirs).reduce((a, b) => a + b.length, 0);

    // 自带节点「真的被加载了吗」—— 这是「节点已就绪」唯一可信的证据。
    // 文件躺在 custom_nodes 里不代表生效（ComfyUI 只在启动时扫一次）。
    try {
      const q = await objectInfo(ep, [OWN_NODE], { fresh: true, timeoutMs: 4000 });
      if (q && q.ok) hasOwnNode = !!q.defs[OWN_NODE];
    } catch (_) { /* 问不到就保持 null（未知） */ }
  }

  // 配套节点状态：磁盘事实 + 运行实证，一起决定界面上那个徽标
  let nodePkgs = null;
  try { nodePkgs = comfySetup.nodePkgsState(installDir); } catch (_) { nodePkgs = null; }

  /**
   * Comfy Desktop 的实例台账（只读）。
   * 🔴 用途是**区分**「没装 ComfyUI」和「装了但一个实例都没建」——这两种情况的
   *    用户动作完全不同（去下载 vs 去 Desktop 里新建实例）。不要合成一句"未配置"。
   */
  let desk = { hasApp: false, list: [] };
  try { desk = comfySetup.desktopInstances(); } catch (_) { /* 读不到就当没有台账 */ }
  const noInstance = !!desk.hasApp && desk.list.length === 0;
  let nodeState = 'absent';
  if (nodePkgs && nodePkgs.available) {
    if (!nodePkgs.upToDate) nodeState = 'missing';          // 磁盘上没有 / 不是最新
    else if (!running) nodeState = 'standby';               // 装好了，等 ComfyUI 启动时加载
    else if (hasOwnNode === true) nodeState = 'ready';      // 运行中且真的加载了
    else if (hasOwnNode === false) nodeState = 'restart';   // 装好了但当前实例没加载
    else nodeState = 'unknown';                             // 问了但问不到
  }

  return {
    installDir,
    installKind: (info && info.kind) || 'unknown',
    installLabel: (info && info.label) || '',
    // Comfy Desktop 台账：装了没有、建了几个实例（名字不参与判断）
    desktopHasApp: !!desk.hasApp,
    instanceCount: desk.list.length,
    instanceNames: desk.list.map(x => x.name).filter(Boolean),
    noInstance,
    endpoint: ep,
    running,
    // ComfyUI 版本（ok:true 达标 / false 太低 / null 未知）
    version: ver,
    // 配套自定义节点（全部包：EmptyQwenImage21LatentImage 只是其中之一）
    nodes: nodePkgs,
    // ready=已加载 / standby=已装好待启动 / restart=需重启 / missing=未安装 / unknown=问不到
    nodeState,
    hasOwnNode,
    // ComfyUI 读取的全部 models 根（存在的才算；判断"选对没有"看这个集合）
    modelsDirs: roots,
    comfyModelsDir: paths.modelsDir,
    comfyModelsExists: !!paths.exists,
    comfyModelsSource: paths.source,
    comfyConfigFile: paths.configFile,
    // 软件侧的模型根
    modelsRoot: mopt.modelsRoot || '',
    sameDir: !!(mopt.modelsRoot && roots.some(d => samePath(d, mopt.modelsRoot))),
    // ComfyUI 现在真正认识的文件（只有它在跑时才有值）
    visible: dirs,
    visibleCount: totalFiles
  };
}

/* ------------------------------------------------------------------ *
 * 模型根目录：候选 + 校验（2026-10-18）
 * ------------------------------------------------------------------ *
 * 用户要求「模型管家必须明确让用户选 ComfyUI 的 models 目录」。
 * 只写文案不够 —— 用户可能选成 ComfyUI 程序目录、选成父级、选成工作区目录。
 * 这里给出：① 可直接点选的候选（来自 ComfyUI 自己的配置与实例布局）
 *           ② 选完立刻可判定的校验结果（存在/像 models/与 ComfyUI 是否一致）
 * 判断标准全部是"读文件系统"，不依赖 ComfyUI 在跑。
 */

// ComfyUI 的目录类目（真实模型目录里至少有其中几个）
const MODELS_CATEGORIES = [
  'diffusion_models', 'checkpoints', 'vae', 'text_encoders', 'clip',
  'loras', 'clip_vision', 'controlnet', 'upscale_models', 'style_models', 'embeddings'
];

const isDirPath = d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 这个目录像不像 ComfyUI 的 models（名字叫 models，或里面已经有标准类目子目录） */
function looksLikeModelsDir(dir) {
  if (!dir || !isDirPath(dir)) return false;
  if (/^models$/i.test(path.basename(dir))) return true;
  try {
    const subs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name.toLowerCase());
    return subs.some(n => MODELS_CATEGORIES.includes(n));
  } catch (_) { return false; }
}

/**
 * 校验用户选的模型目录（只读）。
 *
 * 判定标准只有一条：它是否在 **ComfyUI 实际读取的那几个 models 根** 里。
 * 不在 → 直接 bad（不搞「大概也能跑」的宽容判断，否则用户会在出图时才撞墙）。
 *
 * @returns {{level:'ok'|'warn'|'bad', dir, exists, isModels, comfyDir, comfyDirs,
 *            sameAsComfy, message:string, hints:string[]}}
 */
function validateModelsRoot(dir, info) {
  const abs = dir ? path.resolve(String(dir).trim()) : '';
  const roots = comfyModelsRoots(info);
  const res = {
    dir: abs, exists: false, isModels: false,
    comfyDir: roots[0] || '', comfyDirs: roots, sameAsComfy: null,
    level: 'bad', message: '', hints: []
  };
  if (!abs) {
    res.message = '还没选择 ComfyUI 安装目录。';
    res.hints.push('点「选择 ComfyUI 安装目录…」，选 ComfyUI 本体所在的那一层。');
    return res;
  }

  res.exists = isDirPath(abs);
  res.isModels = looksLikeModelsDir(abs);
  res.sameAsComfy = roots.length ? roots.some(r => samePath(r, abs)) : null;

  if (!res.exists) {
    res.message = '这个目录不存在。';
    res.hints.push(roots[0] ? ('ComfyUI 读的是：' + roots[0]) : '请重新选 ComfyUI 安装目录。');
    return res;
  }
  // 选到了程序目录 / 类目子目录 / 随便一个文件夹
  if (!res.isModels) {
    res.message = '这不是 ComfyUI 读取的 models 目录。';
    if (fs.existsSync(path.join(abs, 'main.py'))) res.hints.push('你选的是程序目录，它下面的 models 才是。');
    else if (MODELS_CATEGORIES.includes(path.basename(abs).toLowerCase())) res.hints.push('这是类目子目录，应该退回上一级 models。');
    else res.hints.push('请选 ComfyUI 安装目录，软件会自动找它的 models。');
    if (roots[0]) res.hints.push('ComfyUI 读的是：' + roots[0]);
    return res;
  }

  if (res.sameAsComfy) {
    res.level = 'ok';
    res.message = '✔ 这就是 ComfyUI 读取的模型目录。';
    return res;
  }
  if (roots.length) {
    res.level = 'bad';
    res.message = '这不是 ComfyUI 读取的 models 目录。';
    res.hints.push('ComfyUI 读的是：' + roots[0]);
    return res;
  }
  res.level = 'warn';
  res.message = '没解析到 ComfyUI 的模型目录配置，无法确认它会读这里。';
  res.hints.push('请确认选的是 ComfyUI 安装目录；启动一次 ComfyUI 后点「刷新」可以确认。');
  return res;
}

/** 清缓存（用户在模型管家点了「重新检测」/ 改完配置后强制重问） */
function forgetCache() { _cache = { key: '', at: 0, val: null }; }

/* ------------------------------------------------------------------ *
 * 一键对齐：让 ComfyUI 的模型目录指向软件正在用的那个
 * ------------------------------------------------------------------ *
 * 🔴 这是**唯一会写文件**的函数，只在用户点「让 ComfyUI 读取此目录」时调用。
 *    写之前一定备份（同目录 .bak-时间戳），并且**只动 base_path 一行**（其余配置原样保留）——
 *    用户可能在同一个文件里配了别的共享路径，整份重写等于替他做决定。
 */

// ComfyUI 的 folder_names_and_paths 标准类目（base_path 是它们的上级，不是 models 本身）
// 🔴 unet / clip 是老内核对同一个物理目录的旧类目名（新版已改叫 diffusion_models / text_encoders）：
//    两个都写上，老内核才扫得到 —— 我们要救的恰恰就是那批老内核。
const STD_CATEGORIES = [
  'checkpoints', 'configs', 'loras', 'vae', 'text_encoders', 'clip',
  'diffusion_models', 'unet', 'clip_vision', 'style_models', 'embeddings',
  'diffusers', 'vae_approx', 'controlnet', 'gligen', 'upscale_models',
  'hypernetworks', 'photomaker', 'classifiers', 'model_patches'
];
/** 类目名 → 实际子目录名（不写 = 同名） */
const CATEGORY_PATHS = { unet: 'diffusion_models', clip: 'text_encoders' };

/** 我们写进 ComfyUI 配置的 section 名（用独立 section，绝不覆盖用户原有的那份） */
const ALIGN_SECTION = 'comic_studio';

/** modelsRoot → { basePath, prefix }：basePath 是类目目录的上级，prefix 是类目相对 base 的前缀 */
function splitModelsRoot(modelsRoot) {
  const abs = String(modelsRoot || '').replace(/[\\/]+$/, '');
  if (!abs) return null;
  if (/[\\/]models$/i.test(abs)) return { basePath: path.dirname(abs), prefix: 'models/' };
  return { basePath: abs, prefix: '' };
}

/**
 * 在 yaml 里 upsert 一个独立 section（只加/改我们这一段，绝不整份重写）。
 * 已经存在同名 section → 只更新它的 base_path 与类目行；不存在 → 追加到文件末尾。
 */
function upsertSection(text, section, basePath, prefix, indent = '  ') {
  const src = String(text || '').replace(/\r\n/g, '\n');
  // 只在「YAML 会解析错」时才加引号：路径里常见的中划线 - 不是特殊字符，加了反而难看。
  // 🔴 双引号里反斜杠是转义符（`\C` 非法）→ 必须写成 `\\`，否则 ComfyUI 读配置直接报错。
  const needQuote = /[\s#'"&*?|>%@`]/.test(basePath) || /^[\d.+-]/.test(basePath);
  const yamlVal = needQuote
    ? '"' + basePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : basePath;
  const body = [
    indent + 'base_path: ' + yamlVal,
    ...STD_CATEGORIES.map(c => indent + c + ': ' + prefix + (CATEGORY_PATHS[c] || c) + '/')
  ];

  const lines = src.split('\n');
  const head = new RegExp('^' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*$');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) { start = i; break; }
  }

  if (start >= 0) {
    // 找这个 section 的结尾：下一个「顶格且不是注释」的行
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) { end = i; break; }
    }
    // 保留原有 section 里的其他键（is_default 等），只换 base_path、补缺失类目
    const keep = lines.slice(start + 1, end).filter(l => {
      const m = l.match(/^\s*([\w.-]+)\s*:/);
      if (!m) return false;
      return m[1] !== 'base_path' && !STD_CATEGORIES.includes(m[1]);
    });
    const out = [...lines.slice(0, start + 1), ...body, ...keep, ...(end < lines.length ? [''] : []), ...lines.slice(end)];
    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), changed: true };
  }

  const out = src.replace(/\s+$/, '');
  return {
    text: (out ? out + '\n\n' : '') + section + ':\n' + body.join('\n') + '\n',
    changed: true
  };
}

/**
 * 写 ComfyUI 的模型目录配置。
 * @returns {{ok:boolean, message:string, file?:string, backup?:string, basePath?:string, changed?:boolean}}
 */
function alignModelsConfig(info, modelsRoot) {
  const split = splitModelsRoot(modelsRoot);
  if (!split) return { ok: false, message: '还没有指定模型目录，先点「选择目录…」。' };

  const installDir = (info && info.installDir) || '';
  const exeDir = (info && info.exe) ? path.dirname(info.exe) : '';
  const isDesktop = (info && info.kind) === 'desktop';

  // 选目标文件：Desktop 用它自己维护的那份；否则用安装目录下的 extra_model_paths.yaml
  const desktopFile = desktopConfigFiles()[0];   // %APPDATA%\ComfyUI\extra_models_config.yaml
  let file = '';
  if (isDesktop && fs.existsSync(desktopFile)) file = desktopFile;
  if (!file) {
    const cands = [];
    for (const d of [installDir, exeDir]) {
      if (!d) continue;
      cands.push(path.join(d, 'extra_model_paths.yaml'));
      cands.push(path.join(d, '..', 'extra_model_paths.yaml'));
    }
    file = cands.find(f => fs.existsSync(f)) || '';
  }
  if (!file && isDesktop) file = desktopFile;              // Desktop：允许新建（目录已存在才建）
  if (!file && installDir) file = path.join(installDir, 'extra_model_paths.yaml');
  if (!file) return { ok: false, message: '没定位到 ComfyUI 的配置文件。请先在设置 → 引擎里指定 ComfyUI 安装目录。' };

  let old = '';
  try { old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch (e) {
    return { ok: false, message: '读不到 ComfyUI 配置：' + ((e && e.message) || e) };
  }

  // 🔴 只加一个独立 section（comic_studio），绝不改用户原有的 comfyui / comfyui_desktop ——
  //    改别人的 base_path 会让他原来的模型全部消失，那是比原问题更大的事故。
  const r = upsertSection(old, ALIGN_SECTION, split.basePath, split.prefix, '  ');
  if (r.text === old) {
    return { ok: true, changed: false, file, basePath: split.basePath, message: '配置已经指向该目录，无需修改。' };
  }

  // 备份（同一个文件重复点也只会多几个 .bak，不会丢原样）
  let backup = '';
  if (old) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = file + '.bak-' + stamp;
    try { fs.copyFileSync(file, backup); } catch (_) { backup = ''; }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text, 'utf8');
  } catch (e) {
    return { ok: false, message: '写 ComfyUI 配置失败：' + ((e && e.message) || e), file };
  }
  forgetCache();
  return {
    ok: true, changed: true, file, backup, basePath: split.basePath,
    message: '已写入：' + file + '\n重启 ComfyUI 后生效。'
  };
}

module.exports = {
  MODEL_EXT_RE, NODE_LABEL, nodeLabel, normRel,
  objectInfo, comboOptions, inputSpecs, verifyWorkflow, problemsToMessage,
  explainPromptError, readYamlLite, comfyModelPaths, diagnose, forgetCache,
  splitModelsRoot, upsertSection, alignModelsConfig, STD_CATEGORIES, ALIGN_SECTION,
  MODELS_CATEGORIES, looksLikeModelsDir, validateModelsRoot,
  comfyModelsRoots, resolveModelsFromInstall, readYamlSections, desktopInstanceConfigFiles,
  MIN_COMFY_VERSION, VERSION_NODE, OWN_NODE, parseVer, cmpVer, detectVersion
};
