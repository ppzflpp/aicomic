<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    <div v-if="!shots.length" class="placeholder">尚无分镜数据。</div>

    <div class="prompt-grid">
      <div v-for="(p, i) in prompts" :key="i" class="vcard" :class="{ 'card-busy': p._gen }">
        <span v-if="p._gen" class="busy-txt"><i class="spin"></i>正在生成第 {{ i + 1 }} 个镜头的提示词…</span>

        <div class="vmeta">
          <b>镜头 {{ i + 1 }}</b> <span class="hint">{{ shots[i] ? shots[i].chars : '' }} · {{ shots[i] ? shots[i].dur : '' }}s</span>
          <div class="hint" style="margin-top:3px">{{ shots[i] ? (shots[i].dialogue || shots[i].action) : '' }}</div>
        </div>

        <textarea v-model="p.text" rows="7" placeholder="H3 提示词（英文结构化）…"></textarea>

        <!-- 参考素材：都可不选。选了什么就用什么，什么都不选＝纯文字 -->
        <div class="refs">
          <div class="ref-row">
            <span class="ref-lab">参考图</span>
            <div v-for="(f, k) in p.refs.images" :key="'ri' + k" class="ref-thumb">
              <img :src="refSrc(f)" :title="f" />
              <button class="img-x" title="移除" @click.stop="delRef(i, 'images', k)">✕</button>
            </div>
            <button v-if="p.refs.images.length < 3" class="ref-add" title="从本地选参考图（最多 3 张）" @click="addRef(i, 'images')">＋ 图</button>

            <span class="ref-lab" style="margin-left:8px">视频</span>
            <div v-for="(f, k) in p.refs.videos" :key="'rv' + k" class="ref-thumb vid" :title="f">
              <span class="vid-tag">视频</span>
              <button class="img-x" title="移除" @click.stop="delRef(i, 'videos', k)">✕</button>
            </div>
            <button v-if="p.refs.videos.length < 1" class="ref-add" title="从本地选参考视频" @click="addRef(i, 'videos')">＋ 视频</button>
          </div>

          <div class="ref-row">
            <span class="ref-lab">首尾帧</span>
            <div v-if="p.refs.first" class="ref-thumb">
              <img :src="refSrc(p.refs.first)" title="首帧" />
              <button class="img-x" title="移除首帧" @click.stop="clearFrame(i, 'first')">✕</button>
            </div>
            <button v-else class="ref-add" title="选一张图作为首帧" @click="pickFrame(i, 'first')">选首帧</button>

            <div v-if="p.refs.last" class="ref-thumb">
              <img :src="refSrc(p.refs.last)" title="尾帧" />
              <button class="img-x" title="移除尾帧" @click.stop="clearFrame(i, 'last')">✕</button>
            </div>
            <button v-else class="ref-add" title="选一张图作为尾帧（与首帧配合可做首尾帧过渡）" @click="pickFrame(i, 'last')">选尾帧</button>

          </div>

          <div v-if="!refCount(p)" class="hint" style="margin-top:2px">未选素材 → 本镜头走纯文字生成（H3 fl2va）</div>
        </div>

        <div class="cops">
          <button class="btn sm" :class="{ regen: !!p.text.trim() }" :disabled="busy" @click="gen(i)">
            {{ p.text.trim() ? '重新生成' : '生成' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: prompts.some(p => p.text.trim()) }" :disabled="busy || !shots.length" @click="genAll">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>生成中…</span>
        <span v-else>批量生成</span>
      </button>
      <span class="hint">按分镜生成 H3 结构化英文提示词；角色描述引用已锁定角色档案，保证一致性</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="!allFilled" @click="confirm">下一步</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, secs } from './ulog.js'

const SYSTEM = `You write H3 (video generation model) prompts for a comic-drama shot.
Output ONE structured English prompt per shot, in this multi-section format:
[Subject] ...character appearance (use ONLY the provided character descriptions, do not invent)...
[Action] ...motion/blocking...
[Camera] ...shot type, camera movement...
[Style] anime style, cinematic lighting
[Audio] short ambience/sfx note
Constraints: 4-15 seconds shot. Output only the prompt text.`

const MAX_REF_IMG = 3
const MAX_REF_VID = 1

