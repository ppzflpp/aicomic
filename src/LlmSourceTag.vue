<template>
  <div class="llm-src" :title="tip">
    <span class="ls-ico">{{ eff === 'cloud' ? '☁' : '💻' }}</span>
    <span class="ls-txt">本页大模型：<b>{{ text }}</b></span>
    <button class="btn ghost sm" :disabled="busy" @click="toggle">{{ btnText }}</button>
    <span v-if="overridden" class="ls-note">本次打开期间有效，重启后回到设置里的默认</span>
  </div>
</template>

<script>
import { overrideTag, setOverride } from './llmSource.js'

/**
 * 「本页大模型来源」小标签（2026-10-15）。
 *
 * 用途：在阶段页上告诉用户这一页这次用本地还是云端，并允许**临时**切换。
 * 约定：设置页是唯一持久入口，这里只影响本次打开（纯内存，见 llmSource.js）。
 * 一个页面涉及多个环节时，这一个开关会把它们一起切（对用户就是「这一页这次走云端」）。
 */
export default {
  name: 'LlmSourceTag',
  props: {
    // 本页涉及的环节 id（见 electron/llmProvider.cjs 的 STAGES）
    stages: { type: Array, required: true },
    // 文案里要不要带上页面名（如「分镜页」），留空则用通用说法
    where: { type: String, default: '' }
  },
  data() {
    return { cfg: null, tick: 0, busy: false }
  },
  computed: {
    // 🔴 覆盖表是模块级普通对象，Vue 追踪不到 → 必须显式引用 tick 才能让 computed 失效重算
    ovTag() { void this.tick; return overrideTag(this.stages) },
    overridden() { return this.ovTag === 'local' || this.ovTag === 'cloud' },
    eff() {
      if (this.ovTag === 'cloud') return 'cloud'
      if (this.ovTag === 'local') return 'local'
      const list = this.stages
      const defs = list.map(s => (this.cfg && this.cfg.stages[s]) || 'local')
      return defs.every(d => d === defs[0]) ? defs[0] : 'mixed'
    },
    text() {
      if (!this.cfg) return '…'
      if (this.eff === 'cloud') return '云端'
      if (this.eff === 'mixed') return '云端 + 本地（按环节）'
      return '本地'
    },
    btnText() { return this.eff === 'cloud' ? '改回本地' : '本次用云端' },
    tip() {
      const w = this.where ? this.where + '：' : ''
      return w + '这一页这次的调用走哪个大模型。默认值在「设置 → 大模型来源」里改（那是长期生效的）；'
        + '这里的切换只影响本次打开，重启后回到默认。'
    }
  },
  async mounted() { await this.load() },
  methods: {
    async load() {
      try { this.cfg = await window.studio.llmConfig() } catch (_) { this.cfg = null }
    },
    async toggle() {
      this.busy = true
      try {
        const want = this.eff === 'cloud' ? 'local' : 'cloud'
        setOverride(this.stages, want)
        this.tick++   // 触发 computed 重算（覆盖表是模块级对象，Vue 追踪不到）
        this.$root.toast(want === 'cloud' ? '本页本次将走云端大模型' : '本页本次将走本地大模型')
      } finally { this.busy = false }
    }
  }
}
</script>

<style scoped>
/* scoped：类名自带 data 属性，不会串到别的块（项目里 style.css 是全局的，别把这条挪过去） */
.llm-src {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; margin-bottom: 8px; border-radius: 6px;
  background: rgba(125, 211, 252, .07); border: 1px solid rgba(125, 211, 252, .22);
  font-size: 12.5px;
}
.ls-ico { font-size: 13px; }
.ls-txt b { color: #7dd3fc; }
.ls-note { opacity: .6; font-size: 11.5px; }
</style>
