'use strict';
/**
 * 模型管家 —— 把模型从别处「拷贝」进模型根目录的正确子目录。
 *
 * 为什么要有它：
 *   用户下载完模型后面临两个问题——① 不知道该放进 models 下的哪个子目录
 *   （要反复查文档、来回试）；② 手动放进 ComfyUI 目录里的模型会被误删，
 *   一删整个软件就不可用。本模块把这两件事一次解决：
 *     用户只做「选文件」这一个动作 → 程序按文件名特征分类、流式拷贝到位、
 *     全程给进度条；拷完原件删不删都不影响本软件工作。
 *
 * 设计原则：
 *   - 只拷贝、不移动、不删除源文件（源文件是用户的，误删责任不在我们）；
 *   - 拷到 `名称.part` 再改名 —— 避免中途失败留下半个模型被 ComfyUI / 本软件扫到；
 *   - 目标已存在且大小一致 → 跳过（重复导入不浪费一次几十 GB 的拷贝）；
 *   - 目标已存在但大小不同 → 不覆盖，列为「冲突」交给用户决定；
 *   - 目标目录 = 模型根目录下该槽位的标准子目录（用户不需要知道子目录名）。
 */
const fs = require('fs');
const path = require('path');
const { Transform, pipeline } = require('stream');
const profiles = require('./profiles.cjs');

/**
 * 槽位表 = 软件需要的每一类模型。
 *   key   : 槽位标识（唯一）
 *   sub   : 目标子目录（模型根目录下，ComfyUI 标准目录名）
 *   exts  : 认得的扩展名
 *   re    : 文件名特征 —— 决定「这个文件该放哪」，也就是用户不用再查的那张表
 *   label : 人话用途（UI 直接展示）
 *   need  : 期望文件名（给人看的例子）
 *   why   : 缺了会怎样
 *   lora  : 是加速 LoRA（体积远小于主模型，用于体积兜底判断）
 *   顺序 = 分类优先级（fl2va 必须排在 fl2v LoRA 前面，因为 "fl2va" 含子串 "fl2v"）
 */
/**
 * 静态槽位：不属于任何「模型方案」的通用项（当前只剩剧本大模型一项）。
 * 🔴 模型自己的槽位（Qwen-Image / H3 …）**不写在这里**，
 *    由各方案的 assets 段派生（见下面的 allSlots）—— 避免「方案加了新模型，
 *    模型管家却不认识这个文件该放哪」这类漏项。
 */
const STATIC_SLOTS = [
  {
    key: 'llm', sub: 'text_encoders', exts: ['.gguf'], re: /\.gguf$/i,
    // ComfyUI 侧带 vl 的 GGUF（H3 的 qwen3vl 文本编码器）不是剧本大模型，别让它当剧本模型用
    exclude: /vl/i,
    label: '剧本大模型（Qwen GGUF）', need: '举例：Qwen3.5-9B-Q5_K_M.gguf',
    why: '缺了无法改编剧本 / 生成分镜'
  }
];

/**
 * 模型方案的槽位 → 模型管家的槽位（**派生**，不再手抄一遍）。
 * 方案的 assets 里已经写清了「槽位名 = 模板占位符名、目标子目录、文件名特征、人话用途」，
 * 直接拿来用即可 —— 于是「加一套模型」= 加一份方案 JSON，模型管家清单自动跟上，
 * 不会出现「方案加了、模型管家不认识这个文件该放哪」的漏项。
 */
function safeRe(src) {
  if (!src) return null;
  try { return src instanceof RegExp ? src : new RegExp(String(src), 'i'); } catch (_) { return null; }
}

/**
 * 全部槽位 = 静态特例（llm / ckpt，不属于任何模型方案）+ 各方案 assets 派生项。
 * 🔴 惰性求值：方案要等 profiles.init(db) 之后才读得到，模块加载期固化会拿到空表。
 * 去重：同名 key 只留第一次出现的（静态优先；方案之间按 profiles.all() 的顺序）。
 */
