<template>
  <div class="modal-mask" @click.self="close">
    <div class="modal cv-modal">
      <div class="modal-title cv-title">
        <span>封面 · {{ ep ? ep.name : '' }}</span>
        <span style="flex:1"></span>
        <div class="cv-ratios">
          <button v-for="r in ratios" :key="r.id" class="cv-ratio" :class="{ on: ratio === r.id }"
                  :disabled="busy" @click="setRatio(r.id)" :title="r.label + ' · ' + r.w + '×' + r.h">{{ r.short }}</button>
        </div>
      </div>

      <div class="cv-body">
        <!-- 左：画面 + 版本 -->
        <div class="cv-left">
          <div class="cv-stage" :class="{ portrait: isPortrait }">
            <img v-if="pickSrc" :src="pickSrc" alt="" />
            <div v-else class="cv-empty">
              {{ versions.length ? '未选封面' : '还没有封面' }}
              <span>{{ versions.length ? '点下面缩略图挑一版' : '右边填好文案，点「生成」' }}</span>
            </div>
            <div v-if="busy" class="cv-mask"><i class="spin"></i><span>{{ msg }}</span></div>
          </div>
          <div class="cv-meta">
            <template v-if="pickVer">
              <span>{{ pickVer.width }}×{{ pickVer.height }}</span>
              <span v-if="pickVer.snapshot && pickVer.snapshot.seed">seed {{ pickVer.snapshot.seed }}</span>
              <span v-if="pickVer.snapshot && pickVer.snapshot.imported">本地导入</span>
              <span v-if="pickVer.ms">耗时 {{ (pickVer.ms / 1000).toFixed(0) }}s</span>
            </template>
            <span v-else class="hint">{{ versions.length ? '未选封面 · 点「确认」即不使用封面' : '点 ＋ 可从本地选一张' }}</span>
            <span style="flex:1"></span>
            <span v-if="isSaved" class="cv-on">当前封面</span>
            <span v-else-if="versions.length" class="hint">{{ versions.length }} 版</span>
          </div>
          <!-- 版本网格：点一下选中、再点一下取消（toggle）；末尾的 ＋ 是「从本地选一张」 -->
          <div class="cv-vers" :class="{ portrait: isPortrait }">
            <div v-for="v in versions" :key="v.file" class="cv-thumb" :class="{ on: v.file === sel }"
                 :title="(v.snapshot && v.snapshot.imported ? '本地导入 · ' : '') + v.file + (v.file === sel ? '（再点一下取消）' : '')"
                 @click="choose(v)">
              <img v-if="srcOf(v.path)" :src="srcOf(v.path)" alt="" />
            </div>
            <div class="cv-thumb cv-add-local" :class="{ busy: impBusy }" :title="'从本地选一张图片当封面'"
                 @click="importLocal">
              <span v-if="!impBusy">＋</span>
              <i v-else class="spin"></i>
            </div>
          </div>
        </div>

        <!-- 右：四块（顺序即约束：文案定稿 → 选风格 → 选参考图 → 出图） -->
        <div class="cv-right">
          <div class="cv-step">
            <div class="cv-h">
              <b>文案</b>
              <span style="flex:1"></span>
              <button class="btn sec cv-sm" :disabled="llmBusy || busy || !ep" @click="genCopy">
                {{ llmBusy ? '生成中…' : (opts.length ? '换 3 条' : '出 3 条候选') }}
              </button>
            </div>
            <input class="cv-in" v-model="title" :disabled="busy" maxlength="8"
                   placeholder="主标题（2~6 字）" />
            <input class="cv-in cv-in-sub" v-model="subtitle" :disabled="busy" maxlength="10"
                   placeholder="副标题（可空，2~8 字）" />
            <div v-if="opts.length" class="cv-opts">
              <div v-for="(o, i) in opts" :key="'o' + i" class="cv-opt" :class="{ on: title === o.title }"
                   @click="useOpt(o)">
                <b>{{ o.title }}</b>
                <span class="cv-opt-sub">{{ o.subtitle }}</span>
              </div>
            </div>
          </div>

          <div class="cv-step">
            <div class="cv-h">
              <b>风格</b>
            </div>
            <div class="cv-pills">
              <span v-for="s in styles" :key="s.id" class="cv-pill" :class="{ on: style === s.id }"
                    @click="pickStyle(s.id)">{{ s.label }}</span>
            </div>
          </div>

          <div class="cv-step">
            <div class="cv-h">
              <b>参考图</b>
              <span class="cv-tip">第 1 张是环境，第 2 张是人物</span>
            </div>
            <div class="cv-refs">
              <span v-for="(p, i) in picks" :key="'r' + i" class="cv-ref">
                <i>{{ i + 1 }}</i>{{ p.name }}
                <em>{{ p.role === 'scene' ? '场景' : '人物' }}</em>
                <b v-if="!busy" @click="removeRef(i)" title="移除">×</b>
              </span>
              <span v-if="!picks.length" class="cv-none">未选参考图，只出场景</span>
            </div>
            <div v-if="addable.length" class="cv-adds">
              <button v-for="c in addable" :key="c.kind + c.name" class="cv-add" :disabled="busy"
                      @click="addRef(c)" :title="c.path">＋ {{ c.name }}</button>
            </div>
            <div v-else-if="refBusy" class="cv-none">正在扫描本集的角色与场景图…</div>
            <div v-else class="cv-none">本集还没有带图的角色 / 场景 —— 先去「角色 &amp; 场景」出图</div>
          </div>

          <div class="cv-step cv-step-gen">
            <div class="cv-h">
              <b>生成</b>
              <span style="flex:1"></span>
              <!-- 分辨率：选项与「导出成片」弹窗同一套（主进程 models.resOptions().out），
                   再按当前画幅过滤同向档位 —— 竖版画布列横版尺寸只会让人选错。 -->
              <select class="cv-res" v-model="res" :disabled="busy" @change="saveState">
                <option v-for="o in resList" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <button class="btn pro cv-gen" :disabled="busy || !canGen" @click="gen">
              <span v-if="busy"><i class="spin"></i>{{ msg }}</span>
              <span v-else>生成 {{ n }} 张 · 约 {{ estText }}</span>
            </button>
            <div v-if="hint" class="cv-hint bad">{{ hint }}</div>
          </div>
        </div>
      </div>

      <div class="modal-ops">
        <span class="hint cv-foot">{{ footHint }}</span>
        <span style="flex:1"></span>
        <button class="btn sec" :disabled="busy" @click="close">关闭</button>
        <!-- 同一颗按钮：有选中 = 确认用这张；没选中 = 不选封面（变次色，语义写在按钮上） -->
        <button class="btn" :class="{ sec: !sel }" :disabled="busy" @click="confirmPick">
          {{ sel ? '确认' : '不用封面' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { composeSystem, composeUser } from './prompts.js'
import { joinPath, seg } from './resutil.js'
import {
  COVER_STYLES, COVER_RATIOS, COVER_NEG,
  buildCoverPrompt, coverDirOf, ratioTag, checkCopy, coverResOptions, coverSize
} from './coverPrompt.js'

/** 从一段可能带 ```json 围栏的文本里抠出 JSON 对象（本地小模型经常加围栏或前后说话） */
function parseJsonLoose(text) {
  let s = String(text || '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return JSON.parse(s)
}

export default {
  name: 'CoverStudio',
  props: {
    // 只在打开时创建（父组件用 v-if），所以这里不需要 open 判断
    open: { type: Boolean, default: true }
  },
  data() {
    return {
      styles: COVER_STYLES,
      ratios: COVER_RATIOS,
      title: '',
      subtitle: '',
      style: 'song',
      ratio: '16:9',
      picks: [],        // 参考图（顺序即提示词里的第 1/2 张）[{kind, role, name, path}]
      refCands: [],     // 本集所有带图的角色 / 场景 [{kind, role, name, path}]
      refBusy: false,
      opts: [],         // 文案候选 [{title, subtitle, angle, subject, why}]
      llmBusy: false,
      versions: [],     // 历史封面 [{file, path, width, height, mtimeMs, ms, snapshot}]
      sel: '',          // 当前**正在看**的那一版（本地选择，点「确认」才写进 covers.json）
      savedPick: '',    // 已确认的本集封面（= covers.json 的 pick；确认时没选中就写空串）
      n: 2,             // 一次出几张（每张换 seed，出完自己挑）
      res: 'auto',      // 画布分辨率档：「自动」= 该画幅的模型原生尺寸
      impBusy: false,   // 正在从本地导入图片
      busy: false,
      msg: '',
      b64: {},
      loading: {}
    }
  },
  computed: {
    st() { return useProjectStore() },
    ep() { return this.st.current },
    shots() { return (this.ep && this.ep.shots) || [] },
    coverDir() { return coverDirOf(this.ep) },
    isPortrait() { return this.ratio === '9:16' },
    /** 当前画布尺寸：自动 → 画幅原生尺寸；选了档位 → 该档位 */
    size() { return coverSize(this.ratio, this.res) },
    /** 分辨率下拉：与「导出成片」同一套口径，按画幅过滤同向档 */
    resList() { return coverResOptions((this.st.resOptions || {}).out, this.ratio) },
    /** 正在看的这一版就是已确认的封面 */
    isSaved() { return !!(this.sel && this.savedPick && this.sel === this.savedPick) },
    /** 底部那行提示：随选中状态说清「点下去会发生什么」，这是唯一的后果说明 */
    footHint() {
      if (!this.sel) {
        return this.savedPick
          ? '当前没有选中封面 —— 点「不用封面」会去掉本集已有的封面，导出不加片头'
          : '当前没有选中封面 —— 点「不用封面」导出时不加片头'
      }
      if (this.isSaved) return '这就是本集当前封面，导出时会在正片前加 1 秒'
      return '点「确认」后，导出时会在正片前加 1 秒这个封面'
    },
    dramaName() {
      const p = (this.st.tree || []).find(x => x.id === (this.ep && this.ep.projectId))
      return (p && p.name) || ''
    },
    pickVer() { return this.versions.find(v => v.file === this.sel) || null },
    pickSrc() { return this.pickVer ? this.srcOf(this.pickVer.path) : '' },
    /** 还没被选中的、可以在「＋」里加的参考图 */
    addable() {
      const used = new Set(this.picks.map(p => p.kind + '/' + p.name))
      return this.refCands.filter(c => !used.has(c.kind + '/' + c.name))
    },
    /** 出图前拦一道：字不符合要求就别烧 80 秒（模型画坏的字抠不掉，只能整张重来） */
    copyErr() { return checkCopy(this.title, this.subtitle) },
    canGen() { return !this.copyErr },
    /** 只在文案不合规时显示原因；正常情况一个字都不占 */
    hint() { return this.copyErr || '' },
    estText() {
      // 实测单张 77~95 秒（1344×768 / 25 步），按 90 秒估，别按理想的 80 秒报
      const sec = (Number(this.n) || 2) * 90
      if (sec < 60) return sec + ' 秒'
      const m = Math.floor(sec / 60), s = sec % 60
      return s ? m + ' 分 ' + s + ' 秒' : m + ' 分钟'
    }
  },
  watch: {
    // 切集（或集被重新打开）→ 整块重建，避免把上一集的文案写进这一集
    'st.current.id'(v) {
      if (!v) return this.close()
      this.reload()
    }
  },
  created() {
    // 兜底：分辨率下拉要跟「导出成片」用同一份清单（正常情况 store 初始化时已加载过）
    if (!this.st.resOptions) this.st.loadResOptions()
    this.reload()
  },
  methods: {
    /* ---------------- 载入 / 落库 ---------------- */
    async reload() {
      const ep = this.ep
      if (!ep) return
      const c = ep.covers || {}
      this.opts = []
      this.savedPick = c.pick || ''
      this.sel = this.savedPick          // 打开就停在「这一集现用的那张」上
      this.style = c.style || 'song'
      this.ratio = c.ratio || '16:9'
      this.res = c.res || 'auto'
      this.title = c.title || this.dramaName || ''
      this.subtitle = c.subtitle || ''
      this.b64 = {}; this.loading = {}
      await this.loadRefOptions()
      this.picks = this.refsFromState(c.refs) || this.autoRefs()
      await this.loadVersions()
      // 🔴 这里**不再**自动选中最新一版：没确认过封面就该是「未选」状态，
      //    否则一进弹窗就有选中项，直接点「确认」等于凭空给这集加了片头封面。
      // 落库的分辨率档可能跟当前画幅不匹配（上次存的是竖版档、这次开的是横版）→ 回自动
      if (!this.resList.some(o => o.value === this.res)) this.res = 'auto'
    },
    /**
     * 落库：文案 / 风格 / 比例 / 分辨率 / 参考图 / **已确认的封面**。
     * 🔴 这里写的是 savedPick 而不是 sel —— 点缩略图只是本地浏览，
     *    必须点「确认」才算把那张定为封面（否则随便点两下浏览就把封面换了）。
     */
    async saveState() {
      if (!this.ep) return
      try {
        await this.st.saveArtifact('covers', {
          title: this.title,
          subtitle: this.subtitle,
          style: this.style,
          ratio: this.ratio,
          res: this.res,
          refs: this.picks.map(p => ({ kind: p.kind, name: p.name })),
          pick: this.savedPick,
          at: Date.now()
        })
      } catch (e) { /* 状态存不上不影响已经出好的图 */ }
    },
    async loadVersions() {
      if (!this.coverDir) return
      try {
        const list = await window.studio.listImages(this.coverDir)
        this.versions = Array.isArray(list) ? list : []
      } catch (e) { this.versions = [] }
      this.hydrate(this.versions)   // 不 await：缩略图解码出来一张显示一张
    },
    /** 本集所有「带图」的角色 / 场景，作为参考图候选（路径规则与 StageChars 一致） */
    async loadRefOptions() {
      const ep = this.ep
      if (!ep) return
      this.refBusy = true
      const jobs = []
      for (const c of (ep.chars || [])) {
        jobs.push({ kind: 'character', role: 'char', name: c.name, libReadonly: c.libReadonly === true })
      }
      for (const s of (ep.scenes || [])) {
        jobs.push({ kind: 'scene', role: 'scene', name: s.name, libReadonly: s.libReadonly === true })
      }
      const out = []
      await Promise.all(jobs.map(async (j) => {
        const base = j.libReadonly ? ep.assetsDir : (ep.epAssetsDir || ep.assetsDir)
        if (!base) return
        const dir = joinPath(base, j.kind === 'scene' ? 'scenes' : 'characters', seg(j.name))
        try {
          const imgs = await window.studio.listImages(dir)
          if (Array.isArray(imgs) && imgs.length) {
            out.push({ kind: j.kind, role: j.role, name: j.name, path: imgs[0].path })
          }
        } catch (e) { /* 目录不存在 = 这张卡还没出图，跳过 */ }
      }))
      // 人物在前、场景在后：用户加图时先看到主角更符合直觉（顺序不影响已选好的 picks）
      out.sort((a, b) => (a.role === b.role ? 0 : (a.role === 'char' ? -1 : 1)))
      this.refCands = out
      this.refBusy = false
    },
    /** 从落库的引用还原参考图（名字对不上 = 那张卡已被删/改名 → 返回 null 走自动推导） */
    refsFromState(refs) {
      if (!Array.isArray(refs) || !refs.length) return null
      const out = []
      for (const r of refs) {
        const c = this.refCands.find(x => x.kind === r.kind && x.name === r.name)
        if (c) out.push({ kind: c.kind, role: c.role, name: c.name, path: c.path })
      }
      return out.length ? out : null
    },
    /**
     * 默认参考图：本集镜头里出现次数最多的场景 / 角色（口径 = 分镜的 scene / chars 字段）。
     * 🔴 横版 = [场景, 人物]（先环境后人物，实测融合最自然）；竖版 = 只给人物（塞场景会稀释主体）。
     */
    autoRefs() {
      const count = (field) => {
        const m = {}
        for (const s of this.shots) {
          const raw = String((s && s[field]) || '')
          for (const name of raw.split(/[、,，/／·;；\s]+/).filter(Boolean)) m[name] = (m[name] || 0) + 1
        }
        return Object.keys(m).sort((a, b) => m[b] - m[a])
      }
      const rankC = count('chars'), rankS = count('scene')
      const find = (role, rank) => {
        for (const n of rank) {
          const c = this.refCands.find(x => x.role === role && x.name === n)
          if (c) return c
        }
        return this.refCands.find(x => x.role === role) || null
      }
      const sc = find('scene', rankS)
      const ch = find('char', rankC)
      const wrap = (c) => (c ? { kind: c.kind, role: c.role, name: c.name, path: c.path } : null)
      const out = []
      if (this.isPortrait) { if (ch) out.push(wrap(ch)) }
      else { if (sc) out.push(wrap(sc)); if (ch) out.push(wrap(ch)) }
      return out
    },
    /** 换字体风格：只改提示词里的字形句，不重排、不重选参考图（所以必须出图前决定） */
    pickStyle(id) {
      if (this.busy || this.style === id) return
      this.style = id
      this.saveState()
    },
    setRatio(id) {
      if (this.busy || this.ratio === id) return
      this.ratio = id
      // 分辨率档按画幅过滤：原来选的（比如 1920×1080）在新画幅里不存在 → 回「自动」
      if (!this.resList.some(o => o.value === this.res)) this.res = 'auto'
      // 换比例后参考图口径跟着变（竖版默认只给人物）；用户自己加过的就保留
      const auto = this.autoRefs()
      const sameKinds = auto.length === this.picks.length && auto.every((a, i) => this.picks[i] && a.kind === this.picks[i].kind)
      if (!sameKinds) this.picks = auto
      this.saveState()
    },
    addRef(c) {
      if (this.busy) return
      const item = { kind: c.kind, role: c.role, name: c.name, path: c.path }
      // 场景插最前、人物其后 —— 与「第 1 张环境、第 2 张人物」的约定一致
      if (c.role === 'scene') this.picks.splice(0, 0, item)
      else this.picks.push(item)
      this.saveState()
    },
    removeRef(i) {
      if (this.busy) return
      this.picks.splice(i, 1)
      this.saveState()
    },
    /**
     * 点缩略图 = 切换选中（toggle）：点一下选中、再点同一张取消。
     * 只改本地 sel，不写盘 —— 必须点「确认」才落 covers.json。
     * 取消选中后大图回到空态（用户要求），不会悄悄保留上一张造成「还选着」的错觉。
     */
    choose(v) {
      if (this.busy) return
      this.sel = (this.sel === v.file) ? '' : v.file
    },
    /**
     * 预读一版图片的 base64。
     * 🔴 必须在这里读，不能像 StageChars 那样在渲染函数里懒读：本项目是 Vue 3（没有 this.$set），
     *    渲染期改 `loading` 会触发重渲染 → 再进 srcOf → 再读盘，形成一个每帧几 MB base64 的
     *    死循环（2026-11-04 e2e 实测：出完 3 张后渲染进程被拖垮，工作台弹窗直接消失）。
     *    所以 srcOf 只做纯查表，读盘全部集中在载入版本列表时做一次。
     */
    async hydrate(list) {
      for (const v of (list || [])) {
        const p = v && v.path
        if (!p || this.b64[p] || this.loading[p]) continue
        this.loading[p] = true
        try {
          const b = await window.studio.readFileBase64(p)
          if (b) this.b64[p] = 'data:image/png;base64,' + b
        } catch (e) { /* 读不到就留空，下次重开再试 */ }
        finally { delete this.loading[p] }
      }
    },
    srcOf(p) { return (p && this.b64[p]) || '' },
    close() { if (!this.busy) this.$emit('close') },

    /* ---------------- 确认 / 取消 / 本地导入 ---------------- */
    /**
     * 确认 = 提交这一次的选择。
     * 🔴 选中的那一版写进 covers.json.pick；**没有选中就写空串** —— 空 = 本集不用封面，
     *    导出时整条封面链路一步都不走（图片文件仍留在目录里，随时能再选回来）。
     */
    async confirmPick() {
      if (this.busy) return
      this.savedPick = this.sel || ''
      await this.saveState()
      this.$emit('changed')
      this.$emit('close')
    },
    /**
     * 从本地选一张现成图片当封面。
     * 走主进程弹系统文件框 + 复制进 <项目>/assets/covers/<集名>/ —— 见 ipc 'covers:import' 的注释：
     * 只引用源路径的话，源图一被挪走这集封面就假性消失了。
     */
    async importLocal() {
      if (this.busy || this.impBusy) return
      if (!this.coverDir) { this.$root.toast('取不到封面目录（项目素材目录未就绪）'); return }
      this.impBusy = true
      try {
        const r = await window.studio.importCover({ dir: this.coverDir })
        if (r && r.canceled) return
        if (!r || !r.ok) { this.$root.toast('导入失败：' + ((r && r.error) || '未知原因')); return }
        this.sel = r.file
        await this.loadVersions()
        this.$root.toast('已导入，点「确认」用它当封面')
      } catch (e) {
        this.$root.toast('导入失败：' + String((e && e.message) || e).slice(0, 90))
      } finally {
        this.impBusy = false
      }
    },

    /* ---------------- ① 文案候选（LLM） ---------------- */
    useOpt(o) {
      if (this.busy) return
      this.title = o.title || ''
      this.subtitle = o.subtitle || ''
      this.saveState()
    },
    shotBrief() {
      const list = this.shots.slice(0, 24)
      return list.map((s, i) => {
        const bits = []
        if (s.action) bits.push(String(s.action).slice(0, 70))
        if (s.dialogue) bits.push('台词「' + String(s.dialogue).slice(0, 40) + '」')
        return '镜' + (i + 1) + '：' + (bits.join('｜') || '')
      }).join('\n')
    },
    async genCopy() {
      if (this.llmBusy || this.busy || !this.ep) return
      this.llmBusy = true
      try {
        const system = await composeSystem({ specs: ['cover.md'], mustHave: ['"options"'], task: 'cover' })
        const user = await composeUser('cover.md', {
          drama: this.dramaName,
          epName: this.ep.name,
          chars: (this.ep.chars || []).map(c => c.name + (c.role ? '（' + c.role + '）' : '')).join('、') || '（本集档案里还没有人物）',
          adapted: String(this.ep.adapted || '').slice(0, 1800) || '（还没有改编稿）',
          shots: this.shotBrief() || '（还没有分镜）'
        })
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.9, maxTokens: 1200, json: true, stage: 'cover', label: '阶段6 封面文案', timeoutMs: 180000 })
        const j = parseJsonLoose(text)
        const list = (j && (j.options || j.候选 || j.candidates)) || []
        if (!Array.isArray(list) || !list.length) throw new Error('模型没有返回候选列表')
        this.opts = list.slice(0, 3).map(o => ({
          title: String(o.title || o.主标题 || '').replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 6),
          subtitle: String(o.subtitle || o.副标题 || '').replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 8),
          angle: String(o.angle || o.角度 || ''),
          subject: String(o.subject || o.画面主体 || ''),
          why: String(o.why || o.理由 || '')
        })).filter(o => o.title)
        if (!this.opts.length) throw new Error('候选里没有可用的标题（模型给的字不合规）')
        this.$root.toast('已出 ' + this.opts.length + ' 条文案候选，点一条套用')
      } catch (e) {
        this.$root.toast('文案生成失败：' + String((e && e.message) || e).slice(0, 80))
      } finally {
        this.llmBusy = false
      }
    },

    /* ---------------- ④ 直出 ---------------- */
    async gen() {
      if (this.busy) return
      if (this.copyErr) { this.$root.toast(this.copyErr); return }
      const ep = this.ep
      if (!ep) return
      const dir = this.coverDir
      if (!dir) { this.$root.toast('取不到封面目录（项目素材目录未就绪）'); return }
      const ver = this.nextVer()
      const base = Math.floor(Math.random() * 1e9)
      const refs = this.picks.map(p => ({ role: p.role, name: p.name }))
      const prompt = buildCoverPrompt({ title: this.title, subtitle: this.subtitle, styleId: this.style, refs, ratioId: this.ratio })
      const sz = this.size
      const total = Math.max(1, Math.min(6, Number(this.n) || 2))
      this.busy = true
      this.opts = []
      const t0 = Date.now()
      let ok = 0
      try {
        for (let i = 0; i < total; i++) {
          // 每张换 seed：同 seed + 同 prompt 是像素级确定的（实测 SSIM=1.000），
          // 不换 seed 的话「生成 3 张」会拿到三张一模一样的图。
          const seed = (base + i * 7919) >>> 0
          this.msg = '正在生成 ' + (i + 1) + ' / ' + total + '（每张约 90 秒）'
          const r = await window.studio.comfyGenerate({
            templateKey: 'character_edit',
            dir,
            baseName: 'cover_v' + ver + '_' + ratioTag(this.ratio) + '_' + (i + 1),
            params: {
              prompt,
              negative: COVER_NEG,
              images: this.picks.map(p => p.path),
              // 编辑通道的输出尺寸由空 latent 决定（ew/eh）；width/height 同步传，
              // 只是为了让主进程日志里的「本次图片生成配置」不说假话。
              ew: sz.w, eh: sz.h, width: sz.w, height: sz.h,
              resolution: 1024, steps: 25, cfg: 2.5, sampler: 'euler', scheduler: 'simple',
              seed,
              // 旁车快照：点历史版本能看见这一张当初用的文案 / 风格 / 参考图 / seed
              snapshot: {
                title: this.title, subtitle: this.subtitle, style: this.style,
                ratio: this.ratio, res: this.res, w: sz.w, h: sz.h,
                refs, seed, prompt
              }
            },
            label: '阶段6 封面'
          })
          ok++
          if (r && Array.isArray(r.files) && r.files.length) {
            this.sel = r.files[0]   // 刚出的那张直接上大图（还要点「确认」才定稿）
            await this.loadVersions()
          }
        }
        const sec = Math.round((Date.now() - t0) / 1000)
        this.$root.toast('已生成 ' + ok + ' 张（' + sec + ' 秒），挑一版点「确认」')
        await this.saveState()
      } catch (e) {
        const m = String((e && e.message) || e)
        this.$root.toast((ok ? '已出 ' + ok + ' 张，' : '') + '封面生成失败：' + m.slice(0, 90))
        await this.loadVersions()
      } finally {
        this.busy = false
        this.msg = ''
        this.$emit('changed')
      }
    },
    /** 版本号：已有 cover_vN_* 里最大的 N + 1（一个版本 = 一次点击出的那一批） */
    nextVer() {
      let max = 0
      for (const v of this.versions) {
        const m = /^cover_v(\d+)_/i.exec(v.file)
        if (m) max = Math.max(max, Number(m[1]) || 0)
      }
      return max + 1
    }
  }
}
</script>

