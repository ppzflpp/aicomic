<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    <div v-if="!shots.length" class="placeholder">尚无分镜数据。</div>

    <div class="video-grid">
      <div v-for="(s, i) in shots" :key="i" class="vcard" :class="{ confirmed: state[i] && state[i].confirmed, 'card-busy': state[i] && state[i]._gen }">
        <span v-if="state[i] && state[i]._gen" class="busy-txt"><i class="spin"></i>正在生成镜头 {{ i + 1 }} 的视频…</span>
        <div class="video-box">
          <video v-if="curVideo(i)" :src="videoSrc(curVideo(i))" controls muted></video>
          <div v-else class="ph">镜头 {{ i + 1 }}<br>待生成</div>
          <span v-if="state[i] && state[i].confirmed" class="lock-tag">已采用</span>
        </div>
        <div class="vmeta">
          <b>镜头 {{ i + 1 }}</b> <span class="hint">{{ s.chars }} · {{ s.dur }}s</span>
          <div class="hint" style="margin-top:3px">{{ s.dialogue || s.action }}</div>
        </div>
        <div class="cops" v-if="state[i] && state[i].confirmed">
          <button class="btn ghost sm" :disabled="locked" @click="unconfirm(i)">取消采用</button>
        </div>
        <div class="cops" v-else>
          <button class="btn sm" :class="{ regen: !!(state[i] && state[i].files.length) }" :disabled="busy || locked" @click="gen(i)">{{ state[i] && state[i].files.length ? '重新生成' : '生成视频' }}</button>
          <button class="btn ghost sm" :disabled="busy || locked || !(state[i] && state[i].files.length)" @click="confirmOne(i)">采用</button>
        </div>
      </div>
    </div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: shots.some((_, i) => state[i] && state[i].files.length) }" :disabled="busy || locked || !shots.length" @click="genAll">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>生成中…</span>
        <span v-else>批量生成</span>
      </button>
      <span class="hint">{{ locked ? '本块已锁定：已生成的视频仍可播放；要重新生成请点右上角「解锁重做」' : '每个镜头可多次生成、单独重新生成；满意后「采用」固定；全部采用后才能组装' }}</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="locked || !allConfirmed" @click="confirm">下一步</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, secs } from './ulog.js'