export default {
  name: 'StagePrompts',
  data() { return { prompts: [], busy: false, _autoEp: null, _ref64: {} } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    shots() { return this.st.current ? this.st.current.shots : [] },
    chars() { return this.st.current ? this.st.current.chars : [] },
    allFilled() { return this.prompts.length > 0 && this.prompts.every(p => p.text.trim()) }
  },
  watch: {
    'st.current'(ep) { if (ep) this.init(ep) },
    'pl.active'(v) {
      // 从第4块「下一步」进入第5块：自动开始生成（只补空的镜头，不覆盖已有内容）
      if (v !== 4 || this.pl.done[4]) return
      const ep = this.st.current
      if (!ep || !this.shots.length || this._autoEp === ep.id) return
      this._autoEp = ep.id
      this.$root.toast('已自动开始生成提示词（逐镜头进行，可随时手动编辑）')
      this.genAll()
    }
  },
  created() { if (this.st.current) this.init(this.st.current) },
  methods: {
    init(ep) {
      const shots = ep.shots || []
      let changed = false
      if (ep.prompts && ep.prompts.length) {
        this.prompts = JSON.parse(JSON.stringify(ep.prompts))
      } else {
        this.prompts = shots.map(() => ({ text: '', refs: emptyRefs() }))
        changed = true
      }
      // 分镜数量变了（重新生成分镜）：补齐/裁掉多余，保证每个镜头都有一张卡
      while (this.prompts.length < shots.length) { this.prompts.push({ text: '', refs: emptyRefs() }); changed = true }
      if (this.prompts.length > shots.length) { this.prompts.length = shots.length; changed = true }
      // 老数据没有 refs 字段要补；_gen 是运行时字段，绝不能从库里读回来（否则永远转圈）
      this.prompts.forEach(p => {
        if (!p.refs) { p.refs = emptyRefs(); changed = true }
        if (p._gen) { delete p._gen; changed = true }
      })
      if (changed) this.saveAll()
    },
    charProfiles() {
      return this.chars.map(c => c.name + ': ' + c.prompt).join('\n')
    },
    async saveAll() {
      // _gen 是纯 UI 状态（生成中），绝不能落库，否则重开就是「永远转圈」
      const clean = this.prompts.map(p => {
        const o = { ...p, refs: { ...(p.refs || emptyRefs()) } }
        delete o._gen
        return o
      })
      await this.st.saveArtifact('prompts', clean)
    },

    /* ---------- 参考素材（都可不选；选什么用什么） ---------- */
    refCount(p) {
      const r = p.refs || {}
      return (r.images || []).length + (r.videos || []).length + (r.first ? 1 : 0) + (r.last ? 1 : 0)
    },
    refSrc(abs) {
      if (!abs) return ''
      if (this._ref64[abs] !== undefined) return this._ref64[abs]
      this._ref64[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) this._ref64[abs] = 'data:image/png;base64,' + b64
        else delete this._ref64[abs]
      })
      return ''
    },
    async addRef(i, kind) {
      const files = await window.studio.pickFiles(kind === 'videos' ? 'video' : 'image')
      if (!files || !files.length) return
      const r = this.prompts[i].refs
      const max = kind === 'videos' ? MAX_REF_VID : MAX_REF_IMG
      let added = 0
      for (const f of files) {
        if (r[kind].length >= max) break
        r[kind].push(f); added++
      }
      await this.saveAll()
      if (added < files.length) this.$root.toast('已达上限，本次只加入 ' + added + ' 个')
    },
    async delRef(i, kind, k) {
      this.prompts[i].refs[kind].splice(k, 1)
      await this.saveAll()
    },
    async pickFrame(i, which) {
      const files = await window.studio.pickFiles('image')
      if (!files || !files.length) return
      this.prompts[i].refs[which] = files[0]
      await this.saveAll()
    },
    async clearFrame(i, which) {
      this.prompts[i].refs[which] = null
      await this.saveAll()
    },
    /* ---------- 生成提示词 ---------- */
    async gen(i, ctx) {
      const s = this.shots[i]
      if (!s) return false
      const p = this.prompts[i]
      this.busy = true
      p._gen = true
      const t0 = Date.now()
      const L = stepLog('阶段5 H3提示词')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在生成第' + (i + 1) + '个镜头的提示词' + prog)
      try {
        const refs = p.refs || {}
        const extra = []
        if (refs.first) extra.push('有首帧参考图')
        if (refs.last) extra.push('有尾帧参考图')
        if ((refs.images || []).length) extra.push('有 ' + refs.images.length + ' 张角色参考图')
        if ((refs.videos || []).length) extra.push('有参考视频')
        const text = await window.studio.llmChat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'Character sheets (use as-is):\n' + this.charProfiles() +
            '\n\nShot ' + (i + 1) + ':\n' + JSON.stringify(s, null, 2) +
            (extra.length ? '\n\n本镜头还会附带以下参考素材（' + extra.join('、') +
              '），请在提示词里把这些参考当作固定依据，不要另行虚构外观。' : '') }
        ], { temperature: 0.6, maxTokens: 1024, label: '阶段5 H3提示词' })
        p.text = text.trim()
        await this.saveAll()
        this.pl.markGen(4, Date.now() - t0)
        L.done('第' + (i + 1) + '个镜头的提示词生成完成：' + text.trim().length + ' 字', Date.now() - t0)
        return true
      } catch (e) {
        L.fail('第' + (i + 1) + '个镜头的提示词生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { p._gen = false; this.busy = false }
    },
    async genAll() {
      const L = stepLog('阶段5 H3提示词')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (!this.prompts[i].text) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('所有镜头都已有提示词，无需生成（可逐镜头「重新生成」）'); return }
      L.start('开始批量生成提示词：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头，跳过 ' + (this.shots.length - idx.length) + ' 个已有）')
      const tAll = Date.now()
      let okN = 0, badN = 0
      this.busy = true
      try {
        for (let k = 0; k < idx.length; k++) {
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const sum = '批量生成提示词结束：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN) L.warn(sum)
        else L.done(sum, null)
        if (!badN) this.$root.toast('全部提示词已生成')
      } finally { this.busy = false }
    },
    async confirm() {
      await this.saveAll()
      this.pl.confirm(4, this.st.current.id)
      this.$root.toast('提示词已确认，进入视频生成')
    }
  }
}

function emptyRefs() { return { images: [], videos: [], first: null, last: null } }
</script>
