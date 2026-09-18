<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>

    <div v-if="!exportFile" class="placeholder">
      {{ exportable ? (busy ? '正在自动组装成片…' : '即将自动开始组装…') : '需先在第 6 块对所有镜头点击「采用」。' }}
    </div>
    <div v-else class="export-done">
      <video v-if="exportUrl" :src="exportUrl" controls style="max-width:640px; width:100%; border-radius:8px"></video>
      <div class="hint" style="margin-top:8px">成片：{{ exportPath }}</div>
    </div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: !!exportFile }" :disabled="busy || !exportable" @click="exportFilm">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>导出中…</span>
        <span v-else>{{ exportFile ? '重新导出成片' : '组装成片' }}</span>
      </button>
      <button class="btn ghost" v-if="exportFile" @click="reveal">打开所在文件夹</button>
      <span class="hint">拼接全部已采用镜头 → 统一 1920x1080 → 对白字幕烧录 → 导出 MP4</span>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'

export default {
  name: 'StageExport',
  data() { return { busy: false, exportFile: null, exportUrl: '' } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    shots() { return this.ep ? this.ep.shots : [] },
    videoState() { return this.ep ? this.ep.videoState : {} },
    exportable() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.videoState[i] && this.videoState[i].confirmed)
    }
  },
  watch: {
    'st.current'(ep) { if (ep) this.exportFile = ep.exportFile || null },
    // 进入第 7 块（第 6 块点「下一步」确认后 active 变 6）→ 自动开始组装，无需人工点击
    'pl.active'(v) { if (v === 6) this.autoStart() }
  },
  created() {
    if (this.ep) this.exportFile = this.ep.exportFile || null
    // 启动时就停留在第 7 块（且还没出过成片）→ 也自动组装
    if (this.pl.active === 6) this.autoStart()
  },
  methods: {
    autoStart() {
      if (this.busy || this.exportFile || !this.exportable) return
      this.exportFilm()
    },
    async exportFilm() {
      this.busy = true
      const t0 = Date.now()
      try {
        const videos = this.shots.map((s, i) => ({
          file: this.ep.dir + '\\videos\\' + this.videoState[i].files[this.videoState[i].cur],
          dialogue: s.dialogue || '',
          dur: s.dur || 8
        }))
        const outDir = this.ep.dir + '\\export'
        const outName = this.ep.name + '_' + Date.now()
        const out = await window.studio.exportVideo({ outDir, outName, videos, subtitles: true })
        this.exportFile = out.split('\\').pop()
        this.exportUrl = 'data:video/mp4;base64,' + (await window.studio.readFileBase64(out))
        this.pl.markGen(6, Date.now() - t0)
        // ⚠️ 阶段 7 不做锁定（用户明确要求）：不再调 pl.confirm(6)，
        // 否则 done[6]=true → inert 生效 → 成片不能播放、按钮全部变灰。
        this.$root.toast('成片已导出：' + this.exportFile)
      } catch (e) { this.st.fail(e) } finally { this.busy = false }
    },
    reveal() {
      window.studio.revealFile(this.ep.dir + '\\export\\' + this.exportFile)
    }
  }
}
</script>
