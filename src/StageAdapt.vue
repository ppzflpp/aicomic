<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    <!-- 脏标记（章节改过 → 建议重新改编）已统一显示在本模块标题后面，见 App.vue 的 stage-head -->
    <textarea v-model="adapted" rows="12" :placeholder="chapter ? '点击下方「生成改编稿」，LLM 将基于本章内容生成改编稿' : '请先在第 1 块粘贴章节原文'"></textarea>

    <!-- 操作条：左侧字数 + 耗时（与章节输入模块一致），按钮统一靠右紧挨「生成分镜」 -->
    <div class="ops-bar">
      <span class="hint">{{ adapted.trim().length }} 字</span>
      <span v-if="pl.timeText(1)" class="gen-ms" :class="{ live: pl.genStartAt[1] }">{{ pl.timeText(1) }}</span>
      <span style="flex:1"></span>
      <button v-if="!adapted.trim()" class="btn" :disabled="busy || !chapter" @click="generate">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>改编中…</span>
        <span v-else>生成改编稿</span>
      </button>
      <button class="btn" :disabled="!adapted.trim() || busy" @click="nextToShots">生成分镜</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, dbgPrompt } from './ulog.js'
import { composeSystem } from './prompts.js'
import { revsOf, touchRevs } from './stale.js'

// 代码固定的身份说明与输出契约；风格部分来自项目 prompts/adapt.md（用户可改）
const IDENTITY = '你是网文改编成短剧/漫剧的资深编剧。任务：把小说章节原文改编为「漫剧化剧本底稿」，供下游分镜脚本环节拆分镜头使用。'
const CONTRACT = '只输出改编稿本身，不要任何解释、前言、结语，不要用 Markdown 代码块包裹。'

// 内置兜底：项目提示词文件（adapt.md）整体丢失且无法补齐时才用到
const FALLBACK = IDENTITY + '\n' + CONTRACT + `
要求：
1. 删除大段心理描写与环境铺陈，改为可拍摄的画面描述
2. 完整保留关键对白（原句）
3. 突出冲突、悬念与情绪转折点
4. 按事件顺序分小节，每节格式：
【场景】地点/时间
【画面】……
【对白】角色A："……"`

export default {
  name: 'StageAdapt',
  data() { return { adapted: '', busy: false } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    chapter() { return this.ep ? this.ep.chapter : '' }
  },
  watch: {
    // 换集时同步改编稿；无集数时清空（immediate 是 watch 选项，不能写成上面那种平级键）
    'st.current': {
      handler(ep) { this.adapted = ep ? (ep.adapted || '') : '' },
      immediate: true
    },
    // 第 1 块点「改编」进来 → 不需要任何操作直接开始改编
    'pl.autoAdapt'(v) { if (v) { this.pl.autoAdapt = false; this.tryAutoAdapt() } }
  },
  created() {
    // 组件可能晚于标记置位才挂载（换集重挂载）：挂载时兜底检查一次
    if (this.pl.autoAdapt) { this.pl.autoAdapt = false; this.tryAutoAdapt() }
  },
  methods: {
    /** 记录「本次改编基于哪个章节版本」+ 清除用户点击的确认 */
    async recordChapterRev() {
      const ch = revsOf(this.st).chapter || 0
      await touchRevs(this.st, r => { r.adaptedChapter = ch })
    },
    /** 自动改编入口：章节非空才触发（守卫防误跑） */
    tryAutoAdapt() {
      if (this.busy || !this.chapter.trim()) return
      this.generate()
    },
    async generate() {
      this.busy = true
      const t0 = Date.now()
      this.pl.beginGen(1)
      const L = stepLog('阶段2 漫剧改编')
      L.start('正在生成改编稿：LLM 改编章节原文（' + this.chapter.length + ' 字，长文需数分钟）')
      try {
        const system = await composeSystem({
          identity: IDENTITY, specs: ['adapt.md'], contract: CONTRACT, fallback: FALLBACK
        })
        const user = '以下是小说章节原文，请输出漫剧化改编稿：\n\n' + this.chapter
        dbgPrompt('阶段2 漫剧改编', '文字模型', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 4096, label: '阶段2 漫剧改编' })
        this.adapted = text.trim()
        await this.st.saveArtifact('adapted', this.adapted)
        await this.recordChapterRev()   // 记录本次改编基于的章节版本（章节后再改才提示）
        this.pl.markGen(1, Date.now() - t0)
        L.done('改编稿生成完成：' + this.adapted.length + ' 字', Date.now() - t0)
        this.$root.toast('改编稿已生成，请检查编辑后确认')
      } catch (e) {
        L.fail('改编稿生成失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false; this.pl.endGen(1) }
    },
    async confirm() {
      await this.st.saveArtifact('adapted', this.adapted)
      this.pl.confirm(1, this.ep.id)
      this.$root.toast('改编稿已确认')
    },
    /** 「生成分镜」：确认改编稿 → 进入第 3 块（分镜脚本）→ 无需额外操作自动开始生成分镜 */
    async nextToShots() {
      if (this.busy || !this.adapted.trim()) return
      await this.st.saveArtifact('adapted', this.adapted)
      this.pl.confirm(1, this.ep.id)
      this.pl.autoShots = true          // 由 StageShots 消费（它可能晚一步才挂载/解锁）
      this.$root.toast('改编稿已确认，正在生成分镜…')
    }
  }
}
</script>
