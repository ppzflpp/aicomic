<template>
  <!-- 工作台右侧悬浮导航（2026-10-19 Dragon）
       - 只在「工作台」出现（由 App.vue 的 v-if 控制），四项 = 工作台里的四块卡片
       - 点一项 → 平滑滚动到那一块；滚到哪一块 → 哪一项高亮（双向一致）
       - 某块有生成任务在跑 → 名称右侧一颗闪烁绿点（数据直接取 pipeline 的 genStartAt，
         四块的登记早就统一在 pl.beginGen/endGen 里，不需要额外状态） -->
  <nav class="nav-rail" :class="{ 'has-task': anyTask }" aria-label="工作台模块导航">
    <button v-for="b in blocks" :key="b.i" class="nr-item" :class="{ on: cur === b.i }"
            :aria-label="b.label + (b.running ? ' · 生成中' : '')" @click="go(b.i)">
      <span class="nr-n">{{ b.n }}<span v-if="b.running" class="nr-dot" aria-label="有任务在跑"></span></span>
      <span class="nr-t">{{ b.label }}</span>
    </button>
  </nav>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'

/**
 * 四个展示块 ↔ 管线阶段的映射（与 App.vue 的 blkCls(...) 保持同一口径）：
 *   ① 剧本创作   = 阶段 0（内容输入）+ 1（AI 优化）
 *   ② 角色&场景  = 阶段 3；**阶段 2（分镜）在跑时也算**（同一次 LLM 调用产出，沿用 isGen 规则）
 *   ③ 分镜脚本   = 阶段 2 + 4（提示词）+ 5（视频）
 *   ④ 组装成片   = 阶段 6
 */
const BLOCKS = [
  { i: 1, n: 1, label: '剧本创作', stages: [0, 1] },
  { i: 2, n: 2, label: '角色 & 场景', stages: [3, 2] },
  { i: 3, n: 3, label: '分镜脚本', stages: [2, 4, 5] },
  { i: 4, n: 4, label: '组装成片', stages: [6] }
]

/** 判定「这一块是否贴着容器顶部」的阈值：块头 90px 以内算已滚到该块 */
const SPY_OFFSET = 96

export default {
  name: 'AppNavRail',
  data() { return { cur: 1 } },
  computed: {
    pl() { return usePipeline() },
    st() { return useProjectStore() },
    blocks() {
      return BLOCKS.map(b => ({ ...b, running: b.stages.some(i => !!this.pl.genStartAt[i]) }))
    },
    anyTask() { return this.blocks.some(b => b.running) }
  },
  watch: {
    // 切集 → 四块整棵重建（:key 变化），滚动位置回到顶部，高亮也回到第 1 块
    'st.current'(ep) {
      this.cur = 1
      this.$nextTick(() => this.spy())
    }
  },
  mounted() {
    // 🔴 滚动容器每次切视图都会被 v-if 重建，所以**不能缓存 DOM 引用**：
    //    统一在事件里现查；scroll 不冒泡但能在文档级捕获阶段收到。
    document.addEventListener('scroll', this.onScroll, true)
    window.addEventListener('resize', this.onScroll)
    this.$nextTick(() => this.spy())
  },
  beforeUnmount() {
    document.removeEventListener('scroll', this.onScroll, true)
    window.removeEventListener('resize', this.onScroll)
  },
  methods: {
    /** 当前工作台的滚动容器（不在工作台时返回 null） */
    contentEl() {
      const root = this.$el && this.$el.closest ? this.$el.closest('.main') : null
      return root ? root.querySelector('.content.dash-content') : null
    },
    sectionEl(i) {
      const c = this.contentEl()
      return c ? c.querySelector('[data-nav="' + i + '"]') : null
    },
    onScroll(e) {
      if (e && e.type === 'scroll' && e.target && e.target.classList
        && !e.target.classList.contains('dash-content')) return
      if (this._raf) return
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.spy() })
    },
    /** 滚动反向同步：取「顶部已越过阈值的最后一块」；已到最底部时直接锁定最后一块 */
    spy() {
      const c = this.contentEl()
      if (!c) return
      const cTop = c.getBoundingClientRect().top
      let best = 1
      for (const b of BLOCKS) {
        const el = c.querySelector('[data-nav="' + b.i + '"]')
        if (el && el.getBoundingClientRect().top - cTop <= SPY_OFFSET) best = b.i
      }
      if (c.scrollTop + c.clientHeight >= c.scrollHeight - 8) best = BLOCKS[BLOCKS.length - 1].i
      if (best !== this.cur) this.cur = best
    },
    /** 点一项 → 滚到那一块（留 12px 呼吸位，块头不会顶在容器边缘） */
    go(i) {
      const c = this.contentEl()
      const el = this.sectionEl(i)
      if (!c || !el) return
      const top = c.scrollTop + (el.getBoundingClientRect().top - c.getBoundingClientRect().top) - 12
      this.cur = i
      try { c.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }) }
      catch (_) { c.scrollTop = Math.max(0, top) }
    }
  }
}
</script>
