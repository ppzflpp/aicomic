import { defineStore } from 'pinia'

/** 毫秒 → '12.1s' / '1m 03s' */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return Math.round(ms) + 'ms'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  return m + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's'
}

export const usePipeline = defineStore('pipeline', {
  state: () => ({
    done: [false, false, false, false, false, false, false],
    active: 0,
    epId: null,
    /** 阶段总耗时（上一步确认 → 本步确认，含人工编辑）：{ [i]: {ms, genMs, at} } */
    times: {},
    /** 本阶段「引擎实际工作」累计耗时（ms），逐次生成累加 */
    genMs: [0, 0, 0, 0, 0, 0, 0],
    /** 本次会话里阶段开始时刻（用于进行中计时） */
    startAt: {},
    /** 每秒自增，驱动「进行中」的实时计时刷新 */
    tick: 0
  }),
  getters: {
    // 硬锁定：done 只读；active = 最后完成块的下一块；其余禁用
    isLocked: (s) => (i) => s.done[i] || i > s.active,
    /** 已完成阶段的耗时文案：'耗时 34.2s（生成 22.8s）' */
    timeText: (s) => (i) => {
      void s.tick // 依赖这个每秒自增的计数器，让「进行中」的计时能刷新
      const t = s.times[i]
      const gen = s.genMs[i] || (t && t.genMs) || 0
      if (t && t.ms != null) {
        return '耗时 ' + fmtMs(t.ms) + (gen ? '（生成 ' + fmtMs(gen) + '）' : '')
      }
      if (s.active === i && s.startAt[i]) {
        const live = Date.now() - s.startAt[i]
        return '已用时 ' + fmtMs(live) + (gen ? '（生成 ' + fmtMs(gen) + '）' : '')
      }
      return ''
    },
    totalMs: (s) => Object.keys(s.times).reduce((n, k) => n + (s.times[k].ms || 0), 0)
  },
  actions: {
    load(done, active, meta, episodeId) {
      this.done = [...done]
      this.active = active
      this.epId = episodeId || null
      const m = (meta && typeof meta === 'object') ? meta : {}
      this.times = m.times && typeof m.times === 'object' ? JSON.parse(JSON.stringify(m.times)) : {}
      const g = Array.isArray(m.genMs) ? m.genMs : null
      this.genMs = [0, 1, 2, 3, 4, 5, 6].map(i => {
        if (g && Number.isFinite(g[i])) return g[i]
        return (this.times[i] && this.times[i].genMs) || 0
      })
      // 断点续跑：当前进行中的阶段从「本次打开」开始计时
      this.startAt = {}
      if (!this.done[active]) this.startAt[active] = Date.now()
    },
    persist() {
      if (!this.epId) return
      // ⚠️ Vue 响应式 Proxy（this.times / this.genMs）无法结构化克隆过 IPC，
      // 会抛 "An object could not be cloned" → 阶段耗时从未落库 + 每次生成后弹错误 toast。
      // 必须先转纯对象（与 project.saveArtifact 同款坑）。
      const meta = JSON.parse(JSON.stringify({ times: this.times, genMs: this.genMs }))
      window.studio.saveState(this.epId, [...this.done], this.active, meta)
    },
    /** 记一次生成动作的耗时（引擎实际工作时间） */
    markGen(i, ms) {
      if (!Number.isFinite(ms) || ms <= 0) return
      this.genMs[i] = (this.genMs[i] || 0) + Math.round(ms)
      if (this.times[i]) this.times[i].genMs = this.genMs[i]
      this.persist()
    },
    confirm(i, episodeId) {
      if (episodeId) this.epId = episodeId
      const now = Date.now()
      const t0 = this.startAt[i]
      this.times[i] = {
        ms: t0 ? now - t0 : null,
        genMs: this.genMs[i] || 0,
        at: now
      }
      this.done[i] = true
      this.active = Math.min(i + 1, 6)
      this.startAt[this.active] = now
      this.persist(this.epId)
    },
    unlockFrom(i, episodeId) {
      if (episodeId) this.epId = episodeId
      for (let j = i; j < 7; j++) {
        this.done[j] = false
        delete this.times[j]
        this.genMs[j] = 0
      }
      this.active = i
      this.startAt[i] = Date.now()
      this.persist(this.epId)
    },
    resetAll(episodeId) {
      if (episodeId) this.epId = episodeId
      this.done = [false, false, false, false, false, false, false]
      this.active = 0
      this.times = {}
      this.genMs = [0, 0, 0, 0, 0, 0, 0]
      this.startAt = { 0: Date.now() }
      this.persist(this.epId)
    },
    tickLive() { this.tick++ }
  }
})
