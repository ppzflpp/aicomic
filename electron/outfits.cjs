'use strict';
/**
 * 项目级装扮清单（<项目>/assets/outfits.json）
 *
 * 解决什么问题：装扮变体是**人物属性**，不是某一集的私事。
 * 第 1 集识别出「苏锦瑟--婚装」，第 3 集再识别时若不知道这个名字已经存在，
 * 模型会另起一个名字（「苏锦瑟--大红嫁衣」）→ 同一个装扮长出两张卡、两套图，跨集参考图彻底错位。
 *
 * 所以清单挂**项目**：本项目里这个人物有哪几套装扮、每套叫什么名字、描述是什么，
 * 写一次，之后每一集识别时都带着这份已知名字下发给模型（outfits.md 的 {{known}} 槽），
 * 让模型优先沿用已有名字；识别完再把新结果并回去（并集）。
 *
 * 设计要点（2026-10-16，与 library.cjs 同构）：
 *  - 文件 = `<项目>/assets/outfits.json`，与 `library.json` 邻居 —— 都是「项目级、名字为键」的小清单。
 *  - 形状 `{ rev, items: { [基础名]: [ {name, desc, kw, base} ] } }`：
 *    以**基础名（baseOf）**分组，一个主体一组，组内按识别顺序排列（第一套通常是 base 常服）。
 *    ⚠️ 分组键必须用 baseOf（`--` 才是主体组分隔符）；refBaseOf 会吃掉 `_02` 后缀但不吃 `--装扮名`，
 *    两者不是一回事，别混用。
 *  - 🔴 **本模块只做「读取」与「整份写入」**，不做任何合并规则：
 *    合并口径（同名先到先得、新结果覆盖 desc、kw 取并集…）是纯函数层的事（promptlib 的 mergeOutfitList），
 *    放这里会导致「渲染层能测的规则」跑到主进程，prompts-check / outfit-state-check 都够不着。
 *    与 library.cjs 的分工一致：主进程管盘，业务规则管纯函数。
 *  - 文件缺失 / 损坏 → 一律回空清单，**绝不抛**（装扮清单是辅助信息，坏了不该让整个阶段页打不开）。
 */
const path = require('path');
const fs = require('fs');
const projects = require('./projects.cjs');

/** 清单文件：<项目>/assets/outfits.json */
function outfitsPath(db, workspace, projectId) {
  const a = projects.assetsRoot(db, workspace, projectId);
  return a ? path.join(a, 'outfits.json') : null;
}

/** 空清单（每次新建对象，别共享同一个字面量） */
function emptyBook() { return { rev: 1, items: {} } }

/**
 * 形状守卫：把任意输入整成 `{ rev, items }`。
 * 只做「按层丢弃不可用数据」（非数组的组丢掉、非对象的条目丢掉、字段强行转字符串/字符串数组），
 * **不做业务判断**（不排序、不去重、不合并）。宁可少几条，也不能让脏数据流进界面。
 */
function normBook(o) {
  const out = emptyBook();
  if (!o || typeof o !== 'object') return out;
  out.rev = (typeof o.rev === 'number' && o.rev > 0) ? o.rev : 1;
  const items = (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) ? o.items : {};
  for (const base of Object.keys(items)) {
    const arr = items[base];
    if (!Array.isArray(arr)) continue;
    const list = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const name = String(it.name || '').trim();
      if (!name) continue;                      // 没名字的装扮无法派生卡片，直接丢
      list.push({
        name,
        desc: String(it.desc == null ? '' : it.desc),
        // 🔴 kw 逐项转字符串要**先判 null**：String(null) 会得到字面的「"null"」，
        //    一个真值 → 过滤器拦不住 → 关键词表里永远躺着一个「null」（自测 outfits-book-check 抓到过）。
        kw: Array.isArray(it.kw) ? it.kw.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : [],
        base: !!it.base
      });
    }
    if (list.length) out.items[String(base)] = list;
  }
  return out;
}

/**
 * 读清单。文件不存在 / 解析失败 → 空清单（不抛、不写盘 —— 读操作不该有副作用）。
 * 调用方拿到的一定是 { rev, items }，可以直接 Object.keys。
 */
function readOutfits(db, workspace, projectId) {
  const p = outfitsPath(db, workspace, projectId);
  if (!p || !fs.existsSync(p)) return emptyBook();
  try { return normBook(JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch (_) { return emptyBook() }
}

/**
 * 整份写入（rev +1）。传入的对象会先过 normBook —— 写坏的清单比写不进去更糟。
 * @returns 实际落盘的对象（rev 已 +1）
 */
function putOutfits(db, workspace, projectId, book) {
  const p = outfitsPath(db, workspace, projectId);
  if (!p) return null;
  const next = normBook(book);
  const old = readOutfits(db, workspace, projectId);
  next.rev = (old.rev || 1) + 1;
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = { outfitsPath, emptyBook, normBook, readOutfits, putOutfits };
