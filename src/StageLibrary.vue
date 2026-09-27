<template>
  <div class="lib-wrap">
    <!-- 左：库条目列表（角色 / 场景两组）＋ 手动新增 -->
    <div class="lib-side">
      <div class="ls-head">
        <b>项目角色场景库</b>
        <span class="ls-hint">改动会影响引用它的所有集</span>
      </div>
      <div class="ls-ops">
        <button class="btn sec sm" :disabled="busy" @click="askAdd = { kind: 'character', name: '' }">＋ 角色</button>
        <button class="btn sec sm" :disabled="busy" @click="askAdd = { kind: 'scene', name: '' }">＋ 场景</button>
      </div>
      <div class="ls-body">
        <template v-for="grp in groups" :key="grp.kind">
          <div v-if="grp.items.length" class="ls-grp">
            <span class="ls-ico">{{ grp.kind === 'scene' ? '🏞' : '🧑' }}</span>
            <span>{{ grp.label }}</span>
            <span class="ls-cnt">{{ grp.items.length }}</span>
          </div>
          <div v-for="e in grp.items" :key="e.id" class="ls-row"
               :class="{ active: e.id === targetId }" @click="open(e)">
            <span class="ls-name">{{ e.name }}</span>
            <span class="ls-n">{{ e.images.length ? e.images.length + ' 图' : '未出图' }}</span>
          </div>
        </template>
        <div v-if="!entries.length" class="muted" style="padding:12px 8px;font-size:12px">
          库里还没有条目。生成分镜后把本集角色「保存到项目」，或点上面的「＋ 角色 / ＋ 场景」手动新增。
        </div>
      </div>
    </div>

    <!-- 右：条目编辑区（布局参考「角色 & 场景」的卡片） -->
    <div class="lib-main">
      <div v-if="!entry" class="placeholder" style="margin-top:40px">
        左侧点一个角色 / 场景开始编辑
      </div>
      <div v-else class="lib-card" :class="entry.kind">
        <div class="lc-head">
          <span class="lc-ico">{{ entry.kind === 'scene' ? '🏞' : '🧑' }}</span>
          <b class="lc-name">{{ entry.name }}</b>
          <span class="lc-role">{{ entry.role || (entry.kind === 'scene' ? '场景' : '配角') }}</span>
          <span class="lc-rev" :title="'库版本号：每次改动 +1；引用它的集会据此提示重新生成'">库版本 {{ entry.libRev }}</span>
          <span style="flex:1"></span>
          <button class="btn ghost sm" :disabled="busy" @click="askRename = { name: entry.name }">改名</button>
        </div>
        <div class="lc-usage">
          <span class="lu-t">被引用的集/镜：</span>
          <span v-if="usage.length" class="lu-v">{{ usageText(usage) }}</span>
          <span v-else class="muted">暂未被任何集引用</span>
          <span v-if="entry.from && entry.from.epName" class="lu-from">（首次入库：{{ entry.from.epName }}）</span>
        </div>

        <div class="lc-body">
          <!-- 左：大预览 + 档案 -->
          <div class="lc-left">
            <div class="bigprev">
              <img v-if="selFile" :src="imgSrc(absOf(selFile))" :title="'点击放大预览'" @click="previewImg" />
              <div v-else class="ph">{{ entry.name[0] }}</div>
              <span v-if="dim" class="dim-tag">{{ dim }}</span>
            </div>
            <div class="f pf-box">
              <div class="pf-head"><label>{{ entry.kind === 'scene' ? '场景档案' : '角色档案' }}</label></div>
              <textarea v-model="entry.profile" :rows="entry.kind === 'scene' ? 6 : 8"
                        placeholder="档案：每行一个字段「字段名：值」…（改完点右上角「刷新提示词」重算提示词）"
                        @change="saveField('profile', entry.profile)"></textarea>
            </div>
          </div>

          <!-- 右：正向 / 负向 / 抽卡 / 分辨率 / 生图 -->
          <div class="lc-right">
            <div class="f ta-prompt">
              <div class="ta-head">
                <label>正向提示词</label>
                <span style="flex:1"></span>
                <button class="btn icon" :disabled="busy || !String(entry.profile || '').trim()"
                        title="按本条目档案重新生成正向 / 负向提示词（会覆盖当前值，之后仍可手改）"
                        @click="genPrompt">
                  <span v-if="pgBusy" class="busy-txt"><i class="spin"></i></span>
                  <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
                  </svg>
                </button>
              </div>
              <textarea v-model="entry.prompt" rows="6" placeholder="正向提示词"
                        @change="saveField('prompt', entry.prompt)"></textarea>
            </div>
            <div class="f ta-neg"><label>负向提示词</label>
              <textarea v-model="entry.negative" rows="3" placeholder="负向提示词"
                        @change="saveField('negative', entry.negative)"></textarea>
            </div>

            <div class="f"><label>抽卡记录 <span class="hint" style="font-size:10px">点击选中为图生图底图</span></label>
              <div class="thumbs" v-if="entry.images.length">
                <div v-for="t in shown" :key="t.i" class="thumb-wrap">
                  <img :src="imgSrc(absOf(t.f))" :class="{ cur: t.i === entry.cur }"
                       title="点击选中／再点一次取消选中" @click="pick(t.i)" />
                </div>
              </div>
              <div v-else class="hint" style="font-size:11px">尚未出图</div>
            </div>

            <label class="card-res">分辨率
              <select v-model="entry.res" :disabled="busy" @change="saveField('res', entry.res)">
                <option v-for="o in opts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>

            <div class="ops-row">
              <span v-if="genText" class="gen-ms" :class="{ live: genAt }">{{ genText }}</span>
              <button class="btn sm" :class="{ regen: refAsBase && entry.cur >= 0 }" :disabled="busy" @click="gen">
                {{ refAsBase && entry.cur >= 0 ? '图生图' : '文生图' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 改名弹窗：重命名图片目录 + 扫各集替换引用 -->
    <div v-if="askRename" class="modal-mask" @click.self="askRename = null">
      <div class="modal">
        <div class="modal-title">重命名库条目</div>
        <div class="modal-note">
          改名会**重命名图片目录**，并把引用它的所有集里的名字一起换掉（卡片档案、分镜的「本集有谁」、对白「人名：台词」），
          所以不会断链。名字是唯一键：同一人物的不同年龄 / 形态请写成「基础名-限定词」。
        </div>
        <input type="text" v-model="askRename.name" @keyup.enter="doRename" style="margin:8px 0" />
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askRename = null">取消</button>
          <button class="btn" :disabled="!String(askRename.name || '').trim()" @click="doRename">改名</button>
        </div>
      </div>
    </div>

    <!-- 手动新增库条目 -->
    <div v-if="askAdd" class="modal-mask" @click.self="askAdd = null">
      <div class="modal">
        <div class="modal-title">新增库{{ askAdd.kind === 'scene' ? '场景' : '角色' }}</div>
        <div class="modal-note">
          名字即图片目录名与全项目唯一键。新增后档案 / 提示词留空，需自己补；补完点「刷新提示词」再出图。
        </div>
        <input type="text" v-model="askAdd.name" placeholder="例如：张伯 / 李白-老年"
               @keyup.enter="doAdd" style="margin:8px 0" />
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askAdd = null">取消</button>
          <button class="btn" :disabled="!String(askAdd.name || '').trim()" @click="doAdd">新增</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog } from './ulog.js'
import { parseRes, resLabel, optsWith, joinPath } from './resutil.js'
import { composeSystem, composeUser, readDefaultNegative, readEquipmentWords, stripEquipmentWords } from './prompts.js'

const SHOW_MAX = 6
const TAG = '项目角色场景库'
// 🔴 兜底负向词表来自项目规范 md（chars.md / scenes.md 的「## 兜底默认」小节里的「负向:」行），
//    代码不再内置；同一项目只读一次，读不到为空串。
let _negCache = { pid: '', val: '' }
async function negDefault() {
  const cur = useProjectStore().current
  const pid = (cur && cur.projectId) || ''
  if (_negCache.pid === pid && _negCache.val) return _negCache.val
  _negCache = { pid, val: await readDefaultNegative() }
  return _negCache.val
}
// 🔴 档案 → 提示词的提示词全部来自项目 prompts/：promptgen.md 承载任务身份与 JSON 输出契约，
//    profile.md + chars.md / scenes.md 承载写法规范（见 composeSystem 的 specs），代码不再硬编码

/** 解析「档案 → 提示词」输出（容错，与 StageChars 同款） */
function parsePcOut(text) {
  const raw = String(text || '')
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = m ? m[1] : raw
  const s = body.search(/[{[]/)
  if (s < 0) return { prompt: raw.trim(), negative: '' }
  const e = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  try {
    const o = JSON.parse(body.slice(s, e > s ? e + 1 : undefined))
    if (typeof o === 'string') return { prompt: o.trim(), negative: '' }
    return { prompt: String(o.prompt || o.positive || '').trim(), negative: String(o.negative || '').trim() }
  } catch (_) { return { prompt: raw.trim(), negative: '' } }
}

export default {
  name: 'StageLibrary',
  data() {
    return {
      busy: false, pgBusy: false, _b64: {}, _dims: {}, _genAt: 0, genMs: 0, refAsBase: false,
      usage: [], askRename: null, askAdd: null, _usageFor: ''
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    targetId() { return (this.st.libTarget && this.st.libTarget.id) || '' },
    projectId() { return (this.st.libTarget && this.st.libTarget.projectId) || null },
    entries() { return this.st.libEntries(this.projectId) },
    entry() { return this.entries.find(e => e.id === this.targetId) || null },
    groups() {
      return [
        { kind: 'character', label: '角色', items: this.entries.filter(e => e.kind !== 'scene') },
        { kind: 'scene', label: '场景', items: this.entries.filter(e => e.kind === 'scene') }
      ]
    },
    selFile() { return this.entry && this.entry.cur >= 0 ? (this.entry.images[this.entry.cur] || null) : null },
    shown() {
      const e = this.entry
      return e ? e.images.map((f, i) => ({ f, i })).slice(-SHOW_MAX) : []
    },
    resNow() { return (this.entry && this.entry.res) || '1216x832' },
    opts() { return optsWith((this.st.resOptions || {}).img, this.resNow) },
    dim() {
      const f = this.selFile
      return f ? (this._dims[this.absOf(f)] || '') : ''
    },
    genText() {
      void this.pl.tick   // 依赖每秒自增的 tick，生成中「已用 X」实时刷新
      if (this._genAt) return '生成中 已用 ' + fmtMs(Date.now() - this._genAt)
      return this.genMs ? '耗时 ' + fmtMs(this.genMs) : ''
    }
  },
  watch: {
    targetId: { immediate: true, handler() { this.loadUsage() } }
  },
  methods: {
    resLabel,
    usageText(u) {
      return (u || []).map(x => x.epName + (x.shots.length
        ? ' 镜' + x.shots.slice(0, 6).map(i => i + 1).join('/') + (x.shots.length > 6 ? '…' : '')
        : ' 档案卡')).join('、')
    },
    absOf(f) { return joinPath(this.entry && this.entry.dir, f) },
    imgSrc(abs) {
      if (!abs) return ''
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''
      window.studio.readFileBase64(abs).then(b => {
        if (b) {
          this._b64[abs] = 'data:image/png;base64,' + b
          const im = new Image()
          im.onload = () => { this._dims[abs] = im.naturalWidth + '×' + im.naturalHeight }
          im.src = this._b64[abs]
        } else delete this._b64[abs]
      })
      return ''
    },
    async open(e) {
      this.st.libTarget = { projectId: this.projectId, id: e.id }
    },
    async loadUsage() {
      const pid = this.projectId, id = this.targetId
      if (!pid || !id) { this.usage = []; return }
      const key = pid + '#' + id
      if (this._usageFor === key && this.usage.length) return
      this._usageFor = key
      this.usage = await this.st.libraryUsage(pid, id)
    },
    /** 逐字段保存（change 时触发）：库版本 +1，引用它的集下次打开会亮黄标 */
    async saveField(k, v) {
      const pid = this.projectId, e = this.entry
      if (!pid || !e) return
      const payload = { updateId: e.id }
      payload[k] = v
      try { await this.st.saveLibrary(pid, payload) }
      catch (err) { this.st.fail(err) }
    },
    pick(i) {
      const e = this.entry
      if (!e) return
      if (e.cur === i) { e.cur = -1; this.refAsBase = false } else { e.cur = i; this.refAsBase = true }
      this.saveField('cur', e.cur)
    },
    previewImg() {
      const f = this.selFile
      if (!f) return
      this.$root.openPreview({ file: f, path: this.absOf(f) }, 'image', this.entry.name)
    },
    async doAdd() {
      const a = this.askAdd
      const pid = this.projectId
      if (!a || !pid) return
      const name = String(a.name || '').trim()
      if (!name) return
      this.askAdd = null
      try {
        const r = await this.st.addLibrary(pid, a.kind, name)
        if (r && r.entry) {
          if (r.renamed) this.$root.toast('已有同名条目，已存为「' + r.entry.name + '」')
          this.st.libTarget = { projectId: pid, id: r.entry.id }
        }
      } catch (e) { this.st.fail(e) }
    },
    async doRename() {
      const a = this.askRename
      const pid = this.projectId, e = this.entry
      if (!a || !pid || !e) return
      const nm = String(a.name || '').trim()
      if (!nm || nm === e.name) { this.askRename = null; return }
      this.askRename = null
      const L = stepLog(TAG)
      try {
        const r = await this.st.renameLibrary(pid, e.id, nm)
        const touched = (r && r.touched) || []
        this.st.libTarget = { projectId: pid, id: r && r.entry ? r.entry.id : e.id }
        this.$root.toast('已改名为「' + nm + '」' +
          (touched.length ? '；已同步 ' + touched.length + ' 个集里的引用' : '；暂无集引用它'))
        L.done('改名：' + e.name + ' → ' + nm + (touched.length ? '（影响 ' + touched.length + ' 个集）' : ''))
      } catch (err) { L.fail('改名失败', null, err); this.st.fail(err) }
    },
    /** 按档案重算正负提示词 */
    async genPrompt() {
      const pid = this.projectId, e = this.entry
      if (!pid || !e) return
      if (!String(e.profile || '').trim()) { this.$root.toast('先填档案，再刷新提示词'); return }
      const isScene = e.kind === 'scene'
      this.busy = true; this.pgBusy = true
      const L = stepLog(TAG)
      L.start('正在按档案生成' + (isScene ? '场景' : '角色') + '提示词：' + e.name)
      try {
        const system = await composeSystem({
          specs: ['promptgen.md', 'profile.md', isScene ? 'scenes.md' : 'chars.md'],
          mustHave: ['"prompt"', '"negative"']
        })
        // user 消息的文案同样来自规范 md（promptgen.md 的「## 素材格式」），这里只提供素材本身
        const user = await composeUser('promptgen.md', {
          kind: isScene ? '场景' : '角色', profile: e.profile, others: '', name: e.name
        })
        const text = await window.studio.llmChat([
          { role: 'system', content: system }, { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 1024, json: true, label: TAG })
        const out = parsePcOut(text)
        if (!out.prompt) throw new Error('LLM 未返回正向提示词')
        await this.st.saveLibrary(pid, {
          updateId: e.id, prompt: out.prompt,
          negative: out.negative || e.negative || await negDefault()
        })
        L.done('提示词已更新：' + e.name)
        this.$root.toast('「' + e.name + '」提示词已更新')
      } catch (err) { L.fail('生成提示词失败', null, err); this.st.fail(err) }
      finally { this.busy = false; this.pgBusy = false }
    },
    /** 出图：写进该条目的图片目录（永不覆盖，追加） */
    async gen() {
      const pid = this.projectId, e = this.entry
      if (!pid || !e) return
      const fromRef = !!this.refAsBase && e.cur >= 0
      const [rw, rh] = parseRes(this.resNow)
      this.busy = true; this._genAt = Date.now()
      const t0 = Date.now()
      const L = stepLog(TAG)
      L.start('正在生成' + (e.kind === 'scene' ? '场景图' : '角色图') + '：' + e.name +
        '（' + rw + 'x' + rh + ' · ' + resLabel(this.opts, this.resNow) +
        (fromRef ? ' · 图生图，参考：' + e.images[e.cur] : ' · 文生图') + '）')
      try {
        // 发送前剥掉命中器材词的短语（scenes.md「器材词:」行；老提示词里的「单反相机拍摄」防器材被画进画面）
        const positive = stripEquipmentWords(e.prompt, await readEquipmentWords())
        const r = await window.studio.comfyGenerate({
          templateKey: 'character', dir: e.dir, baseName: e.name,
          params: {
            prompt: positive, negative: e.negative || await negDefault(), width: rw, height: rh,
            ...(fromRef ? { image: this.absOf(e.images[e.cur]) } : {})
          },
          label: TAG
        })
        this.genMs = Date.now() - t0
        await this.st.loadLibrary(pid, true)
        const e2 = this.entries.find(x => x.id === e.id)
        if (e2) {
          const idx = e2.images.indexOf(r.files[r.files.length - 1])
          await this.st.saveLibrary(pid, { updateId: e.id, cur: idx >= 0 ? idx : e2.images.length - 1 })
        }
        this.refAsBase = false
        L.done('出图完成：' + r.files.join('、'), this.genMs)
        this.$root.toast(e.name + ' 已生成：' + r.files.join('、'))
      } catch (err) { L.fail('出图失败', null, err); this.st.fail(err) }
      finally { this._genAt = 0; this.busy = false }
    }
  }
}
</script>