<style scoped>
/* 大弹窗：左画面右四步。宽度比 modal-lg 更宽，因为要并排放一张 16:9 的图和四个步骤 */
.cv-modal{ width:min(920px,96vw); padding:16px 18px; max-height:94vh; overflow:auto; }
.cv-title{ display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.cv-ratios{ display:flex; }
.cv-ratio{
  font-size:11.5px; padding:4px 10px; cursor:pointer;
  background:#0f141d; color:#9fb0c8; border:1px solid var(--line);
  border-right:none; transition:none;
}
.cv-ratio:last-child{ border-right:1px solid var(--line); border-radius:0 6px 6px 0; }
.cv-ratio:first-child{ border-radius:6px 0 0 6px; }
.cv-ratio.on{ background:#1e3a8a; color:#dbeafe; border-color:#2b4d8f; }
.cv-ratio:disabled{ opacity:.55; cursor:default; }

.cv-body{ display:grid; grid-template-columns:minmax(0,1.05fr) minmax(0,1fr); gap:16px; }

/* 左：画面 */
.cv-left{ display:flex; flex-direction:column; gap:8px; min-width:0; }
.cv-stage{
  position:relative; border:1px solid var(--line-soft); border-radius:var(--r-sm);
  background:#0b1017; overflow:hidden; aspect-ratio:16/9;
  display:flex; align-items:center; justify-content:center;
}
.cv-stage.portrait{ aspect-ratio:9/16; max-height:430px; }
.cv-stage img{ width:100%; height:100%; object-fit:contain; display:block; }
.cv-empty{
  display:flex; flex-direction:column; align-items:center; gap:6px;
  font-size:12.5px; color:#6f7a8c;
}
.cv-empty span{ font-size:11.5px; color:#54606f; }
.cv-mask{
  position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
  background:rgba(5,9,15,.66); backdrop-filter:blur(1.5px);
  font-size:12.5px; color:#cfe4f7; z-index:2;
}
.cv-meta{ display:flex; align-items:center; gap:10px; font-size:11.5px; color:#8b95a9; }
.cv-vers{
  display:grid; grid-template-columns:repeat(auto-fill,minmax(76px,1fr)); gap:6px;
  max-height:150px; overflow:auto; padding:2px;
}
.cv-thumb{
  aspect-ratio:16/9; background:#0f141d; border:1px solid var(--line-soft);
  border-radius:5px; overflow:hidden; cursor:pointer;
}
/* 竖版画幅下缩略图也跟着竖过来，否则 9:16 的封面被 16:9 的框裁得只剩中间一条 */
.cv-vers.portrait .cv-thumb{ aspect-ratio:9/16; }
.cv-vers.portrait{ grid-template-columns:repeat(auto-fill,minmax(58px,1fr)); }
.cv-thumb.on{ border-color:#38bdf8; box-shadow:0 0 0 1px rgba(56,189,248,.45); }
.cv-thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
/* 「＋」本地选图：网格末尾一格，跟缩略图同尺寸（不额外占一行，也不跟生成按钮抢位置） */
.cv-add-local{
  display:flex; align-items:center; justify-content:center;
  background:rgba(56,189,248,.04); border:1px dashed rgba(56,189,248,.45);
  color:#7dd3fc; font-size:17px; line-height:1;
}
.cv-add-local:hover{ background:rgba(56,189,248,.12); border-color:#38bdf8; }
.cv-add-local.busy{ cursor:default; opacity:.7; }

/* 右：四步 */
.cv-right{ display:flex; flex-direction:column; gap:12px; min-width:0; }
.cv-step{ display:flex; flex-direction:column; gap:6px; }
.cv-step + .cv-step{ border-top:1px solid var(--line-soft); padding-top:11px; }
.cv-h{ display:flex; align-items:center; gap:7px; font-size:12.5px; color:#c7d2e0; }
.cv-h b{ font-weight:600; }
.cv-tip{ font-size:11px; color:#6f7a8c; }
.cv-sm{ font-size:11px; padding:2px 8px; }
.cv-in{
  width:100%; box-sizing:border-box; background:#0f141d; color:#e6eef8;
  border:1px solid var(--line); border-radius:6px; padding:7px 9px;
  font-size:14px; letter-spacing:.06em;
}
.cv-in-sub{ font-size:12px; letter-spacing:.04em; color:#c7d2e0; }
.cv-in:disabled{ opacity:.6; }

/* 3 条候选每条只有一行（标题 + 副标题），不再需要滚动 */
.cv-opts{ display:flex; flex-direction:column; gap:4px; max-height:132px; overflow:auto; padding-right:4px; }
.cv-opt{
  display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;
  padding:5px 8px; border:1px solid var(--line-soft); border-radius:6px;
  cursor:pointer; background:#0d121a;
}
.cv-opt:hover{ border-color:var(--line); background:#111825; }
.cv-opt.on{ border-color:#38bdf8; background:rgba(56,189,248,.08); }
.cv-opt b{ font-size:12.5px; color:#e6eef8; letter-spacing:.05em; }
.cv-opt-sub{ font-size:11.5px; color:#8b95a9; }

.cv-pills{ display:flex; gap:6px; }
.cv-pill{
  font-size:12px; padding:5px 14px; border-radius:6px; cursor:pointer;
  border:1px solid var(--line); color:#9fb0c8; background:#0f141d;
}
.cv-pill.on{ border-color:#38bdf8; color:#dbeafe; background:rgba(56,189,248,.12); }

.cv-refs{ display:flex; flex-wrap:wrap; gap:5px; }
.cv-ref{
  display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:#c7d2e0;
  border:1px solid var(--line); border-radius:999px; padding:3px 9px 3px 4px; background:#0f141d;
}
.cv-ref i{
  font-style:normal; width:15px; height:15px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center;
  font-size:10px; background:#1e3a8a; color:#dbeafe;
}
.cv-ref em{ font-style:normal; font-size:10.5px; color:#6f7a8c; }
.cv-ref b{ cursor:pointer; color:#6f7a8c; font-weight:400; padding:0 2px; }
.cv-ref b:hover{ color:#fca5a5; }
.cv-none{ font-size:11px; color:#6f7a8c; line-height:1.6; }
.cv-adds{ display:flex; flex-wrap:wrap; gap:5px; }
.cv-add{
  font-size:11px; padding:3px 9px; border-radius:999px; cursor:pointer;
  border:1px dashed var(--line); background:transparent; color:#8b95a9;
}
.cv-add:hover{ color:#cfe4f7; border-color:#38bdf8; }

.cv-step-gen{ gap:7px; }
.cv-gen{ width:100%; padding:9px 0; font-size:13px; }
/* 「从本地选择」：跟生成按钮同宽的次要操作，明确写成「或」的替代路径 */
.cv-hint{ font-size:11px; color:#6f7a8c; line-height:1.6; }
.cv-hint.bad{ color:#fca5a5; }
.cv-foot{ font-size:11px; color:#5c6675; max-width:430px; line-height:1.5; }
/* 分辨率下拉：跟「导出成片」弹窗里的 .res-sel 同一套视觉 */
.cv-res{
  background:#0f141d; color:#c7d2e0; border:1px solid var(--line);
  border-radius:5px; padding:2px 4px; font-size:11px; max-width:190px;
}
.cv-res:disabled{ opacity:.55; }
/* 左下 meta 行的「当前封面」标记：一眼看出这一集现在用的是哪张 */
.cv-on{
  font-size:10.5px; line-height:1; padding:2px 7px; border-radius:999px;
  background:rgba(16,185,129,.16); color:#6ee7b7; border:1px solid rgba(16,185,129,.35);
}
</style>
