/**
 * 打包产物自检（无 GUI 依赖，纯 node）
 *
 * 守的是 electron-builder 的「自包含陷阱」：
 *   appOutDir 若落在 files 匹配范围内（如 dist/win-unpacked 命中 "dist/**\/*"），
 *   electron-builder 会把**整个 Electron 运行时再复制一份进 app.asar** →
 *   安装包体积与安装后磁盘占用凭空多出约 250MB，且不报错、不影响运行（静默）。
 *   2026-10-12 实测：asar 295MB（脏）→ 28.8MB（净），安装包 796MB → 717MB。
 *
 * 用法：node test/_packcheck.cjs
 * 退出码 0 = 通过；1 = 失败（打印失败项）
 */
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const ROOT = path.resolve(__dirname, '..')
const fails = []
const oks = []
function check(name, cond, extra) {
  if (cond) oks.push(name + (extra ? ' — ' + extra : ''))
  else fails.push(name + (extra ? ' — ' + extra : ''))
}

// ---- 1. 构建配置：输出目录必须移出 files 匹配范围 ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const b = pkg.build || {}
const outDir = (b.directories && b.directories.output) || 'dist'
check('输出目录已移出 dist', outDir !== 'dist', 'output=' + outDir)
check('files 含 !dist/win-unpacked/** 兜底', (b.files || []).includes('!dist/win-unpacked/**'))
check('files 含 !dist/*.exe 兜底', (b.files || []).includes('!dist/*.exe'))

// ---- 2. 产物存在性 ----
const unpacked = path.join(ROOT, outDir, 'win-unpacked')
const asarPath = path.join(unpacked, 'resources', 'app.asar')
check('app.asar 存在', fs.existsSync(asarPath), asarPath)
if (!fs.existsSync(asarPath)) {
  console.log(fails.map((f) => '✗ ' + f).join('\n'))
  process.exit(1)
}

// ---- 3. asar 内容：干净且完整 ----
const list = asar.listPackage(asarPath)
const norm = list.map((p) => p.replace(/\\/g, '/'))
check('asar 未包含 win-unpacked（无自包含）', !norm.some((p) => p.includes('win-unpacked')))
check('asar 含 dist/index.html', norm.some((p) => p === '/dist/index.html'))
check('asar 含 electron/main.cjs', norm.some((p) => p === '/electron/main.cjs'))
check('asar 含 skills/prompts', norm.some((p) => p.startsWith('/skills/prompts/')))
check('asar 含 node_modules', norm.some((p) => p.startsWith('/node_modules/')))
const asarSize = fs.statSync(asarPath).size
check('app.asar 体积合理（<80MB）', asarSize < 80 * 1024 * 1024, (asarSize / 1048576).toFixed(1) + 'MB')

// ---- 4. 内置工具：在、且排除项生效 ----
const toolsDir = path.join(unpacked, 'resources', 'tools')
check('内置 ffmpeg 在', fs.existsSync(path.join(toolsDir, 'ffmpeg', 'bin', 'ffmpeg.exe')))
check('内置 llama 在', fs.existsSync(path.join(toolsDir, 'llama')))
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const toolFiles = walk(toolsDir, [])
check('已排除 ffplay.exe', !toolFiles.some((p) => /ffplay\.exe$/i.test(p)))
check('已排除 *.pdb', !toolFiles.some((p) => /\.pdb$/i.test(p)))
check('已排除 crispasr', !toolFiles.some((p) => /crispasr/i.test(p)))
check('已排除 ffmpeg/doc 与 presets', !toolFiles.some((p) => /[\\/]ffmpeg[\\/](doc|presets)[\\/]/i.test(p)))

// ---- 5. 安装包体积 ----
const exe = fs.readdirSync(path.join(ROOT, outDir)).find((f) => /Setup .*\.exe$/i.test(f))
if (!exe) {
  check('安装包 exe 存在', false, '在 ' + outDir + ' 未找到 Setup.exe')
} else {
  const sz = fs.statSync(path.join(ROOT, outDir, exe)).size
  const mb = sz / 1048576
  // 正常 ~717MB；>1.2GB = NSIS 压缩偶发失效；<500MB = 内置工具漏打
  check('安装包体积正常（500MB–1.2GB）', mb > 500 && mb < 1200, exe + ' ' + mb.toFixed(0) + 'MB')
}

// ---- 输出 ----
for (const o of oks) console.log('✓ ' + o)
for (const f of fails) console.log('✗ ' + f)
console.log(`\n${oks.length}/${oks.length + fails.length} 通过`)
process.exit(fails.length ? 1 : 0)
