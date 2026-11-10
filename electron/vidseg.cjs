'use strict';
/**
 * 白膜视频的「切段 / 拼接 / 叠音 / 裁尾」（2026-11-09）。
 *
 * 背景：H3 单次只能出 4~15 秒，而白膜要求成片长度 = 参考视频长度。
 * 于是：参考视频按上限切成 N 段 → 每段各跑一次生成 → 拼回一条 → 叠原始音轨 → 裁到原时长。
 *
 * 🔴 这个模块**只做 ffmpeg 搬运**，不碰推理核心（inference.cjs 一行不动）：
 *    - 切段（slice）  : 参考视频按时间窗切成 N 个片段（无音轨，供模型当参考视频）
 *    - 归一（norm）   : 生成的每段裁到该段应有的精确时长（重编码，保证能无损 concat）
 *    - 拼接（concat） : N 段拼成一条
 *    - 叠音（mux）    : 把**原始视频**的音轨整条贴回成片（保留声音模式）
 *    - 裁尾（trim）   : 末尾按原视频时长 `-t` 收口
 *
 * 为什么每段都要重编码裁时长：模型按「秒数」出片，实际帧数会被对齐到方案的帧网格
 * （如 13 秒 → 328 帧 = 13.667 秒），所以生成结果**总是比该段应有的长度长一点点**。
 * 不裁的话拼接后会越拼越长，最后一刀会把最后一段的动作砍掉一大截。
 * 逐段先裁到精确时长再拼，总长就正好等于原视频。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tools = require('./tools.cjs');

/** 单段时长上限（秒）—— H3 方案 frames.seconds 的上界 */
const DEFAULT_MAX_SEC = 15;
/** 单段时长下限（秒）—— H3 方案 frames.seconds 的下界 */
const DEFAULT_MIN_SEC = 4;
/** 段数上限（超过就提示用户先把片子剪短） */
const MAX_SEGMENTS = 6;

/* ------------------------------------------------------------------ *
 * 基础：跑 ffmpeg / ffprobe
 * ------------------------------------------------------------------ */

/** 内置 ffmpeg 路径；找不到返回 null */
function ffmpegBin() { return tools.ffmpeg() || null; }

/** 与 ffmpeg 同目录的 ffprobe；找不到返回 null */
function ffprobeBin(ffmpegPath) { return tools.ffprobe(ffmpegPath) || null; }

/**
 * 跑一个子进程，收 stdout / stderr。
 * ⚠️ stdout 要单独收（ffprobe 的 json 走 stdout），stderr 是 ffmpeg 的日志（成功时也很大）。
 */
function run(bin, args, timeoutMs = 600000) {
  return new Promise(resolve => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e) });
    }
    p.stdout.on('data', d => { out += d; if (out.length > 8 << 20) out = out.slice(-4 << 20); });
    p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} }, timeoutMs);
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e) }); });
  });
}

/**
 * 从 ffmpeg 的 stderr 里挑出「真正说明原因」的几行。
 * 🔴 直接 slice 尾巴时，经常整段都是 x264 的统计行，真错误早被挤出去了 —— 等于没有错误信息。
 */
