<template>
  <div class="logpanel" v-show="logs.open" :style="{height: logs.height + 'px'}">
  <!-- 收起时整块不渲染（而不是 v-show 藏起来）：引擎启动会瞬间刷几十条日志，
       display:none 的列表照样会被 Vue 逐条 patch，是「界面发卡」的一处来源。
       外层仍保留 .logpanel 元素，收起态 offsetParent === null 的判定不受影响。 -->
  <template v-if="logs.open">
    <div class="lp-resize" @mousedown="startResize" title="拖动调整高度"></div>
    <div class="lp-head">
      <span class="lp-title">运行日志</span>
      <span class="lp-count">{{ logs.filtered.length }} / {{ logs.count }} 条</span>
      <div class="lp-seg">
        <button v-for="o in levelOpts" :key="o.v" :class="{on: logs.level===o.v}" @click="logs.level=o.v">{{ o.t }}</button>
      </div>
      <input class="lp-search" v-model="logs.query" placeholder="搜索…" />
      <select class="lp-tag" v-model="logs.tag">
        <option value="">全部阶段</option>
        <option v-for="t in logs.tags" :key="t" :value="t">{{ t }}</option>
      </select>
      <label class="lp-auto"><input type="checkbox" v-model="logs.autoScroll" />自动滚动</label>
      <span style="flex:1"></span>
      <button class="btn ghost sm" @click="logs.openFile()">打开日志文件</button>
      <button class="btn ghost sm" @click="logs.clear()">清空</button>
      <button class="btn ghost sm" @click="logs.toggle(false)">收起 ▾</button>
    </div>
    <div class="lp-body" ref="body">
      <div v-if="!logs.filtered.length" class="lp-empty">
        暂无日志{{ logs.level !== 'all' ? '（切到「全部」可看引擎级细节）' : '' }}
      </div>
      <div v-for="(l, i) in logs.filtered" :key="i" class="lp-row" :class="'lv-' + l.level">
        <span class="lp-ts">{{ l.ts }}</span>
        <span class="lp-tagcell">[{{ l.tag }}]</span>
        <span class="lp-msg">{{ l.msg }}</span>
      </div>
    </div>
  </template>
  </div>
</template>

<script>
import { useLogs } from './stores/logs.js'

export default {
  name: 'LogPanel',
  data() {
    return {
      levelOpts: [
        { v: 'key', t: '关键节点' },
        { v: 'all', t: '全部' },
        { v: 'warn', t: '警告' },
        { v: 'error', t: '错误' }
      ],
      _drag: null
    }
  },
  computed: {
    logs() { return useLogs() }
  },
  watch: {
    'logs.filtered': {
      handler() { this.$nextTick(this.scrollBottom) }
    },
    'logs.open'(v) { if (v) this.$nextTick(this.scrollBottom) }
  },
  methods: {
    scrollBottom() {
      if (!this.logs.autoScroll) return
      const el = this.$refs.body
      if (el) el.scrollTop = el.scrollHeight
    },
    startResize(e) {
      const startY = e.clientY
      const startH = this.logs.height
      const move = (ev) => {
        const h = Math.min(window.innerHeight - 260, Math.max(120, startH + (startY - ev.clientY)))
        this.logs.height = h
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      e.preventDefault()
    }
  }
}
</script>
