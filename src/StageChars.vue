<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>
    <div v-if="!chars.length" class="placeholder">确认分镜后，从分镜中自动提取角色。</div>

    <div class="char-grid">
      <div v-for="(c, i) in chars" :key="c.name" class="ccard" :class="{ locked: c.locked, 'card-busy': c._gen }">
        <span v-if="c._gen" class="busy-txt"><i class="spin"></i>正在生成…</span>

        <div class="char-img">
          <img v-if="selFile(c)" :src="imgSrc(c._dir + '/' + selFile(c))" />
          <div v-else class="ph">{{ c.name[0] }}</div>
          <span v-if="c.locked" class="lock-tag">已锁定</span>
        </div>

        <div class="char-name">{{ c.name }} <span class="role-tag">{{ c.role }}</span></div>
        <textarea v-model="c.prompt" rows="3" :disabled="c.locked" placeholder="人物提示词（外貌/服装/气质）…"></textarea>

        <!-- 抽卡：最多显示最新 4 张（磁盘与记录全部保留，只是不渲染更早的） -->
        <div class="thumbs" v-if="c.candidates.length">
          <div v-for="t in shown(c)" :key="t.i" class="thumb-wrap">
            <img :src="imgSrc(c._dir + '/' + t.f)" :class="{ cur: t.i === c.cur }"
                 title="点击选中／再点一次取消选中" @click="pick(c, t.i)" />
            <button v-if="!c.locked" class="img-x" title="删除这张图" @click.stop="askDel(c, t.i)">✕</button>
          </div>
        </div>

        <div class="cops" v-if="!c.locked">
          <button class="btn sm" :class="{ regen: c.cur >= 0 }" :disabled="busy" @click="gen(i)">
            {{ c.cur >= 0 ? '图生图' : '文生图' }}
          </button>
          <button class="btn ghost sm" :disabled="c.cur < 0" @click="lock(i)">锁定</button>
        </div>
        <div v-else class="hint" style="text-align:center; padding:6px">已锁定 — 本集角色图固定</div>
      </div>
    </div>

    <!-- 操作条统一放模块右下角 -->
    <div class="ops-bar">
      <button class="btn" :class="{ regen: chars.some(c => c.candidates.length) }" :disabled="busy || !chars.length" @click="genAll">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>生成中…</span>
        <span v-else>批量生成</span>
      </button>
      <button class="btn ghost" :disabled="busy || !chars.length" @click="saveAll">保存全部修改</button>
      <span class="hint">角色图由 ComfyUI 生成，保存到 资源库/角色名/（永不覆盖，可无限重生成）；锁定后本集固定为视频参考图</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="!allLocked" @click="confirm">下一步</button>
    </div>

    <!-- 删除单张图：永久删除（物理删盘）/ 删除显示（仅移出列表） -->
    <div v-if="ask" class="modal-mask" @click.self="ask = null">
      <div class="modal">
        <div class="modal-title">删除这张角色图？</div>
        <div class="modal-body mono">{{ ask.c.name }} / {{ ask.f }}</div>
        <div class="modal-note">
          <b>永久删除</b>：从磁盘物理删除，无法恢复。<br>
          <b>删除显示</b>：只是不再在这里列出，磁盘文件仍保留在 资源库/{{ ask.c.name }}/。
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDel(true)">永久删除</button>
          <button class="btn ghost" @click="doDel(false)">删除显示</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="ask = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline } from './stores/pipeline.js'
import { stepLog, secs } from './ulog.js'

const DEFAULT_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality'
const SHOW_MAX = 4   // 抽卡区最多渲染最新几张（磁盘与 candidates 记录不受影响）