function errTail(err, n = 600) {
  const all = String(err || '');
  const hit = all.split(/\r?\n/).filter(l =>
    /error|failed|invalid|not match|do not match|no such|could not|unable to|invalid data/i.test(l));
  const s = hit.length ? hit.slice(-6).join('\n') : all;
  return s.slice(-n) || '（ffmpeg 没有输出错误信息）';
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 探测视频：时长 / 分辨率 / 帧率 / 有没有音轨。
 * @returns {ok, error?, durationSec, width, height, fps, hasAudio}
 */
async function probe(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, error: '源视频不存在：' + file };
  const ff = ffmpegBin();
  if (!ff) return { ok: false, error: 'NOPATH' };
  const fp = ffprobeBin(ff);
  if (!fp) return { ok: false, error: 'NOPATH' };
  const r = await run(fp, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
  if (r.code !== 0) return { ok: false, error: errTail(r.err, 500) };
  let j = {};
  try { j = JSON.parse(r.out || '{}'); } catch (_) { return { ok: false, error: 'ffprobe 输出无法解析' }; }
  const streams = j.streams || [];
  const vs = streams.find(s => s.codec_type === 'video');
  const as = streams.find(s => s.codec_type === 'audio');
  let dur = parseFloat((j.format && j.format.duration) || (vs && vs.duration) || '0') || 0;
  if (!(dur > 0)) {
    // 某些容器 format.duration 缺失，退回逐流取最大时长
    for (const s of streams) {
      const d = parseFloat(s.duration || '0') || 0;
      if (d > dur) dur = d;
    }
  }
  let fps = 0;
  const fr = vs && (vs.avg_frame_rate || vs.r_frame_rate);
  if (fr && String(fr).indexOf('/') > 0) {
    const [a, b] = String(fr).split('/').map(Number);
    if (a > 0 && b > 0) fps = a / b;
  }
  return {
    ok: true,
    durationSec: dur,
    width: (vs && vs.width) || 0,
    height: (vs && vs.height) || 0,
    fps: fps || 0,
    hasAudio: !!as
  };
}

/* ------------------------------------------------------------------ *
 * 切段计划
 * ------------------------------------------------------------------ */

/**
 * 算切段计划（**不落盘**，纯计算，便于界面先显示计划再决定要不要跑）。
 *
 * 规则：
 *  - 段数 = ceil(总时长 / 上限)，即「段数最少」；
 *  - 段长**等分**（不是「先切满 15 秒再切尾巴」）：尾巴段太短会让模型按 4 秒下限生成，
 *    多出一大截模型编出来的内容被裁掉，白烧算力。等分没有这个问题。
 *
 * @param totalSec 源视频总时长（秒）
 * @param maxSec 单段上限（秒）
 * @returns {ok, error?, totalSec, count, segDur, segments:[{index,startSec,durSec,seconds}]}
 */
function planSegments(totalSec, maxSec = DEFAULT_MAX_SEC, minSec = DEFAULT_MIN_SEC) {
  const total = Number(totalSec);
  if (!(total > 0)) return { ok: false, error: '读不出参考视频的时长' };
  const max = Math.max(1, Number(maxSec) || DEFAULT_MAX_SEC);
  let count = Math.ceil(total / max);
  if (count > MAX_SEGMENTS) {
    return { ok: false, error: '参考视频 ' + total.toFixed(1) + ' 秒，按 ' + max + ' 秒一段要切 ' + count + ' 段，超过上限 ' + MAX_SEGMENTS + ' 段。请先把片子剪短再生成。' };
  }
  count = Math.max(1, count);
  const segDur = total / count;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const startSec = i * segDur;
    // 末段吃掉浮点误差，保证 sum(段长) === 总长
    const durSec = (i === count - 1) ? (total - startSec) : segDur;
    // 交给模型的秒数：取整（模型只吃整数秒），并夹到方案声明的区间
    let seconds = Math.round(durSec);
    if (seconds < minSec) seconds = minSec;
    if (seconds > max) seconds = max;
    segments.push({ index: i, startSec, durSec, seconds });
  }
  return { ok: true, totalSec: total, count, segDur, segments };
}

/**
 * 按计划把参考视频切成 N 个片段文件（无音轨）。
 * 切片用 `-ss`（输入侧 seek）+ 重编码：`-c copy` 的切点只能落在关键帧上，
 * 切出来的片段起点会漂几十毫秒 —— 参考视频的内容对不上，生成的动作也就对不上。
 *
 * @param file 源视频
 * @param workDir 产物目录（放切片）
 * @param plan planSegments() 的结果
 * @returns {ok, error?, segments:[{index,file,startSec,durSec,seconds}]}
 */
async function cutSegments(file, workDir, plan) {
  const ff = ffmpegBin();
  if (!ff) return { ok: false, error: 'NOPATH' };
  try { fs.mkdirSync(workDir, { recursive: true }); } catch (_) {}
  const out = [];
  for (const seg of plan.segments) {
    const dst = path.join(workDir, 'slice_' + seg.index + '.mp4');
    const args = [
      '-y',
      '-ss', String(seg.startSec.toFixed(3)),
      '-i', file,
      '-t', String(seg.durSec.toFixed(3)),
      '-map', '0:v:0',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      dst
    ];
    const r = await run(ff, args, 900000);
    if (r.code !== 0 || !fs.existsSync(dst)) {
      return { ok: false, error: '切段失败（第 ' + (seg.index + 1) + ' 段）：' + errTail(r.err) };
    }
    out.push({ index: seg.index, file: dst, startSec: seg.startSec, durSec: seg.durSec, seconds: seg.seconds });
  }
  return { ok: true, segments: out };
}

/* ------------------------------------------------------------------ *
 * 拼接 / 叠音 / 裁尾
 * ------------------------------------------------------------------ */

