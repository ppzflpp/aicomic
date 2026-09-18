<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    <textarea v-model="adapted" rows="12" :placeholder="chapter ? '点击下方按钮，LLM 将基于本章内容生成改编稿' : '请先在第 1 块粘贴章节原文'"></textarea>
    <div class="hint" style="margin-top:6px">改编稿可直接编辑；确认后保存到 {{ ep ? '剧集目录 adapted.md' : '' }}</div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: !!adapted }" :disabled="busy || !chapter" @click="generate">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>改编中…</span>
        <span v-else>{{ adapted ? '重新生成' : '生成改编稿' }}</span>
      </button>
      <span class="hint">LLM 漫剧化改编：删心理描写、保留冲突与对白，输出可编辑改编稿</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="!adapted.trim()" @click="confirm">下一步</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog } from './ulog.js'

const SYSTEM = `你是网文改编成短剧/漫剧的资深编剧。任务：把小说章节原文改编为"漫剧化剧本底稿"。
要求：
1. 删除大段心理描写与环境铺陈，改为可拍摄的画面描述
2. 完整保留关键对白（原句）
3. 突出冲突、悬念与情绪转折点
4. 按事件顺序分小节，每节格式：
【场景】地点/时间
【画面】……
【对白】角色A："……"
5. 只输出改编稿本身，不要解释`

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
    }
  },
  methods: {
    async generate() {
      this.busy = true
      const t0 = Date.now()
      const L = stepLog('阶段2 漫剧化改编')
      L.start('正在生成改编稿：LLM 改编章节原文（' + this.chapter.length + ' 字，长文需数分钟）')
      try {
        const text = await window.studio.llmChat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: '以下是小说章节原文，请输出漫剧化改编稿：\n\n' + this.chapter }
        ], { temperature: 0.6, maxTokens: 4096, label: '阶段2 漫剧化改编' })
        this.adapted = text.trim()
        await this.st.saveArtifact('adapted', this.adapted)
        this.pl.markGen(1, Date.now() - t0)
        L.done('改编稿生成完成：' + this.adapted.length + ' 字', Date.now() - t0)
        this.$root.toast('改编稿已生成，请检查编辑后确认')
      } catch (e) {
        L.fail('改编稿生成失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false }
    },
    async confirm() {
      await this.st.saveArtifact('adapted', this.adapted)
      this.pl.confirm(1, this.ep.id)
      this.$root.toast('改编稿已确认')
    }
  }
}
</script>
