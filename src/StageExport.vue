<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>

    <!-- 镜头格 × N + 成片格 × 1：格子数跟着镜头数走（10 个镜头就是 10 个格子 + 1 个成片格）。
         已选中的镜头在对应格子里显示那版视频；还没生成的显示「待生成」占位符。
         成片格在组装完成后显示最终成片（只显示最新一版；历史成片仍留在磁盘上，可用「打开所在文件夹」查看）。 -->
    <div v-if="cells.length || films.length" class="film-grid">
      <div v-for="c in cells" :key="'s' + c.i" class="vcard" :class="{ confirmed: c.confirmed }">
        <div class="video-box">
          <video v-if="c.path && srcMap[c.path]" :src="srcMap[c.path]" controls></video>
          <div v-else class="ph">
            <span v-if="c.path && loadingSrc[c.path]" class="busy-txt"><i class="spin"></i>加载中…</span>
            <template v-else>镜头 {{ c.i + 1 }}<br>{{ c.confirmed ? '加载中…' : '待生成' }}</template>
          </div>
        </div>
        <div class="vmeta">
          <!-- 第 1 行：镜头号 · 角色 · 场景；第 2 行：时长 · 分辨率 · 生成耗时 -->
          <div class="vm-l1">
            <b>镜头 {{ c.i + 1 }}</b>
            <span v-if="c.chars">{{ c.chars }}</span>
            <span v-if="c.scene" class="vm-scene">{{ c.scene }}</span>
          </div>
          <div class="vm-l2">
            <span>{{ c.dur }}s</span>
            <span>{{ resText(c.res) }}</span>
            <span v-if="c.genMs" class="gen-ms">耗时 {{ fmtMs(c.genMs) }}</span>
          </div>
        </div>
      </div>

      <div class="vcard film-card" :class="{ confirmed: !!latest }">
        <div class="video-box">
          <video v-if="latest && srcMap[latest.path]" :src="srcMap[latest.path]" controls></video>
          <div v-else class="ph">
            <span v-if="latest && loadingSrc[latest.path]" class="busy-txt"><i class="spin"></i>加载中…</span>
            <template v-else>成片<br>{{ busy ? '组装中…' : (exportable ? '点「导出成片」开始组装' : '待选齐全部镜头') }}</template>
          </div>
        </div>
        <div class="vmeta">
          <!-- 第 1 行：成片 · 生成时间；第 2 行：时长 · 分辨率 · 导出耗时 -->
          <div class="vm-l1">
            <b>成片</b>
            <span v-if="latest">{{ fmtTime(latest.mtimeMs) }}</span>
            <span v-else class="hint">整集拼接后的最终成片</span>
          </div>
          <div class="vm-l2" v-if="latest">
            <span>{{ durText(latest) }}</span>
            <span>{{ res(latest) }}</span>
            <span v-if="latest.elapsedMs" class="gen-ms">耗时 {{ fmtMs(latest.elapsedMs) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!cells.length && !films.length" class="placeholder">本集还没有镜头；请先在第 4 块生成分镜、生成视频。</div>

    <!-- 操作条：提示文字靠左，按钮统一靠右 -->
    <div class="ops-bar">
      <span class="hint">拼接全部已选中镜头 → 统一 {{ outRes.replace('x', '×') }} → 按勾选烧录对白字幕 → 导出 MP4；每次导出的成片都保存在 项目/成片/集名/（本块只显示最新一版）</span>
      <span style="flex:1"></span>
      <label class="res-lab">输出分辨率
        <select class="res-sel" v-model="outRes" :disabled="busy" @change="onRes">
          <option v-for="o in outOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <!-- 添加字幕：勾选 → 导出时烧录对白字幕；不勾 → 成片不带字幕。按集记住（存在 videos.json 的 opts） -->
      <label class="res-lab subs-lab" title="勾选后导出的成片会烧录对白字幕；不勾则不加任何字幕">
        <input type="checkbox" v-model="subsEnabled" :disabled="busy" @change="onSubs" /> 添加字幕
      </label>
      <button class="btn" :class="{ regen: !!exportFile }" :disabled="busy || !exportable" @click="exportFilm">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>导出中…</span>
        <span v-else>导出成片</span>
      </button>
      <button class="btn sec" v-if="films.length" @click="reveal">打开所在文件夹</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'

/** '宽x高' → [w, h] */
function parseRes(v) { const m = /^(\d+)x(\d+)$/i.exec(String(v || '')); return m ? [+m[1], +m[2]] : [1920, 1080] }

export default {
  name: 'StageExport',
  data() { return { busy: false, exportFile: null, films: [], srcMap: {}, loadingSrc: {}, outRes: '1920x1080' } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    shots() { return this.ep ? this.ep.shots : [] },
    videoState() { return this.ep ? this.ep.videoState : {} },
    /** 镜头格：一格一个镜头。已选中的版本 → 带上该版本视频的绝对路径；否则 path 为 null（显示占位符） */
    cells() {
      const dir = this.ep ? this.ep.shotDir : ''
      return this.shots.map((s, i) => {
        const v = this.videoState[i] || {}
        const file = v.confirmed && v.cur >= 0 ? (v.files[v.cur] || null) : null
        return {
          i, confirmed: !!v.confirmed, file,
          path: file && dir ? dir + '\\' + file : null,
          chars: s.chars || '', scene: s.scene || '', dur: s.dur || 8,
          res: v.res || '', genMs: v.genMs || 0
        }
      })
    },
    /** 成片格显示最新一版成片（listMedia 按生成时间倒序） */
    latest() { return this.films.length ? this.films[0] : null },
    /** 「已选中镜头」的路径串（只用于 watch：变了就补读 base64） */
    cellPaths() { return this.cells.map(c => c.path || '').join('|') },
    exportable() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.videoState[i] && this.videoState[i].confirmed)
    },
    /** 输出档位（固定预设，与模型无关）；已保存的值不在档位里时补进去 */
    outOpts() {
      const list = ((this.st.resOptions || {}).out || []).slice()
      if (this.outRes && !list.some(o => o.value === this.outRes)) {
        const [w, h] = parseRes(this.outRes)
        const g = (a, b) => { while (b) { [a, b] = [b, a % b] } return a || 1 }
        const d = g(w, h)
        list.unshift({ value: this.outRes, label: w + '×' + h + '（' + (w / d) + ':' + (h / d) + '）' })
      }
      return list
    },
    /** 添加字幕勾选状态：按集记住（存 videos.json 的 opts.subs；缺省 = 勾选，保持历史行为） */
    subsEnabled: {
      get() { const o = (this.videoState || {}).opts; return o ? o.subs !== false : true },
      set(v) {
        if (!this.ep) return
        if (!this.videoState.opts) this.videoState.opts = {}
        this.videoState.opts.subs = !!v
      }
    }
  },
  watch: {
    'st.current'(ep) {
      if (!ep) return
      this.exportFile = ep.exportFile || null
      this.outRes = (ep.res && ep.res.out) || '1920x1080'
      this.srcMap = {}; this.loadingSrc = {}   // 换集：清掉上一集的视频缓存
      this.loadList()   // 换集/重启恢复后都要重扫本集成片
      this.syncCells()
    },
    // 进块 → 补齐镜头格 base64 预览（组装已改手动：不再自动开始导出）
    'pl.active'(v) { if (v === 6) this.syncCells() },
    // 已选中镜头的路径集合变化（在上一块点选了别的版本）→ 补齐 base64 预览
    'cellPaths'() { this.syncCells() }
  },
  created() {
    if (this.ep) { this.exportFile = this.ep.exportFile || null; this.outRes = (this.ep.res && this.ep.res.out) || '1920x1080'; this.loadList() }
    this.syncCells()
  },
  methods: {
    fmtMs,   // 🔴 必须注册进 methods：模板看不到模块作用域的导入（曾因漏注册 → 成片格一渲染就抛
             //     "fmtMs is not a function" → 整个组件卸载 → 组装成片模块全空白，重启也无法恢复）
    /** 切换输出分辨率：只影响本集后续导出 */
    onRes() { this.st.setEpisodeRes('out', this.outRes) },
    /** 切换「添加字幕」：落库到 videos.json 的 opts（StageShots 的 saveVideos 会原样带过这个键） */
    async onSubs() { await this.st.saveArtifact('videoState', this.ep.videoState) },
    async loadList() {
      if (!this.ep) return
      const dir = this.ep.filmDir   // <项目>/成片/<集>/
      try {
        // 元信息（时间/分辨率/导出耗时）与封面抽帧在主进程完成并缓存，目录没变化时几乎零开销
        const films = await window.studio.listMedia(dir)
        if (this.ep && this.ep.filmDir !== dir) return   // 异步期间可能已切到别的集
        this.films = films
        // 与镜头模块一致：视频直接带播放控件展示（成片只显示最新一版，但列表仍全部读回元信息）
        films.forEach(it => { if (!this.srcMap[it.path]) this.loadVideo(it) })
      } catch (e) { this.st.fail(e) }
    },
    /** 给「已选中镜头」的视频补读 base64（进模块即后台加载，加载完格子直接显示播放控件） */
    syncCells() {
      for (const c of this.cells) if (c.path) this.loadVideo({ path: c.path })
    },
    /** 清掉不再被成片格/镜头格引用的 base64 缓存（旧成片被替换后调用，防内存与误播旧片） */
    pruneSrc() {
      const keep = new Set(this.films.map(f => f.path))
      for (const c of this.cells) if (c.path) keep.add(c.path)
      Object.keys(this.srcMap).forEach(p => { if (!keep.has(p)) delete this.srcMap[p] })
    },
    /* 视频 base64 读取：进模块即后台加载，加载完卡片直接显示播放控件 */
    async loadVideo(it) {
      if (this.srcMap[it.path] || this.loadingSrc[it.path]) return
      this.loadingSrc[it.path] = true
      try {
        const b64 = await window.studio.readFileBase64(it.path)
        if (b64) this.srcMap[it.path] = 'data:video/mp4;base64,' + b64
      } catch (e) { /* 文件不存在（例如镜头视频被删）→ 保持占位符，不报错 */ }
      finally { delete this.loadingSrc[it.path] }
    },
    fmtTime(ms) {
      if (!ms) return '未知'
      const d = new Date(ms)
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    },
    res(it) { return it.width ? it.width + '×' + it.height : '未知' },
    /** 镜头格第 2 行的分辨率：该镜头生成视频时选的档位（未生成显示 —） */
    resText(v) { return v ? String(v).replace(/x/i, '×') : '—' },
    /** 成片时长：主进程用 ffprobe 实测的 durationSec */
    durText(f) { const d = f && f.durationSec; return d ? d.toFixed(1) + 's' : '—' },
    fmtSize(bytes) {
      const mb = bytes / 1024 / 1024
      return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB'
    },
    async exportFilm() {
      this.busy = true
      const t0 = Date.now()
      this.pl.beginGen(6)
      try {
        const videos = this.shots.map((s, i) => ({
          file: this.ep.shotDir + '\\' + this.videoState[i].files[this.videoState[i].cur],
          dialogue: s.dialogue || '',
          dur: s.dur || 8
        }))
        const outDir = this.ep.filmDir   // <项目>/成片/<集>/
        const outName = this.ep.name + '_' + Date.now()
        const [rw, rh] = parseRes(this.outRes)
        const out = await window.studio.exportVideo({ outDir, outName, videos, subtitles: this.subsEnabled, width: rw, height: rh })
        this.exportFile = out.split('\\').pop()
        this.pl.markGen(6, Date.now() - t0)
        this.st.invalidateMedia(this.ep.projectId, 'films')   // 左侧树「成片」下次展开刷新
        // ⚠️ 阶段 7 不做锁定（用户明确要求）：不再调 pl.confirm(6)，
        // 否则 done[6]=true → inert 生效 → 成片不能播放、按钮全部变灰。
        this.$root.toast('成片已导出：' + this.exportFile)
        await this.loadList()   // 导出完立刻刷新（最新一版进成片格）
        this.pruneSrc()         // 旧成片已被替换（主进程删除）→ 同步清掉对应 base64 缓存
      } catch (e) { this.st.fail(e) } finally { this.busy = false; this.pl.endGen(6) }
    },
    reveal() {
      window.studio.revealFile((this.films.length ? this.films[0].path : this.ep.filmDir + '\\' + this.exportFile))
    }
  }
}
</script>