/**
 * 把生成的 N 段拼成一条成片。
 *
 * 流程：
 *  1. 逐段裁到该段应有的精确时长并重编码（`norm_i.mp4`）：
 *     模型出片被对齐到帧网格，总比该段长一点；不裁就会越拼越长，
 *     最后一道「按原时长裁尾」会把最后一段的动作砍掉一大截。
 *  2. concat 拼接（各段编码参数一致，可以 `-c copy` 拼，不二次损失）。
 *  3. 叠音：保留声音模式 → 贴回**原始视频**的整条音轨（模型自己生成的声音整条丢掉）。
 *     不保留 → 保留模型生成的那条音轨（各段自生成音轨，段与段之间会重新起音 —— 这是模型行为，不是 bug）。
 *
 * @param segments [{file, durSec}] 生成的各段（绝对路径）
 * @param outFile 成片输出路径（绝对）
 * @param workDir 中间产物目录（归一段 / joined / concat 清单）—— 必须与 outFile **不同目录**，
 *   否则中间产物会混进「视频生成」历史列表（历史是按目录平铺扫 *.mp4 的）
 * @param totalSec 目标总时长（= 原视频时长，最后一道裁尾）
 * @param audioFrom 原视频路径（叠音用）
 * @param keepAudio 是否保留原声
 * @returns {ok, error?, file, durationSec}
 */
async function mergeSegments({ segments, outFile, workDir, totalSec, audioFrom = '', keepAudio = false, fps = 24 }) {
  const ff = ffmpegBin();
  if (!ff) return { ok: false, error: 'NOPATH' };
  const list = (Array.isArray(segments) ? segments : []).filter(s => s && s.file && fs.existsSync(s.file));
  if (!list.length) return { ok: false, error: '没有可拼接的分段产物' };
  const tmp = workDir || (path.join(path.dirname(outFile), '_white_tmp'));
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch (_) {}

  // —— 1. 逐段裁到精确时长（重编码，统一编码参数，concat 才能 copy 拼）——
  const norms = [];
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    const dst = path.join(tmp, 'norm_' + i + '.mp4');
    const dur = Number(seg.durSec) > 0 ? Number(seg.durSec) : 0;
    const args = ['-y', '-i', seg.file];
    if (dur > 0) args.push('-t', dur.toFixed(3));
    args.push(
      '-map', '0:v:0', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-r', String(fps || 24),
      dst
    );
    const r = await run(ff, args, 900000);
    if (r.code !== 0 || !fs.existsSync(dst)) {
      return { ok: false, error: '分段归一失败：' + errTail(r.err) };
    }
    norms.push(dst);
  }

  // —— 2. concat 拼接 ——
  const listFile = path.join(tmp, 'concat_list.txt');
  // concat demuxer 的路径用正斜杠（Windows 上反斜杠会被当转义），单引号包起来防路径里的空格
  const listText = norms.map(p => "file '" + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n');
  fs.writeFileSync(listFile, listText + '\n', 'utf8');
  const joined = path.join(tmp, 'joined.mp4');
  const rj = await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined], 900000);
  if (rj.code !== 0 || !fs.existsSync(joined)) {
    return { ok: false, error: '拼接失败：' + errTail(rj.err) };
  }

  // —— 3. 叠音 + 裁尾 ——
  let finalFile = joined;
  if (keepAudio && audioFrom && fs.existsSync(audioFrom)) {
    const probeSrc = await probe(audioFrom);
    if (probeSrc.ok && probeSrc.hasAudio) {
      const args = [
        '-y', '-i', joined, '-i', audioFrom,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'
      ];
      if (Number(totalSec) > 0) args.push('-t', Number(totalSec).toFixed(3));
      args.push(outFile);
      const rm = await run(ff, args, 900000);
      if (rm.code !== 0 || !fs.existsSync(outFile)) {
        return { ok: false, error: '叠原始音轨失败：' + errTail(rm.err) };
      }
      finalFile = outFile;
    }
  }
  // 没走叠音分支（或叠音失败但产物还在）→ 直接把 joined 挪/转成成片，并按原时长裁尾
  if (finalFile !== outFile) {
    const args = ['-y', '-i', joined, '-c', 'copy'];
    if (Number(totalSec) > 0) args.push('-t', Number(totalSec).toFixed(3));
    args.push(outFile);
    const rm = await run(ff, args, 900000);
    if (rm.code !== 0 || !fs.existsSync(outFile)) {
      return { ok: false, error: '裁尾失败：' + errTail(rm.err) };
    }
    finalFile = outFile;
  }

  const meta = await probe(finalFile);
  return { ok: true, file: finalFile, durationSec: meta.ok ? meta.durationSec : 0, width: meta.ok ? meta.width : 0, height: meta.ok ? meta.height : 0 };
}

/**
 * 删掉中间产物目录（切片段 / 归一段 / joined）—— 成功出片后调用，磁盘不留垃圾。
 * 失败时**不要**调用：留着才能排查。
 */
function cleanupWork(workDir) {
  try {
    if (!workDir || !fs.existsSync(workDir)) return false;
    fs.rmSync(workDir, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

module.exports = {
  DEFAULT_MAX_SEC, DEFAULT_MIN_SEC, MAX_SEGMENTS,
  probe, planSegments, cutSegments, mergeSegments, cleanupWork
};
