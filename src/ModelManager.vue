<template>
  <div class="set-card mm-card">
    <div class="mm-head">
      <h3>模型管家</h3>
      <span v-if="state.root" class="hint mm-root" :title="state.root">
        模型目录：<b class="mono">{{ state.root }}</b>
        <span v-if="state.freeText">（剩余 {{ state.freeText }}）</span>
      </span>
      <span v-else class="hint model-no">还没找到模型目录 —— 点「选择目录…」指定，或点「重新检测」让软件自己找</span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" :disabled="!!progress" @click="chooseRoot">选择目录…</button>
      <button class="btn ghost sm" :disabled="!!progress" @click="redetect">重新检测</button>
    </div>

    <!-- 槽位清单：软件需要哪些模型、缺不缺、该放进哪个子目录 -->
    <div class="mm-row" v-for="s in state.slots" :key="s.key">
      <span class="mm-dot" :class="s.ok ? 'on' : 'off'"></span>
      <span class="mm-name" :title="s.why">{{ s.label }}</span>
      <span class="mm-stat" :class="s.ok ? 'model-ok' : 'model-no'">{{ s.ok ? ('已就位 ' + s.count) : '缺失' }}</span>
      <span class="hint mm-sub mono" :title="s.dir">{{ state.root ? s.sub + '\\' : '（未定）' }}</span>
      <span class="hint mm-need" :title="s.need">{{ s.need }}</span>
    </div>

    <!-- 批量导入 -->
    <div class="mm-ops">
      <span style="flex:1"></span>
      <button class="btn sm" :disabled="!!progress || !state.root" @click="batchPick">批量导入文件夹…</button>
    </div>

    <!-- 待确认清单：扫描结果（含手选用途） -->
    <div v-if="pending.length" class="mm-pending">
      <div class="mm-pending-head">
        <b>待导入 {{ pending.length }} 个文件</b>
        <span class="hint">合计 {{ human(totalPendingBytes) }}{{ unknownCount ? ('　其中 ' + unknownCount + ' 个需要你选用途') : '' }}</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="pending = []">取消</button>
        <button class="btn sm" :disabled="!runnable" @click="startImport">开始导入</button>
      </div>
      <div class="mm-p-row" v-for="(p, i) in pending" :key="p.src">
        <span class="mm-p-name mono" :title="p.src">{{ p.name }}</span>
        <span class="hint mm-p-size">{{ human(p.size) }}</span>
        <select v-if="!p.sub" v-model="p.key" class="mm-p-sel" @change="assign(i)">
          <option value="">— 选择用途 —</option>
          <option v-for="s in state.slots" :key="s.key" :value="s.key">{{ s.label }} → {{ s.sub }}\</option>
        </select>
        <span v-else class="hint mm-p-dst mono">{{ p.sub }}\</span>
        <button class="btn ghost sm" title="从待导入列表移除" @click="pending.splice(i, 1)">✕</button>
      </div>
    </div>

    <!-- 拷贝进度 -->
    <div v-if="progress" class="mm-prog">
      <div class="mm-prog-head">
        <span class="mm-prog-file mono" :title="progress.file">{{ progress.file || '准备中…' }}</span>
        <span class="hint">{{ Math.round((progress.percent || 0) * 100) }}%（{{ progress.index + 1 }}/{{ progress.total }}）</span>
      </div>
      <div class="progress mm-bar"><div class="bar" :style="{ width: Math.round((progress.percent || 0) * 100) + '%' }"></div></div>
      <div class="mm-prog-foot">
        <span class="hint">
          {{ human(progress.done) }} / {{ human(progress.totalBytes) }}
          <span v-if="progress.speed">· {{ human(progress.speed) }}/s</span>
          <span v-if="etaText">· 剩余约 {{ etaText }}</span>
        </span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="cancel">取消拷贝</button>
      </div>
    </div>

    <!-- 上次结果 -->
    <div v-else-if="result" class="mm-result">
      <span :class="result.failed && result.failed.length ? 'model-no' : 'model-ok'">
        {{ result.cancelled ? '已取消：' : '导入结束：' }}
        成功 {{ result.copied.length }} · 跳过 {{ result.skipped.length }} ·
        冲突 {{ result.conflicts.length }} · 失败 {{ result.failed.length }} ·
        共 {{ human(result.bytes) }}
      </span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" @click="result = null">知道了</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'ModelManager',
  data() {
    return {
      state: { root: '', rootOk: false, slots: [], freeText: '' },
      pending: [],          // [{ src, name, size, key, sub }]  sub 空 = 待用户选用途
      progress: null,       // 拷贝进度（来自主进程推送）
      result: null,         // 上次拷贝结果
      _off: null
    }
  },
  computed: {
    unknownCount() { return this.pending.filter(p => !p.sub).length },
    runnable() { return this.pending.length > 0 && this.pending.every(p => !!p.sub) },
    totalPendingBytes() { return this.pending.reduce((a, p) => a + (Number(p.size) || 0), 0) },
    etaText() {
      const p = this.progress
      if (!p || !p.speed || !p.totalBytes) return ''
      const left = Math.max(0, p.totalBytes - p.done)
      const s = left / p.speed
      if (!isFinite(s) || s <= 0) return ''
      return s >= 60 ? (Math.round(s / 60) + ' 分钟') : (Math.round(s) + ' 秒')
    }
  },
  mounted() {
    this.refresh()
    // 进度是主进程推的（拷贝几十 GB，主进程全程知道字节数）
    this._off = window.studio.onModelImportProgress(o => this.onProgress(o))
  },
  beforeUnmount() { try { this._off && this._off() } catch (_) {} },
  methods: {
    human(n) {
      if (!n) return '0 B'
      const u = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0, v = Number(n)
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
      return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
    },
    async refresh() {
      try { this.state = await window.studio.modelSlots() } catch (_) { /* 环境接口不可用时静默 */ }
    },
    async redetect() {
      try {
        const r = await window.studio.detectModelsRoot()
        await this.refresh()
        this.$root.toast(r && r.detected ? ('已定位模型目录：' + r.detected) : '没探测到 ComfyUI 模型目录，点「选择目录…」手动指定')
      } catch (e) { this.$root.toast('检测失败：' + ((e && e.message) || e)) }
    },
    /** 指定模型目录（原来在环境检测里，现在模型的事都在这一张卡上） */
    async chooseRoot() {
      try {
        const res = await window.studio.chooseModelDir('comfyui.modelsRoot')
        if (!res) return
        await this.refresh()
        this.$root.toast('模型目录已保存：' + (this.state.root || ''))
      } catch (e) { this.$root.toast('设置失败：' + ((e && e.message) || e)) }
    },
    /** 批量导入：选一个文件夹递归扫描，程序自动分类，认不出的留在列表里等用户选 */
    async batchPick() {
      const paths = await window.studio.modelImportPick()
      if (!paths || !paths.length) return
      const scan = await window.studio.modelImportScan(paths)
      const add = [
        ...scan.items.map(f => ({ src: f.src, name: f.name, size: f.size, key: f.key, sub: f.sub })),
        ...scan.unknown.map(f => ({ src: f.src, name: f.name, size: f.size, key: '', sub: '' }))
      ]
      if (!add.length) { this.$root.toast('没扫到模型文件（.safetensors / .ckpt / .gguf）'); return }
      this.pending = [...this.pending, ...add]
      this.autoStartIfSure()
    },
    /** 全部认得出用途 → 不必多点一次「开始导入」 */
    autoStartIfSure() {
      if (this.runnable && !this.progress) this.startImport()
    },
    assign(i) {
      const p = this.pending[i]
      const s = (this.state.slots || []).find(x => x.key === p.key)
      p.sub = s ? s.sub : ''
    },
    async startImport() {
      if (!this.runnable) return
      const tasks = this.pending.map(p => ({ src: p.src, name: p.name, sub: p.sub, size: p.size }))
      this.pending = []
      this.result = null
      this.progress = { file: '', index: 0, total: tasks.length, done: 0, totalBytes: 0, percent: 0, speed: 0 }
      try {
        this.result = await window.studio.modelImportRun({ root: this.state.root, tasks })
      } catch (e) {
        this.$root.toast('导入失败：' + ((e && e.message) || e))
        this.result = null
      } finally {
        this.progress = null
        await this.refresh()
      }
    },
    cancel() { window.studio.modelImportCancel() },
    onProgress(o) {
      if (!o) return
      if (o.phase === 'start') {
        this.progress = { file: '', index: 0, total: o.total, done: 0, totalBytes: o.totalBytes || 0, percent: 0, speed: 0 }
        return
      }
      if (o.phase === 'done') { this.progress = null; return }
      if (!this.progress) return
      this.progress = {
        ...this.progress,
        file: o.file || this.progress.file,
        index: typeof o.index === 'number' ? o.index : this.progress.index,
        done: typeof o.done === 'number' ? o.done : this.progress.done,
        totalBytes: o.totalBytes || this.progress.totalBytes,
        speed: o.speed || this.progress.speed,
        percent: typeof o.percent === 'number' ? o.percent : this.progress.percent
      }
    }
  }
}
</script>
