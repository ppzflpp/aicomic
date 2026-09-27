<template>
  <div>
    <!-- 改编进度条 Teleport 到 App.vue 剧本创作卡顶部 #adapt-progress：横贯整个卡片（2026-09-27 Dragon 要求，
         原来只显示在右栏 AI 优化稿顶部）。空载时不渲染任何内容，容器零高度无占位 -->
    <Teleport v-if="tpReady" to="#adapt-progress">
      <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    </Teleport>
    <!-- 脏标记（章节改过 → 建议重新改编）已统一显示在本模块标题后面，见 App.vue 的 stage-head -->
    <textarea v-model="adapted" rows="12" :placeholder="chapter ? '点击「改编」，LLM 将基于本章内容生成改编稿' : '请先在左侧「原文输入」粘贴章节原文'"></textarea>

    <!-- 素材名单覆盖提示（2026-09-27，通用结构特征：标签+名单行）：
         素材给了「参与人物 / 场景」清单而改编稿漏掉其中某些名字时提醒。只提示、不拦截、不改稿 -->
    <div v-if="coverage.checked && (coverage.missing.length || coverage.missingScenes.length)" class="cov-warn">
      <b>⚠ 素材名单未落地（{{ coverage.missing.length + coverage.missingScenes.length }} 个）</b>
      <span>{{ coverage.missing.concat(coverage.missingScenes).join('、') }} —— 本章该出场 / 该有场景设定的请补充改编稿；本章没戏的人物按规范不建档。</span>
    </div>

    <!-- 2026-09-27 模块合并：本组件不再自带操作条 —— 耗时 Teleport 到 #adapt-ms（改编按钮左边）、
         生成分镜 Teleport 到 #adapt-ops（按钮组最右），与「改编」按钮同一行 -->
    <Teleport v-if="tpReady" to="#adapt-ms">
      <span v-if="pl.timeText(1)" class="gen-ms" :class="{ live: pl.genStartAt[1] }">{{ pl.timeText(1) }}</span>
    </Teleport>
    <Teleport v-if="tpReady" to="#adapt-ops">
      <button class="btn" :disabled="!adapted.trim() || busy" @click="nextToShots">生成分镜</button>
    </Teleport>

    <!-- 字数胶囊：Teleport 到本模块标题行右侧（App.vue 的 #adapt-count）。
         🔴 与批量按钮同理：块 2 的 <section :key> 切集时整棵子树先在脱离文档的内存里挂载，
         mounted 前 document.querySelector('#adapt-count') 必然落空 → 必须等 nextTick 再渲染 -->
    <Teleport v-if="tpReady" to="#adapt-count">
      <span class="head-ms" title="改编稿字数">{{ adapted.trim().length }} 字</span>
    </Teleport>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, dbgPrompt } from './ulog.js'
import { composeSystem, composeUser } from './prompts.js'
import { listCoverage } from './promptlib.js'
import { revsOf, touchRevs } from './stale.js'

// 🔴 提示词全部来自项目 prompts/adapt.md：角色与任务、规则、输出格式都写在那份 md 里，代码不再硬编码任何提示词片段

export default {
  name: 'StageAdapt',
  data() { return { adapted: '', busy: false, tpReady: false } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    chapter() { return this.ep ? this.ep.chapter : '' },
    /** 素材名单覆盖检查（纯函数实时算）：素材没有名单行时 checked=false，黄条不出现；
     *  改编稿还是空的（刚建项目 / 还没点改编）也跳过 —— 空稿会把名单全判成缺失，黄条提前满屏 */
    coverage() {
      if (!this.adapted || !this.adapted.trim()) return { checked: false, missing: [], missingScenes: [] }
      return listCoverage(this.chapter, this.adapted)
    }
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
  mounted() {
    // 🔴 标题行的字数胶囊靠 Teleport 挂到 App.vue 的 #adapt-count：必须等 DOM 真正插入文档后再渲染，
    //    否则切集重挂载时 querySelector('#adapt-count') 落空 → 内容被静默丢弃（标题行看不到字数）
    this.$nextTick(() => { this.tpReady = true })
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
      const L = stepLog('阶段2 内容AI优化')
      L.start('正在生成改编稿：LLM 改编章节原文（' + this.chapter.length + ' 字，长文需数分钟）')
      try {
        const system = await composeSystem({ specs: ['adapt.md'], mustHave: ['## 输出格式'] })
        const user = await composeUser('adapt.md', { chapter: this.chapter })
        dbgPrompt('阶段2 内容AI优化', '文字模型', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 12288, label: '阶段2 内容AI优化' })
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