let _slotsCache = null;
function allSlots() {
  if (_slotsCache) return _slotsCache;
  const out = [], seen = new Set();
  const push = (s) => { if (s && s.key && !seen.has(s.key)) { seen.add(s.key); out.push(s); } };
  for (const s of STATIC_SLOTS) push(s);
  let profs = [];
  try { profs = profiles.all(); } catch (_) { profs = []; }
  for (const p of profs) {
    for (const a of (p.assets || [])) {
      // 分类特征：方案可以用 importRe 单独给「跨目录猜用途」用的更严格特征
      // （match 是在已知目录里挑文件，允许带兜底分支，直接拿来分类会误判）
      const re = safeRe(a.importRe || a.match);
      if (!re) continue;   // 方案里正则写坏了：跳过这一条，不让整个清单挂掉
      push({
        key: a.slot, sub: a.dir,
        exts: (Array.isArray(a.exts) && a.exts.length) ? a.exts.map(x => String(x).toLowerCase()) : ['.safetensors'],
        re,
        exclude: safeRe(a.exclude),
        label: a.label || a.slot,
        need: a.need || '', why: a.why || '',
        // 加速 LoRA 这类小权重：体积兜底判断用（见 classify）
        lora: a.role === 'lora',
        // ⚠️ 只认 optional，不要把 required:false 当成可选 —— 两者是不同维度：
        //    h3_ref2va 是 required:false（不跑参考模式就不需要）但 optional:false
        //    （真要用它时必须报错），见 profiles.cjs 的 normalize 注释。
        optional: !!a.optional,
        profile: p.id, kind: p.kind
      });
    }
  }
  // 方案还没初始化（profiles.init 之前）时只拿得到静态项 —— 不缓存，
  // 否则第一个调用者会把「空方案表」固化下来，模型管家此后永远少一截。
  if (!profs.length) return out;
  _slotsCache = out;
  return out;
}

/** 方案重扫后清缓存（用户往工作区放了新方案 / 改了配置时调用） */
function reloadSlots() { _slotsCache = null; }

/** LoRA / 底模这类小权重文件不该超过这个体积；超了多半是主模型，交给用户确认 */
const SMALL_WEIGHT_MAX = 3 * 1024 * 1024 * 1024;

function slot(key) { return allSlots().find(s => s.key === key) || null; }
function slotBySub(sub) { return allSlots().find(s => s.sub === sub) || null; }

/** 扩展名是不是模型文件（扫描目录时用来过滤） */
function isModelFile(name) {
  const n = String(name).toLowerCase();
  return allSlots().some(s => s.exts.some(x => n.endsWith(x)));
}

/**
 * 按文件名 + 体积把文件归到某个槽位。
 * 返回 { key } 表示认出来了；{ key: null, hint } 表示认不出/存疑（UI 让用户选用途）。
 */
function classify(name, size) {
  const base = path.basename(String(name || ''));
  const low = base.toLowerCase();
  const bytes = Number(size) || 0;
  for (const s of allSlots()) {
    // 扩展名必须先对上：比如 qwen3vl 的 GGUF 不该被当成「H3 文本编码器」
    // （工作流用的是 .safetensors，放错目录等于没就位）
    if (!s.exts.some(x => low.endsWith(x))) continue;
    if (!s.re.test(base)) continue;
    // 槽位自带排除项：名字像但其实是别的东西（如 GGUF 文本编码器 ≠ 剧本大模型）
    if (s.exclude && s.exclude.test(base)) {
      return { key: null, hint: '文件名像这个用途，但特征词表明它是另一类模型 —— 请手动确认' };
    }
    // fl2v 的加速 LoRA 与 fl2va 主模型文件名特征重叠 —— 用体积兜底：
    // 小权重文件不该有几 GB，超了就有可能是主模型，不猜，交给用户。
    if (s.lora && bytes > SMALL_WEIGHT_MAX) {
      return { key: null, hint: '体积像主模型，但文件名像加速权重 —— 请手动选用途' };
    }
    return { key: s.key };
  }
  if (/\.gguf$/i.test(base)) {
    // ComfyUI 侧的 GGUF 文本编码器（H3 的 qwen3vl 有 GGUF 版）不该进 llm 目录
    if (/vl/i.test(base)) return { key: null, hint: 'GGUF 但带 vl 字样 —— 像是文本编码器而不是剧本大模型，请手动确认' };
    return { key: 'llm' };
  }
  return { key: null, hint: '文件名认不出用途' };
}

/** 递归展开用户选的路径（文件直接用；目录按深度限制扫描模型文件） */
function scanPaths(inputs, depthLimit = 3, maxFiles = 2000) {
  const out = [];
  const walk = (p, depth) => {
    if (out.length >= maxFiles) return;
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (st.isFile()) {
      if (isModelFile(path.basename(p))) out.push({ path: p, name: path.basename(p), size: st.size });
      return;
    }
    if (!st.isDirectory() || depth >= depthLimit) return;
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      walk(path.join(p, e.name), depth + 1);
    }
  };
  for (const p of inputs || []) walk(String(p), 0);
  // 同名去重（用户可能同时选了文件与它所在目录）
  const seen = new Set(), uniq = [];
  for (const f of out) {
    const k = f.path.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(f);
  }
  uniq.sort((a, b) => b.size - a.size);
  return uniq;
}

