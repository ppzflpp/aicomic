import { defineStore } from 'pinia'

const MAX_UI = 2500

/** 级别过滤档位：key=关键节点（默认，隐藏 debug），all=全部（含引擎细节） */
const LEVELS = {
  key: (l) => l.level !== 'debug',
  all: () => true,
  warn: (l) => l.level === 'warn' || l.level === 'error',
  error: (l) => l.level === 'error'
}

export const useLogs = defineStore('logs', {
  state: () => ({
    lines: [],
    open: false,
    level: 'key',
    tag: '',
    query: '',
    autoScroll: true,
    unreadErr: 0,
    height: 268,
    inited: false
  }),
  getters: {
    tags: (s) => {
      // 用 Set 去重：日志上限 2500 行，原来的数组 includes 是 O(n²)，引擎启动刷屏时会拖慢渲染
      const seen = new Set()
      for (const l of s.lines) seen.add(l.tag)
      return [...seen]
    },
    filtered: (s) => {
      const f = LEVELS[s.level] || LEVELS.key
      const q = s.query.trim().toLowerCase()
      return s.lines.filter(l =>
        f(l) && (!s.tag || l.tag === s.tag) &&
        (!q || l.msg.toLowerCase().includes(q) || l.tag.toLowerCase().includes(q)))
    },
    count: (s) => s.lines.length
  },
  actions: {
    /** 订阅主进程日志流 + 拉一次历史（只执行一次） */
    async init() {
      if (this.inited) return
      this.inited = true
      window.studio.onLog((entry) => this.push(entry))
      try {
        const past = await window.studio.logRecent(600)
        if (Array.isArray(past) && past.length) {
          this.lines = past.concat(this.lines).slice(-MAX_UI)
          this.unreadErr = this.lines.filter(l => l.level === 'error').length
        }
      } catch (_) { /* 日志拉取失败不影响使用 */ }
    },
    push(entry) {
      if (!entry) return
      this.lines.push(entry)
      if (this.lines.length > MAX_UI) this.lines.splice(0, this.lines.length - MAX_UI)
      if (entry.level === 'error' && !this.open) this.unreadErr++
    },
    toggle(force) {
      this.open = force === undefined ? !this.open : !!force
      if (this.open) this.unreadErr = 0
    },
    clear() {
      this.lines = []
      this.unreadErr = 0
      window.studio.logClear().catch(() => {})
    },
    async openFile() {
      try { return await window.studio.logOpenFile() } catch (_) { return '' }
    }
  }
})