export default {
  name: 'StageVideos',
  // locked：由 App 传入（该块 已完成/未解锁 时为 true）。锁定只禁用「操作」按钮，
  // **已生成的视频在任何状态下都必须能播放**（用户明确要求）。
  props: { locked: { type: Boolean, default: false } },
  data() { return { state: {}, busy: false, _b64: {} } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    shots() { return this.st.current ? this.st.current.shots : [] },
    allConfirmed() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.state[i] && this.state[i].confirmed)
    }
  },
  watch: {
    'st.current'(ep) { if (ep) this.init(ep) }
  },
  created() { if (this.st.current) this.init(this.st.current) },
  methods: {
    init(ep) {
      this._b64 = {}   // 换集必须清缓存，否则会命中上一集的同名镜头视频
      const s = ep.videoState && Object.keys(ep.videoState).length ? JSON.parse(JSON.stringify(ep.videoState)) : {}
      // 迁移：shots 数量变化时补齐；顺手清掉运行时字段
      ep.shots.forEach((_, i) => { if (!s[i]) s[i] = { files: [], cur: -1, confirmed: false } })
      Object.keys(s).forEach(k => { delete s[k]._gen })
      this.state = s
    },
    curVideo(i) {
      const s = this.state[i]
      return s && s.cur >= 0 ? s.files[s.cur] : null
    },
    videoSrc(file) {
      // key 用绝对路径（含集数目录），不同集之间的 shot_1.mp4 不会互相串
      const abs = ((this.st.current ? this.st.current.dir : '') + '\\videos\\' + file)
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        this._b64[abs] = b64 ? 'data:video/mp4;base64,' + b64 : ''
      })
      return ''
    },
    async persist() {
      // _gen 是纯 UI 状态，不落库
      const clean = {}
      Object.keys(this.state).forEach(k => {
        const v = { ...this.state[k] }
        delete v._gen
        clean[k] = v
      })
      await this.st.saveArtifact('videoState', clean)
    },
    async gen(i, ctx) {
      const s = this.shots[i]
      const pr = ((this.st.current.prompts || [])[i] || {})
      const prompt = pr.text
      if (!prompt) { this.st.fail(new Error('镜头 ' + (i + 1) + ' 缺少 H3 提示词，请先完成第 5 块')); return false }
      // 参考素材全部来自第 5 块该镜头的设置（可不选）
      const refs = pr.refs || {}
      const refImages = refs.images || []
      const refVideos = refs.videos || []
      const firstFrame = refs.first || null
      const lastFrame = refs.last || null
      const hasRef = refImages.length > 0 || refVideos.length > 0
      this.busy = true
      if (!this.state[i]) this.state[i] = { files: [], cur: -1, confirmed: false }
      this.state[i]._gen = true
      const t0 = Date.now()
      const L = stepLog('阶段6 H3视频')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      const mode = hasRef ? '参考模式' : (firstFrame || lastFrame ? '首尾帧模式' : '纯文字模式')
      const inputs = []
      if (firstFrame) inputs.push('首帧')
      if (lastFrame) inputs.push('尾帧')
      if (refImages.length) inputs.push('参考图×' + refImages.length)
      if (refVideos.length) inputs.push('参考视频×' + refVideos.length)
      L.start('正在生成视频：镜头 ' + (i + 1) + prog + '（' + s.dur + 's · ' + mode +
        (inputs.length ? ' · ' + inputs.join('+') : '') + ' · H3 推理，每镜头数分钟）')
      try {
        const dir = this.st.current.dir + '\\videos'
        // ⚠️ 必须转纯对象再送 IPC：refs 里的数组来自响应式 store（Vue Proxy），
        // Proxy 无法结构化克隆，直接传会抛「An object could not be cloned.」
        // （角色图阶段只传字符串所以一直没暴露；视频阶段传的是 refImages/refVideos 数组）
        const params = JSON.parse(JSON.stringify({ prompt, firstFrame, lastFrame, refImages, refVideos }))
        const r = await window.studio.comfyGenerate({
          templateKey: 'video', dir, baseName: 'shot_' + (i + 1),
          params,
          label: '阶段6 H3视频'
        })
        this.state[i].files = [...this.state[i].files, ...r.files]
        while (this.state[i].files.length > 4) this.state[i].files.shift()
        this.state[i].cur = this.state[i].files.length - 1
        delete this.state[i]._gen
        await this.persist()
        this.pl.markGen(5, Date.now() - t0)
        L.done('镜头 ' + (i + 1) + ' 视频生成完成：' + r.files.join('、'), Date.now() - t0)
        this.$root.toast('镜头 ' + (i + 1) + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail('镜头 ' + (i + 1) + ' 视频生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { delete this.state[i]._gen; this.busy = false }
    },
    async genAll() {
      const L = stepLog('阶段6 H3视频')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (!(this.state[i] && this.state[i].confirmed)) idx.push(i)
      }
      if (!idx.length) return
      L.start('开始批量生成视频：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头，跳过 ' + (this.shots.length - idx.length) + ' 个已采用）；预计总耗时较长，可随时看日志进度')
      const tAll = Date.now()
      let okN = 0, badN = 0
      this.busy = true
      try {
        for (let k = 0; k < idx.length; k++) {
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const sum = '批量生成视频结束：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN) L.warn(sum)
        else L.done(sum, null)
      } finally { this.busy = false }
    },
    async confirmOne(i) {
      if (!this.state[i] || this.state[i].cur < 0) return
      this.state[i].confirmed = true
      await this.persist()
      this.$root.toast('镜头 ' + (i + 1) + ' 已采用')
    },
    async unconfirm(i) {
      this.state[i].confirmed = false
      await this.persist()
    },
    async confirm() {
      await this.persist()
      this.pl.confirm(5, this.st.current.id)
      this.$root.toast('视频全部采用，进入组装')
    }
  }
}
</script>