export default {
  name: 'StageChars',
  data() { return { chars: [], busy: false, _b64: {}, ask: null } },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    allLocked() { return this.chars.length > 0 && this.chars.every(c => c.locked) }
  },
  watch: {
    'st.current'(ep) { if (ep) this.init(ep) },
    'pl.active'(v) {
      // 解锁重做第4块：清除卡片级锁定，恢复生图/删除/锁定按钮与缩略图切换
      if (v !== 3 || this.pl.done[3]) return
      if (!this.chars.some(c => c.locked)) return
      this.chars.forEach(c => { c.locked = false })
      this.saveAll()
      this.$root.toast('角色库已解锁重做，生图/编辑按钮已恢复')
    }
  },
  created() { if (this.ep) this.init(this.ep) },
  methods: {
    init(ep) {
      if (ep.chars && ep.chars.length) {
        this.chars = JSON.parse(JSON.stringify(ep.chars))
      } else if (ep.shots && ep.shots.length) {
        // 从分镜提取角色
        const set = new Map()
        ep.shots.forEach((s, si) => String(s.chars || '').split(/[、,，]/).forEach(n => {
          n = n.trim(); if (!n) return
          if (!set.has(n)) set.set(n, { name: n, role: si === 0 ? '主人公' : 'NPC', prompt: '', candidates: [], cur: -1, locked: false })
        }))
        this.chars = [...set.values()].map(c => ({
          ...c,
          prompt: c.role === '主人公'
            ? '1boy, young man, anime style, detailed face, heroic expression, ' + c.name + ', full body, white background'
            : 'anime style character, detailed face, full body, white background'
        }))
        this.saveAll()
      } else {
        // 新建的集数（既无角色也无分镜）必须清空 —— 否则会保留上一集提取出来的角色
        this.chars = []
      }
      // 每个角色的资源库目录
      this.chars.forEach(c => { c._dir = 'library/' + c.name })
    },
    selFile(c) { return c.cur >= 0 ? (c.candidates[c.cur] || null) : null },
    /** 抽卡区只渲染最新 SHOW_MAX 张，返回时带上真实下标 */
    shown(c) { return c.candidates.map((f, i) => ({ f, i })).slice(-SHOW_MAX) },
    absOf(c, f) {
      return (this.st.workspace || '') + '\\' + ('library/' + c.name + '/' + f).replace(/\//g, '\\')
    },
    imgSrc(rel) {
      // library/<name>/<file> → workspace 绝对路径 → base64
      const abs = (this.st.workspace || '') + '\\' + String(rel).replace(/\//g, '\\')
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''   // 占位，避免同一张图被重复读盘
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) this._b64[abs] = 'data:image/png;base64,' + b64
        else delete this._b64[abs]   // 读取失败不缓存空串，下次渲染重试（文件可能稍后才落盘）
      })
      return ''
    },
    /** 点缩略图：选中并放大到主预览；再点同一张 → 取消选中（按钮随之回到「文生图」） */
    pick(c, i) {
      if (c.locked) return
      c.cur = (c.cur === i) ? -1 : i
      this.saveAll()
    },
    askDel(c, i) { this.ask = { c, i, f: c.candidates[i] } },
    async doDel(permanent) {
      const { c, i, f } = this.ask
      const L = stepLog('阶段4 角色出图')
      try {
        if (permanent) {
          const abs = this.absOf(c, f)
          await window.studio.deleteFile(abs)
          delete this._b64[abs]
          L.done('已永久删除角色图：' + c.name + '/' + f)
        } else {
          L.done('已从列表移除（磁盘保留）：' + c.name + '/' + f)
        }
        c.candidates.splice(i, 1)
        if (c.cur === i) c.cur = -1
        else if (c.cur > i) c.cur -= 1
        await this.saveAll()
        this.$root.toast(permanent ? '已永久删除（磁盘文件已删）' : '已从列表移除（磁盘文件保留）')
      } catch (e) {
        L.fail('删除角色图失败', null, e)
        this.st.fail(e)
      } finally { this.ask = null }
    },
    async saveAll() {
      // _dir / _gen 都是运行时字段，不落库
      const clean = this.chars.map(o => {
        const c = { ...o }
        delete c._dir; delete c._gen
        return c
      })
      await this.st.saveArtifact('chars', clean)
    },
    async gen(i, ctx) {
      const c = this.chars[i]
      this.busy = true
      c._gen = true
      const t0 = Date.now()
      const L = stepLog('阶段4 角色出图')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      const fromRef = c.cur >= 0
      L.start('正在生成角色图：' + c.name + prog + (fromRef ? '（图生图，参考：' + c.candidates[c.cur] + '）' : '（文生图）'))
      try {
        const dir = (this.st.workspace || '') + '\\library\\' + c.name
        const r = await window.studio.comfyGenerate({
          templateKey: 'character', dir, baseName: c.name,
          params: {
            prompt: c.prompt, negative: DEFAULT_NEG,
            // 选了缩略图 → 图生图（拿那张图当底图重绘，denoise 0.62）；没选 → 纯文生图
            ...(fromRef ? { image: this.absOf(c, c.candidates[c.cur]) } : {})
          },
          label: '阶段4 角色出图'
        })
        // 可无限重生成：磁盘与 candidates 记录全部保留，只是抽卡区最多显示最新 4 张
        c.candidates = [...c.candidates, ...r.files]
        c.cur = c.candidates.length - 1
        await this.saveAll()
        this.pl.markGen(3, Date.now() - t0)
        L.done('角色「' + c.name + '」生成完成：' + r.files.join('、'), Date.now() - t0)
        this.$root.toast(c.name + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail('角色「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { c._gen = false; this.busy = false }
    },
    async genAll() {
      const L = stepLog('阶段4 角色出图')
      const idx = []
      for (let i = 0; i < this.chars.length; i++) {
        const c = this.chars[i]
        if (!c.locked && !c.candidates.length) idx.push(i)   // 跳过已锁定与已有图的
      }
      if (!idx.length) {
        this.$root.toast('没有需要生成的角色（已锁定或已有图）')
        return
      }
      L.start('开始批量生成角色图：待生成 ' + idx.length + ' 个（共 ' + this.chars.length + ' 个角色，跳过 ' + (this.chars.length - idx.length) + ' 个已锁定/已有图）')
      const tAll = Date.now()
      let okN = 0, badN = 0
      this.busy = true
      try {
        for (let k = 0; k < idx.length; k++) {
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const sum = '批量生成角色图结束：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各角色失败原因'))
        else if (badN) L.warn(sum)
        else L.done(sum, null)
      } finally { this.busy = false }
    },
    async lock(i) {
      const c = this.chars[i]
      if (c.cur < 0) return
      c.locked = true
      await this.saveAll()
      this.$root.toast(c.name + ' 已锁定')
    },
    async confirm() {
      await this.saveAll()
      this.pl.confirm(3, this.ep.id)
      this.$root.toast('角色库已确认')
    }
  }
}
</script>