/** 生成归位计划：认出来的分槽，认不出来的列出让用户选 */
function plan(inputs) {
  const files = scanPaths(inputs);
  const items = [], unknown = [];
  for (const f of files) {
    const c = classify(f.name, f.size);
    if (c.key) items.push({ src: f.path, name: f.name, size: f.size, key: c.key, sub: slot(c.key).sub });
    else unknown.push({ src: f.path, name: f.name, size: f.size, hint: c.hint || '' });
  }
  return { items, unknown, totalBytes: items.reduce((a, b) => a + b.size, 0) };
}

/** 目标盘剩余空间（拿不到返回 -1） */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_) { return -1; }
}

/* ------------------------------------------------------------------ *
 * 带进度的拷贝
 * ------------------------------------------------------------------ */

let _cancel = false;
function cancel() { _cancel = true; }

function human(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

/**
 * 单文件流式拷贝（带字节回调、可取消）。
 * 用 pipeline + 计数 Transform，天然带回流控制（不把几十 GB 读进内存）。
 */
function copyOne(src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        if (_cancel) return cb(new Error('CANCELLED'));
        onBytes(chunk.length);
        cb(null, chunk);
      }
    });
    pipeline(rs, counter, ws, err => err ? reject(err) : resolve());
  });
}

/** 去掉失败留下的 .part 残留 */
function cleanup(p) { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } }

/**
 * 执行归位拷贝。
 * @param {Object} opt
 *   root     模型根目录（必填）
 *   tasks    [{ src, sub, name }] 已定好目标子目录的任务
 *   onProgress({phase, ...}) 进度回调
 * @returns {Object} 汇总 { ok, cancelled, copied, skipped, conflicts, failed, bytes, elapsedMs }
 */
async function run({ root, tasks, onProgress }) {
  const emit = (o) => { try { onProgress && onProgress(o) } catch (_) { /* 渲染层异常不影响拷贝 */ } };
  _cancel = false;

  if (!root) return { ok: false, error: 'NO_ROOT', message: '还没确定模型根目录，请先在设置里指定 ComfyUI 的 models 目录' };
  if (!tasks || !tasks.length) return { ok: true, copied: [], skipped: [], conflicts: [], failed: [], bytes: 0, elapsedMs: 0 };

  // 体积预检：一次拷几十 GB，空间不够要提前说，不能拷到一半失败
  const totalBytes = tasks.reduce((a, t) => a + (Number(t.size) || 0), 0);
  const free = freeBytes(root);
  if (free >= 0 && totalBytes > free) {
    return {
      ok: false, error: 'NO_SPACE',
      message: `目标盘剩余空间不足：需要约 ${human(totalBytes)}，只剩 ${human(free)}`,
      need: totalBytes, free
    };
  }

  const started = Date.now();
  const copied = [], skipped = [], conflicts = [], failed = [];
  let done = 0, tickAt = Date.now(), tickBytes = 0, speed = 0;

  emit({ phase: 'start', total: tasks.length, totalBytes, message: '开始拷贝' });

  for (let i = 0; i < tasks.length; i++) {
    if (_cancel) break;
    const t = tasks[i];
    const dir = path.join(root, t.sub);
    const dst = path.join(dir, t.name);
    const size = Number(t.size) || 0;
    emit({ phase: 'file', index: i, total: tasks.length, file: t.name, sub: t.sub, size, done, totalBytes, speed, message: `正在拷贝 ${t.name}` });

    // 已存在且大小一致 → 跳过（不重复拷几 GB）
    try {
      const ex = fs.statSync(dst);
      if (ex.size === size && size > 0) {
        done += size; skipped.push({ name: t.name, sub: t.sub });
        emit({ phase: 'tick', index: i, total: tasks.length, file: t.name, done, totalBytes, percent: totalBytes ? done / totalBytes : 1, message: `${t.name} 已存在，跳过` });
        continue;
      }
      conflicts.push({ name: t.name, sub: t.sub, size, existing: ex.size });
      emit({ phase: 'tick', file: t.name, done, totalBytes, percent: totalBytes ? done / totalBytes : 1, level: 'warn', message: `${t.name} 目标已有一份不同大小的文件，未覆盖（冲突 ${conflicts.length}）` });
      continue;
    } catch (_) { /* 不存在 = 正常要拷 */ }

    const tmp = dst + '.part';
    try {
      fs.mkdirSync(dir, { recursive: true });
      cleanup(tmp);
      await copyOne(t.src, tmp, (n) => {
        done += n; tickBytes += n;
        const now = Date.now();
        if (now - tickAt >= 300) {              // 300ms 一次，避免刷爆 IPC
          speed = tickBytes / ((now - tickAt) / 1000);
          tickAt = now; tickBytes = 0;
          emit({
            phase: 'tick', index: i, total: tasks.length, file: t.name, sub: t.sub,
            size, done, totalBytes, speed,
            percent: totalBytes ? done / totalBytes : 0,
            message: `正在拷贝 ${t.name}`
          });
        }
      });
      // 取消请求可能在拷贝刚结束时才到：此时还没改名，按未完成处理，删掉临时文件
      if (_cancel) { cleanup(tmp); break }
      fs.renameSync(tmp, dst);
      copied.push({ name: t.name, sub: t.sub, size });
      emit({ phase: 'tick', index: i, total: tasks.length, file: t.name, fileDone: 1, done, totalBytes, speed, percent: totalBytes ? done / totalBytes : 1, message: `${t.name} 拷贝完成` });
    } catch (e) {
      cleanup(tmp);
      if (_cancel) break;
      failed.push({ name: t.name, sub: t.sub, error: String((e && e.message) || e) });
      emit({ phase: 'tick', file: t.name, done, totalBytes, percent: totalBytes ? done / totalBytes : 0, level: 'error', message: `${t.name} 拷贝失败：${(e && e.message) || e}` });
    }
  }

  const cancelled = _cancel;
  const result = {
    ok: !failed.length, cancelled,
    copied, skipped, conflicts, failed,
    bytes: done, elapsedMs: Date.now() - started,
    freed: freeBytes(root)
  };
  emit({ phase: 'done', done, totalBytes, percent: totalBytes ? Math.min(1, done / totalBytes) : 1, result, message: cancelled ? '已取消' : '拷贝结束' });
  return result;
}

