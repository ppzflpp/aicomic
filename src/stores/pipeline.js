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
    /** 本阶段最近一次生成的耗时（ms）—— 整块生成的模块（改编/分镜）显示这个 */
    lastMs: [0, 0, 0, 0, 0, 0, 0],
    /** 本次会话里阶段开始时刻（仅用于 confirm 记录墙钟，不再展示） */
    startAt: {},
    /** 正在进行的生成任务开始时刻（用于「生成中」实时计时）：{ [i]: ts } */
    genStartAt: {},
    /** 每秒自增，驱动「进行中」的实时计时刷新 */
    tick: 0,
    /** 第 1 块点「改编」→ 置位后由漫剧改编模块消费：进入即自动开始改编（不落库） */
    autoAdapt: false,
    /** 第 2 块点「生成分镜」→ 置位后由分镜脚本模块消费：进入即自动开始生成分镜（不落库） */
    autoShots: false
  }),
  getters: {
    // 🔴 2026-09-21 起全面去掉锁定：所有模块随时可编辑，「上游变化」改由脏标记（⚠ stale）提示。
    // 保留 isLocked 函数签名（恒 false），旧调用点无需逐个拆。
    isLocked: () => () => false,
    /** 整块生成的模块（第 2/3 块）在产物下方显示一行耗时文案：
     *  生成中 → '生成中 已用 X'；有本次生成耗时 → '耗时 X'；否则空。
     *  （逐条生成的第 4/5/6/7 块不用这个，耗时显示在各自卡片上。） */
    timeText: (s) => (i) => {
      void s.tick // 依赖这个每秒自增的计数器，让「生成中」的实时计时能刷新
      if (s.genStartAt[i]) {
        return '生成中 已用 ' + fmtMs(Date.now() - s.genStartAt[i])
      }
      const ms = s.lastMs[i] || 0
      return ms > 0 ? '耗时 ' + fmtMs(ms) : ''
    },
    /** 全部阶段的实际处理时间之和（不含人工停留） */
    totalMs: (s) => s.genMs.reduce((n, v) => n + (v || 0), 0)
  },
  actions: {
    load(done, active, meta, episodeId) {
      this.done = [...done]
      this.active = active
      this.epId = episodeId || null
      const m = (meta && typeof meta === 'object') ? meta : {}
      this.times = m.times && typeof m.times === 'object' ? JSON.parse(JSON.stringify(m.times)) : {}
      const g = Array.isArray(m.genMs) ? m.genMs : null
      const lm = Array.isArray(m.lastMs) ? m.lastMs : null
      this.genMs = [0, 1, 2, 3, 4, 5, 6].map(i => {
        if (g && Number.isFinite(g[i])) return g[i]
        return (this.times[i] && this.times[i].genMs) || 0
      })
      this.lastMs = [0, 1, 2, 3, 4, 5, 6].map(i => (lm && Number.isFinite(lm[i])) ? lm[i] : 0)
      // 断点续跑：当前进行中的阶段从「本次打开」开始计时
      this.startAt = {}
      if (!this.done[active]) this.startAt[active] = Date.now()
    },
    persist() {
      if (!this.epId) return
      // ⚠️ Vue 响应式 Proxy（this.times / this.genMs）无法结构化克隆过 IPC，
      // 会抛 "An object could not be cloned" → 阶段耗时从未落库 + 每次生成后弹错误 toast。
      // 必须先转纯对象（与 project.saveArtifact 同款坑）。
      const meta = JSON.parse(JSON.stringify({ times: this.times, genMs: this.genMs, lastMs: this.lastMs }))
      window.studio.saveState(this.epId, [...this.done], this.active, meta)
    },
    /** 生成任务开始（各阶段模块在发起生成前调用） */
    beginGen(i) { this.genStartAt[i] = Date.now() },
    /** 生成任务结束兜底：成功时 markGen 已清；失败时靠 finally 里的 endGen，
     *  否则 genStartAt 残留 → 「生成中 已用 X」徽标永远卡住 */
    endGen(i) { delete this.genStartAt[i] },
    /** 记一次生成动作的耗时（引擎实际工作时间） */
    markGen(i, ms) {
      delete this.genStartAt[i]
      if (!Number.isFinite(ms) || ms <= 0) return
      this.genMs[i] = (this.genMs[i] || 0) + Math.round(ms)
      this.lastMs[i] = Math.round(ms)
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
        this.lastMs[j] = 0
        delete this.genStartAt[j]
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
      this.lastMs = [0, 0, 0, 0, 0, 0, 0]
      this.genStartAt = {}
      this.startAt = { 0: Date.now() }
      this.persist(this.epId)
    },
    tickLive() { this.tick++ }
  }
})
