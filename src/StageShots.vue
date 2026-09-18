<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>

    <div v-if="!shots.length && !busy" class="placeholder">尚无分镜。先在第 2 块完成改编稿，再点击下方「生成分镜」。</div>

    <div v-else class="shot-grid">
      <div v-for="(s, i) in shots" :key="i" class="scard">
        <div class="scard-head">
          <b>镜头 {{ i + 1 }}</b>
          <span class="dur">{{ s.dur }}s</span>
          <span style="flex:1"></span>
          <button class="del-btn" title="删除此镜头" @click="shots.splice(i, 1)">✕</button>
        </div>
        <div class="f"><label>场景</label><input v-model="s.scene" /></div>
        <div class="f"><label>角色</label><input v-model="s.chars" /></div>
        <div class="f"><label>画面动作</label><textarea v-model="s.action" rows="3"></textarea></div>
        <div class="f"><label>对白</label><textarea v-model="s.dialogue" rows="2"></textarea></div>
        <div class="row2">
          <div class="f"><label>镜头语言</label><input v-model="s.camera" /></div>
          <div class="f"><label>时长/秒</label><input v-model.number="s.dur" type="number" min="4" max="15" /></div>
        </div>
      </div>
    </div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: shots.length }" :disabled="busy || !adapted" @click="generate">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>生成中…</span>
        <span v-else>{{ shots.length ? '重新生成' : '生成分镜' }}</span>
      </button>
      <button class="btn ghost" @click="addRow">＋ 手动加镜头</button>
      <span class="hint">LLM 按改编稿拆分镜头，卡片内可直接编辑</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="!shots.length" @click="confirm">下一步</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, secs } from './ulog.js'

// 注意：json 模式下服务端用 JSON Object 语法约束解码，顶层必须是对象，
// 所以提示词明确要求包一层 {"shots":[...]}，解析端同时兼容裸数组。
const SYSTEM = `你是漫剧分镜师。基于改编稿输出镜头列表。
只输出一个 JSON 对象，格式为 {"shots":[镜头1,镜头2,...]}，不要输出任何解释。
每个镜头对象的字段：
{"scene":"地点/时间","chars":"角色A、角色B","action":"画面与动作描述（可拍摄）","dialogue":"对白，无则空串","camera":"镜头语言(如:中景缓推/特写/全景)","dur":8}
规则：dur 取 4-15 之间整数；每个镜头是一个连续动作单元；对白保留原句；20-40 个镜头/3000字。`

export default {
  name: 'StageShots',
  data() { return { shots: [], busy: false } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    adapted() { return this.st.current ? this.st.current.adapted : '' }
  },
  watch: { 'st.current'(ep) { if (ep) this.shots = JSON.parse(JSON.stringify(ep.shots || [])) } },
  created() { if (this.st.current) this.shots = JSON.parse(JSON.stringify(this.st.current.shots || [])) },
  methods: {
    addRow() {
      this.shots.push({ scene: '', chars: '', action: '', dialogue: '', camera: '中景', dur: 8 })
    },
    async generate() {
      this.busy = true
      const t0 = Date.now()
      const L = stepLog('阶段3 分镜脚本')
      L.start('正在生成分镜：LLM 按改编稿拆分镜头（改编稿 ' + this.adapted.length + ' 字）')
      try {
        const text = await window.studio.llmChat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: '改编稿：\n\n' + this.adapted }
        ], { temperature: 0.5, maxTokens: 8192, json: true, label: '阶段3 分镜脚本' })
        const parsed = JSON.parse(require_json(text))
        const arr = pickArray(parsed)
        if (!arr || !arr.length) throw new Error('LLM 未返回镜头数组')
        this.shots = arr.map(s => ({
          scene: s.scene || '', chars: s.chars || '', action: s.action || '',
          dialogue: s.dialogue || '', camera: s.camera || '', dur: clampDur(s.dur)
        }))
        await this.st.saveArtifact('shots', this.shots)
        this.pl.markGen(2, Date.now() - t0)
        L.done('分镜生成完成：共 ' + this.shots.length + ' 个镜头', Date.now() - t0)
        this.$root.toast('已生成 ' + this.shots.length + ' 个镜头，请检查编辑后确认')
      } catch (e) {
        L.fail('分镜生成失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false }
    },
    async confirm() {
      await this.st.saveArtifact('shots', this.shots)
      this.pl.confirm(2, this.st.current.id)
      this.$root.toast('分镜已确认，共 ' + this.shots.length + ' 镜')
    }
  }
}

function clampDur(v) {
  const n = Math.round(Number(v) || 8)
  return Math.min(15, Math.max(4, n))
}
function require_json(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : text
  const start = raw.search(/[[{]/)
  if (start < 0) throw new Error('LLM 输出中未找到 JSON')
  // 切到最后一次闭合括号，容忍 JSON 后面的多余文字
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
  return raw.slice(start, end > start ? end + 1 : undefined)
}
/** 兼容两种返回：裸数组，或（JSON 对象模式下的）{"shots":[...]} 包裹 */
function pickArray(v) {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    for (const k of ['shots', '镜头', '镜头列表', 'list', 'items', 'data', 'result']) {
      if (Array.isArray(v[k])) return v[k]
    }
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k]
  }
  return null
}
</script>