/**
 * 槽位现状（给 UI 渲染清单）：每个槽位在当前生效的目录里命中几个文件。
 * 目录用 models.resolveDir 解析 —— 用户手改过路径（modelpath.*）时也跟着走，
 * 所以「已就位」的判断和生成时真正用的目录完全一致。
 */
function slotsState(models) {
  const root = models.modelsRoot() || '';
  const rows = allSlots().map(s => {
    // llm 的 GGUF 也落在标准目录 text_encoders 里（与文本编码器同目录），
    // 但老布局（模型根下 llm\、项目 runtime\models\llm）仍可能命中 —— 交给 resolveDir 判
    let dir = '';
    try { dir = models.resolveDir(s.key === 'llm' ? 'llm' : s.sub) || '' } catch (_) { dir = '' }
    if (!dir && root) dir = path.join(root, s.sub);
    let hits = [];
    if (dir) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { names = []; }
      hits = names.filter(n => s.exts.some(x => n.toLowerCase().endsWith(x)) && s.re.test(n));
    }
    return {
      key: s.key, sub: s.sub, label: s.label, need: s.need, why: s.why,
      optional: !!s.optional,
      target: root ? path.join(root, s.sub) : '',        // 导入的落点（统一在模型根下）
      dir, ok: hits.length > 0, count: hits.length, sample: hits.slice(0, 3)
    };
  });
  return {
    root, rootOk: !!root && models.scoreRoot(root) > 0,
    slots: rows,
    // 可选槽位（加速 LoRA / 其它方案的备选底模）缺了不算「没就绪」——
    // 由方案里的 optional 声明，不再按 key 名点名。
    ready: rows.filter(r => !r.optional).every(r => r.ok),
    free: root ? freeBytes(root) : -1,
    freeText: root ? human(freeBytes(root)) : ''
  };
}

module.exports = {
  allSlots, reloadSlots, slot, slotBySub, classify, isModelFile, scanPaths, plan,
  run, cancel, slotsState, freeBytes, human, SMALL_WEIGHT_MAX,
  /** 兼容旧写法：读一次全量槽位（惰性求值，方案重扫后要 reloadSlots） */
  get SLOTS() { return allSlots(); }
};
