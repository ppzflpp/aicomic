<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>

    <div class="grp">
      <!-- 空库引导：不能只靠「没有卡就不渲染网格」——新增入口（虚线卡）在网格里，
           空库时把它一起藏掉就再也建不出条目了（树节点进来 → 空白页 → 死锁） -->
      <div v-if="!entries.length" class="hint" style="margin:0 0 12px">
        库里还没有条目。在某一集的「角色 &amp; 场景」里点「保存到项目」把本集角色存进来，或点下面的「新增角色 / 新增场景」手动建。
      </div>

      <!-- 与「角色 & 场景」同款网格：角色在前、场景在后，末尾常驻虚线新增卡；
           卡片左右结构（左：大图 + 角标 + 被引用 + 档案 / 右：提示词 → 抽卡 → 参数 → 生图） -->
      <div class="char-grid">
        <div v-for="e in ordered" :key="e.id" class="ccard"
             :class="[e.kind, { 'card-busy': genIng(e), 'lib-hit': e.id === targetId }]"
             :data-eid="e.id">
          <span v-if="genIng(e)" class="busy-txt"><i class="spin"></i>正在生成…</span>

          <!-- 左：大预览图 + 图上角标（名称、分辨率）。
               定位（role）与库版本号不再上角标：库里所有角色都是同一档定位、库版本对使用者没有决策价值 -->
          <div class="cleft">
            <div class="bigprev">
              <img v-if="selFileOf(e)" :src="imgSrc(absOf(e, selFileOf(e)))"
                   :title="'点击放大预览（' + e.name + '）'" @click="previewImg(e)" />
              <div v-else class="ph">{{ e.name[0] }}</div>
              <div class="kind-wrap">
                <span class="kind-tag-pos" :class="e.kind">{{ e.name }}</span>
              </div>
              <span v-if="dimOf(e)" class="dim-tag" title="当前预览图片的实际分辨率">{{ dimOf(e) }}</span>
            </div>

            <!-- 被引用范围：库条目只有被某一集的镜头写进「本集有谁」后才会参与生成；
                 没有任何引用 = 黄标提示（做了也不会有人用），有引用则列出集与镜 -->
            <div v-if="usageOf(e).length" class="lib-use" :title="usageTip(e)">
              <span class="lu-t">被引用</span>
              <span class="lu-v">{{ usageText(usageOf(e)) }}</span>
              <span v-if="e.from && e.from.epName" class="lu-from">首次入库 {{ e.from.epName }}</span>
            </div>
            <div v-else class="lib-stale">
              <span class="ls-txt" title="在本集「角色 & 场景」里用「写入镜头」把这张卡写进镜头的「本集有谁」，生成时才会被挂成参考图">⚠ 暂未被任何集引用</span>
            </div>

            <!-- 档案（提示词的唯一依据，可手改）→ 脏标记 → 点右侧刷新图标按新档案重算 -->
            <div class="f pf-box">
              <div class="pf-head">
                <label>{{ e.kind === 'scene' ? '场景档案' : '角色档案' }}</label>
                <span style="flex:1"></span>
                <span v-if="dirtyOf(e)" class="stale" title="档案改动后提示词还没重算；点这里先消除提示"
                      @click="ackProfile(e)">档案已改 · 提示词待更新</span>
              </div>
              <textarea v-model="e.profile" :rows="e.kind === 'scene' ? 5 : 7"
                        placeholder="档案：每行一个字段「字段名：值」…（改完点右侧「刷新提示词」重算）"
                        @change="touchProfile(e)"></textarea>
            </div>
          </div>

          <!-- 右：正向/负向提示词 → 抽卡记录 → 分辨率 → 生图（固定右下角） -->
          <div class="cright">
            <div class="f ta-prompt">
              <div class="ta-head">
                <label>正向提示词</label>
                <span style="flex:1"></span>
                <!-- 删除整条库条目（位置与剧集卡的「删卡 ✕」一致：刷新图标左边）：
                     点击后弹框二选一 —— 仅删除显示（图片留盘）/ 删除所有文件（连图片目录一起删） -->
                <button class="del-btn head-x" :disabled="busy"
                        title="删除这个库条目：可选「仅删除显示」或「删除所有文件」（连同项目 assets 下的图片目录）"
                        @click="askDelEntry(e)">✕</button>
                <button class="btn icon" :class="{ regen: dirtyOf(e) }"
                        :disabled="busy || !String(e.profile || '').trim()"
                        title="刷新提示词（按本条档案重新生成正向 / 负向提示词，会覆盖当前提示词，之后仍可手改）"
                        @click="genPrompt(e)">
                  <span v-if="e._pgGen" class="busy-txt"><i class="spin"></i></span>
                  <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
                  </svg>
                </button>
              </div>
              <textarea v-model="e.prompt" rows="5" placeholder="正向提示词"
                        @change="saveField(e, 'prompt', e.prompt)"></textarea>
            </div>
            <div class="f ta-neg"><label>负向提示词</label>
              <textarea v-model="e.negative" rows="3" placeholder="负向提示词"
                        @change="saveField(e, 'negative', e.negative)"></textarea>
            </div>

            <div class="f"><label>抽卡记录 <span class="hint" style="font-size:10px">点击选中为图生图底图</span></label>
              <div class="thumbs" v-if="e.images.length">
                <div v-for="t in shown(e)" :key="t.i" class="thumb-wrap">
                  <img :src="imgSrc(absOf(e, t.f))" :class="{ cur: t.i === e.cur }"
                       title="点击选中／再点一次取消选中" @click="pick(e, t.i)" />
                </div>
              </div>
              <div v-else class="hint" style="font-size:11px">尚未出图</div>
            </div>

            <label class="card-res">分辨率
              <select v-model="e.res" :disabled="busy" @change="saveField(e, 'res', e.res)">
                <option v-for="o in optsFor(e)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>

            <div class="ops-row">
              <span v-if="genText(e)" class="gen-ms" :class="{ live: genIng(e) }">{{ genText(e) }}</span>
              <button class="btn sm" :class="{ regen: e.refAsBase && e.cur >= 0 }" :disabled="busy" @click="gen(e)">
                {{ e.refAsBase && e.cur >= 0 ? '图生图' : '文生图' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 新增入口：与剧集块同款虚线卡（不带 + / 图标、无底色，两个纯文字按钮） -->
        <div class="add-tile" title="手动新增角色 / 场景条目">
          <div class="add-tile-btns">
            <button class="tile-link" :disabled="busy" @click="askAdd = { kind: 'character', name: '', err: '', busy: false }">新增角色</button>
            <button class="tile-link" :disabled="busy" @click="askAdd = { kind: 'scene', name: '', err: '', busy: false }">新增场景</button>
          </div>
        </div>
      </div>
    </div>

    <div class="ops-bar">
      <span class="hint">库是全项目共享的：这里的改动会影响引用它的所有集；图片保存在 项目/assets 下（永不覆盖，可无限重生成）</span>
    </div>

    <!-- 条目数胶囊 + 批量按钮：Teleport 到库视图标题行（App.vue 的 #lib-count / #lib-batch）。
         🔴 Teleport 延迟挂载：切视图时组件整棵重建，mounted 前落点不在文档里 → 必须 nextTick 后再渲染（tpReady），
         否则内容被静默丢弃。空闲 = 「批量生成提示词 / 批量生成图片」；跑动中 = 「停止批量」；已请求停止 = 「停止中…」 -->
    <Teleport v-if="tpReady" to="#lib-count">
      <span class="head-ms" title="库条目：角色 / 场景">共 {{ entries.length }} 个 · 🧑 {{ nChar }} / 🏞 {{ nScene }}</span>
    </Teleport>
    <Teleport v-if="tpReady" to="#lib-batch">
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && entries.some(e => String(e.profile || '').trim()), danger: batchP || batchPStop }"
              :disabled="batchPStop || batchI || !entries.length"
              :title="batchP ? '点击停止：当前条目跑完后，剩余条目不再执行' : '按档案批量重新生成库里所有条目的提示词，或只处理档案有变动 / 还没有提示词的条目'"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchI && !batchIStop && entries.some(e => e.images.length), danger: batchI || batchIStop }"
              :disabled="batchIStop || batchP || !entries.length"
              :title="batchI ? '点击停止：当前条目跑完后，剩余条目不再执行' : '依次生成库里所有还没有图的条目（已有图的跳过）'"
              @click="batchImages">
        <span v-if="batchIStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchI">停止批量({{ batchIN }}/{{ batchITotal }})</span>
        <span v-else>批量生成图片</span>
      </button>
    </Teleport>

    <!-- 手动新增库条目：重名直接拦下（名字是唯一键，重名必须由人改名，不自动加后缀） -->
    <div v-if="askAdd" class="modal-mask" @click.self="askAdd = null">
      <div class="modal">
        <div class="modal-title">新增库{{ askAdd.kind === 'scene' ? '场景' : '角色' }}</div>
        <div class="modal-note">
          名字即图片目录名与全项目唯一键。新增后档案 / 提示词留空，需自己补；补完点「刷新提示词」再出图。
        </div>
        <input type="text" v-model="askAdd.name" placeholder="例如：张伯 / 李白-老年"
               @input="askAdd.err = ''" @keyup.enter="doAdd" style="margin:8px 0" />
        <div v-if="askAdd.err" class="modal-err">{{ askAdd.err }}</div>
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askAdd = null">取消</button>
          <button class="btn" :disabled="!String(askAdd.name || '').trim() || askAdd.busy" @click="doAdd">
            <span v-if="askAdd.busy" class="busy-txt"><i class="spin"></i></span>
            <span v-else>新增</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 删除库条目：二选一 —— 仅删除显示（移出库，图片留盘）/ 删除所有文件（连图片目录一起删，不可恢复） -->
    <div v-if="askDel" class="modal-mask" @click.self="askDel = null">
      <div class="modal">
        <div class="modal-title">删除库{{ askDel.kind === 'scene' ? '场景' : '角色' }}？</div>
        <div class="modal-body mono">{{ askDel.name }}</div>
        <div class="modal-note">
          <div>· <b>仅删除显示</b> —— 从库里移除这一条，图片文件<b>保留</b>在 项目/assets/{{ askDel.kind === 'scene' ? 'scenes' : 'characters' }}/{{ askDel.name }}/ 下，
            以后重新入库还能复用这些图。</div>
          <div style="margin-top:6px">· <b>删除所有文件</b> —— 连同上面那个图片目录<b>一起删掉（不可恢复）</b>，
            共 {{ askDel.nImg }} 张图。要清磁盘、不再需要这个人物时选它。</div>
          <div v-if="askDel.used.length" style="margin-top:6px;color:#fcd34d">
            ⚠ 被 <b>{{ askDel.used.length }}</b> 个集引用：{{ usageText(askDel.used) }}。
            删除后这些集里的卡片与分镜仍然保留这个名字，但不再关联库档案 / 库图片。
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDelEntry(true)">删除所有文件</button>
          <button class="btn ghost" @click="doDelEntry(false)">仅删除显示</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askDel = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 批量生成弹框：提示词 / 图片 二选一范围（与「角色 & 场景」同款） -->
    <div v-if="askBatch" class="modal-mask" @click.self="askBatch = null">
      <div class="modal">
        <template v-if="askBatch.kind === 'prompts'">
          <div class="modal-title">批量生成提示词</div>
          <div class="modal-note">
            <div><b>全部重新生成</b> —— 库里所有条目都按各自档案重算提示词，<b>覆盖现有提示词（含手改过的）</b>。</div>
            <div style="margin-top:6px"><b>只生成需更新的</b> —— 仅处理「档案已改但提示词没重算」和「还没有提示词」的条目，其余不动。</div>
          </div>
          <div class="modal-ops">
            <button class="btn" @click="askBatchAll">全部重新生成</button>
            <button class="btn" @click="askBatchMissing">只生成需更新的</button>
            <button class="btn ghost" @click="askBatch = null">取消</button>
          </div>
        </template>
        <template v-else>
          <div class="modal-title">批量生成图片</div>
          <div class="modal-note">
            <div><b>只补还没有图的</b> —— 仅给还没有图片的条目出图；已有图的全部跳过（想重出某一张，用该卡片右下角的「生图 / 图生图」按钮）。</div>
            <div style="margin-top:6px"><b>全部重新生成</b> —— 所有条目都重新出一张图，完成后<b>自动选中新版本</b>（旧版本保留，可随时切回）。</div>
            <div style="margin-top:6px">当前共 {{ askBatch.total }} 个条目：已有图 <b>{{ askBatch.have }}</b> 个、还没有图 <b>{{ askBatch.miss }}</b> 个。</div>
          </div>
          <div class="modal-ops">
            <button class="btn" @click="askBatchImgMissing">只补还没有图的</button>
            <button class="btn" @click="batchImagesAll">全部重新生成</button>
            <button class="btn ghost" @click="askBatch = null">取消</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog, secs } from './ulog.js'
import { parseRes, resLabel, optsWith, joinPath } from './resutil.js'
import {
  composeSystem, composeUser, readDefaultNegative, readEquipmentWords, readSceneKeeper,
  stripEquipmentWords, ensureSceneKeeper
} from './prompts.js'

const SHOW_MAX = 4   // 抽卡区最多渲染最新几张（与「角色 & 场景」一致；磁盘与条目记录不受影响）
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

/** 剥掉 IPC 抛错时的包装前缀（"Error invoking remote method 'library:add': Error: xxx"），只留人话 */
function cleanErr(e) {
  const m = String((e && e.message) || e || '').trim()
  const i = m.lastIndexOf('Error: ')
  return (i >= 0 ? m.slice(i + 7) : m).trim() || '操作失败'
}

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
      busy: false, _b64: {}, _dims: {}, askDel: null, askAdd: null, askBatch: null,
      // 「档案已改 · 提示词待更新」的脏标记：按条目 id 存在组件本地，不放 entry 上——
      // 出图后会重拉整库（entries 重建），放 entry 上的前端态会一起丢
      _dirty: {},
      // 生成中的起点 / 上次耗时：同样按 id 存本地（出图成功就重拉整库，挂 entry 上会被重建抹掉）
      _gen: {}, _genMs: {},
      // 批量任务：batch*=队列在跑；*Stop=已点停止等当前条目收尾；*N/Total=按钮进度
      batchP: false, batchPStop: false, batchPN: 0, batchPTotal: 0,
      batchI: false, batchIStop: false, batchIN: 0, batchITotal: 0,
      _keeper: '',      // 场景图的空镜必备句（取自 scenes.md，异步读）
      _alive: true,     // 组件是否还在（切走视图后异步批量循环据此收尾）
      tpReady: false    // Teleport 延迟挂载开关
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    /** 当前生图方案是否支持图生图（不支持时点缩略图只预览、不当底图） */
    capsI2i() { const c = this.st.caps && this.st.caps.image; return !c || c.i2i !== false },
    targetId() { return (this.st.libTarget && this.st.libTarget.id) || '' },
    projectId() { return (this.st.libTarget && this.st.libTarget.projectId) || null },
    entries() { return this.st.libEntries(this.projectId) },
    /** 角色在前、场景在后（与「角色 & 场景」网格同序） */
    ordered() {
      const es = this.entries
      return [...es.filter(e => e.kind !== 'scene'), ...es.filter(e => e.kind === 'scene')]
    },
    nChar() { return this.entries.filter(e => e.kind !== 'scene').length },
    nScene() { return this.entries.filter(e => e.kind === 'scene').length }
  },
  watch: {
    projectId: {
      immediate: true,
      handler(pid) {
        if (!pid || !this._alive) return
        this.st.loadLibrary(pid)
        this.st.loadLibUsage(pid)
      }
    },
    // 左侧树点条目 → 滚到那张卡并短暂高亮（整页铺卡后，「打开某条目」= 定位而不是只显示它）
    targetId: { immediate: true, handler() { this.jumpTo() } }
  },
  mounted() {
    this.$nextTick(() => { this.tpReady = true; this.jumpTo() })
    readSceneKeeper().then(v => { this._keeper = v || '' }).catch(() => {})
  },
  beforeUnmount() { this._alive = false },
  methods: {
    resLabel,
    /* ---------- 展示辅助 ---------- */
    /** 库条目自带的绝对目录（服务端算好放在 entry.dir） */
    absOf(e, f) { return joinPath(e && e.dir, f) },
    selFileOf(e) { return e && e.cur >= 0 ? (e.images[e.cur] || null) : null },
    resOf(e) { return (e && e.res) || '1920x1080' },
    /** 档位按当前底模过滤；该条目已保存的值不在档位里时补进去（保证显示正确） */
    optsFor(e) { return optsWith((this.st.resOptions || {}).img, this.resOf(e)) },
    shown(e) { return (e.images || []).map((f, i) => ({ f, i })).slice(-SHOW_MAX) },
    dimOf(e) {
      const f = this.selFileOf(e)
      return f ? (this._dims[this.absOf(e, f)] || '') : ''
    },
    genText(e) {
      void this.pl.tick   // 依赖每秒自增的 tick，生成中「已用 X」实时刷新
      if (this.genIng(e)) return '生成中 已用 ' + fmtMs(Date.now() - this._gen[e.id])
      return this._genMs[e.id] ? '耗时 ' + fmtMs(this._genMs[e.id]) : ''
    },
    /** 该条目是否正在出图（前端态存组件本地，见 data 里的说明） */
    genIng(e) { return !!this._gen[e.id] },
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
    /* ---------- 引用信息（一次扫全库的快照） ---------- */
    /** 🔴 校验快照所属项目：换项目后异步回落期间，旧项目的 map 不能拿来显示新项目的条目 */
    usageOf(e) {
      const u = this.st.libUsage
      if (!u || u.projectId !== this.projectId) return []
      return (u.map || {})[e.id] || []
    },
    usageText(u) {
      return (u || []).map(x => x.epName + (x.shots.length
        ? ' 镜' + x.shots.slice(0, 6).map(i => i + 1).join('/') + (x.shots.length > 6 ? '…' : '')
        : ' 档案卡')).join('、')
    },
    usageTip(e) {
      const u = this.usageOf(e)
      if (!u.length) return ''
      return (u || []).map(x => x.epName + (x.shots.length
        ? '：镜 ' + x.shots.map(i => i + 1).join('、')
        : '：仅档案卡（没有镜头在用）')).join('\n')
    },
    /** 左侧树点条目 → 滚到该卡并高亮一下 */
    jumpTo() {
      const id = this.targetId
      if (!id) return
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('[data-eid="' + String(id).replace(/"/g, '\\"') + '"]')
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    },
    previewImg(e) {
      const f = this.selFileOf(e)
      if (!f) return
      this.$root.openPreview({ file: f, path: this.absOf(e, f) }, 'image', e.name)
    },
    /* ---------- 编辑 ---------- */
    dirtyOf(e) { return !!this._dirty[e.id] },
    ackProfile(e) { this._dirty[e.id] = false },
    touchProfile(e) {
      this._dirty[e.id] = true
      this.saveField(e, 'profile', e.profile)
    },
    /** 逐字段保存（change 时触发）：库版本 +1；**不重拉整库**（避免把还没提交的其它字段覆盖回旧值） */
    async saveField(e, k, v) {
      const pid = this.projectId
      if (!pid || !e) return
      const payload = { updateId: e.id }
      payload[k] = v
      try { await this.st.patchLibrary(pid, payload) }
      catch (err) { this.st.fail(err) }
    },
    pick(e, i) {
      if (!e) return
      // 当前生图方案声明不支持图生图时：点缩略图只当预览，不当底图
      if (e.cur === i) { e.cur = -1; e.refAsBase = false } else { e.cur = i; e.refAsBase = this.capsI2i }
      this.saveField(e, 'cur', e.cur)
    },
    /**
     * 手动新增条目：重名就地提示、不关弹窗（名字是唯一键 ── 图片目录、分镜「本集有谁」、对白锁人都按名字走，
     * 悄悄加「 (2)」会让人以为建的是另一个条目）。先本地查（即时），服务端再兜一次（多窗口 / 本地列表过期）。
     */
    async doAdd() {
      const a = this.askAdd
      const pid = this.projectId
      if (!a || !pid || a.busy) return
      const name = String(a.name || '').trim()
      const what = a.kind === 'scene' ? '场景' : '角色'
      if (!name) { a.err = '名字不能为空'; return }
      const dup = this.entries.find(e => e.kind === a.kind && (e.name === name || e.id === name))
      if (dup) { a.err = '已有同名' + what + '「' + dup.name + '」，请换一个名字'; return }
      a.err = ''; a.busy = true
      try {
        const r = await this.st.addLibrary(pid, a.kind, name)
        if (r && r.entry) {
          this.st.libTarget = { projectId: pid, id: r.entry.id }
          this.st.loadLibUsage(pid)
          this.askAdd = null
        }
      } catch (e) {
        a.err = cleanErr(e)
      } finally { a.busy = false }
    },
    /* ---------- 删除条目（二选一：仅移出库 / 连同图片目录一起删） ---------- */
    askDelEntry(e) {
      if (!e) return
      this.askDel = {
        id: e.id, name: e.name, kind: e.kind,
        nImg: (e.images || []).length,
        used: this.usageOf(e)
      }
    },
    /** @param delFiles true = 删除所有文件（连图片目录）；false = 仅删除显示（图片留盘，可重新入库复用） */
    async doDelEntry(delFiles) {
      const a = this.askDel
      const pid = this.projectId
      if (!a || !pid) return
      this.askDel = null
      const L = stepLog(TAG)
      this.busy = true
      try {
        const r = await this.st.removeLibrary(pid, a.id, delFiles)
        this.st.loadLibUsage(pid)
        // 高亮目标若指向被删条目，只清 id 不清项目（清空 projectId 会让整页失去数据源）
        if (this.st.libTarget && this.st.libTarget.id === a.id) {
          this.st.libTarget = { projectId: pid, id: '' }
        }
        const used = (r && r.usage) || a.used || []
        const how = delFiles
          ? '（连同图片目录一起删除' + (r && r.delErr ? '：' + r.delErr : '') + '）'
          : '（仅移出库，图片文件保留）'
        L.done('已删除库条目「' + a.name + '」' + how +
          (used.length ? '；它曾被 ' + used.length + ' 个集引用' : ''))
        this.$root.toast('已删除「' + a.name + '」' + (delFiles ? '，图片目录已删除' : '，图片文件保留在 assets 下'))
      } catch (e) {
        L.fail('删除库条目失败', null, e)
        this.st.fail(e)
      } finally { this.busy = false }
    },
    /* ---------- 生成 ---------- */
    /**
     * 按档案重算正负提示词。
     * @param ctx {n,total} 批量时的进度（只影响日志文案）；返回是否成功（批量循环据此统计）
     */
    async genPrompt(e, ctx) {
      const pid = this.projectId
      if (!pid || !e) return false
      if (!String(e.profile || '').trim()) { this.$root.toast('先填档案，再刷新提示词'); return false }
      const isScene = e.kind === 'scene'
      this.busy = true; e._pgGen = true
      const t0 = Date.now()
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在按档案生成' + (isScene ? '场景' : '角色') + '提示词：' + e.name + prog)
      try {
        const system = await composeSystem({
          specs: ['promptgen.md', 'profile.md', isScene ? 'scenes.md' : 'chars.md'],
          mustHave: ['"prompt"', '"negative"'],
          task: isScene ? 'scene' : 'char'
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
        await this.st.patchLibrary(pid, {
          updateId: e.id, prompt: out.prompt, promptMs: Date.now() - t0, promptAt: Date.now(),
          negative: out.negative || e.negative || await negDefault()
        })
        e.prompt = out.prompt
        if (out.negative) e.negative = out.negative
        else if (!e.negative) e.negative = await negDefault()
        this._dirty[e.id] = false     // 提示词已对齐当前档案 → 脏标记消失
        L.done((isScene ? '场景' : '角色') + '提示词「' + e.name + '」已更新' + prog, Date.now() - t0)
        if (!ctx) this.$root.toast('「' + e.name + '」提示词已更新')
        return true
      } catch (err) {
        L.fail('生成提示词失败' + prog, Date.now() - t0, err)
        this.st.fail(err)
        return false
      } finally { e._pgGen = false; this.busy = false }
    },
    /** 出图：写进该条目的图片目录（永不覆盖，追加）。返回是否成功（批量循环据此统计） */
    async gen(e, ctx) {
      const pid = this.projectId
      if (!pid || !e) return false
      const id = e.id
      const isScene = e.kind === 'scene'
      const what = isScene ? '场景图' : '角色图'
      const fromRef = !!e.refAsBase && e.cur >= 0
      const [rw, rh] = parseRes(this.resOf(e))
      this.busy = true; this._gen[id] = Date.now()
      const t0 = Date.now()
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在生成' + what + '：' + e.name + prog +
        '（' + rw + 'x' + rh + ' · ' + resLabel(this.optsFor(e), this.resOf(e)) +
        (fromRef ? ' · 图生图，参考：' + e.images[e.cur] : ' · 文生图') + '）')
      try {
        // 场景图强制空镜（与集内场景卡同一条链）：正向里缺空镜陈述时补上；发送前再剥掉命中器材词的短语
        const positive = stripEquipmentWords(isScene ? ensureSceneKeeper(e.prompt, this._keeper) : e.prompt,
          await readEquipmentWords())
        const r = await window.studio.comfyGenerate({
          templateKey: 'character', dir: e.dir, baseName: e.name,
          params: {
            prompt: positive, negative: e.negative || await negDefault(), width: rw, height: rh,
            ...(fromRef ? { image: this.absOf(e, e.images[e.cur]) } : {})
          },
          label: TAG
        })
        this._genMs[id] = Date.now() - t0
        // 出图后必须重拉：新图片文件只有 listLibrary 扫目录才知道（返回体只给文件名）
        await this.st.loadLibrary(pid, true)
        const e2 = this.entries.find(x => x.id === id)
        if (e2) {
          const idx = e2.images.indexOf(r.files[r.files.length - 1])
          await this.st.patchLibrary(pid, { updateId: id, cur: idx >= 0 ? idx : e2.images.length - 1 })
        }
        L.done('出图完成：' + r.files.join('、') + prog, Date.now() - t0)
        if (!ctx) this.$root.toast(e.name + ' 已生成：' + r.files.join('、'))
        return true
      } catch (err) {
        L.fail('出图失败' + prog, Date.now() - t0, err)
        this.st.fail(err)
        return false
      } finally { delete this._gen[id]; this.busy = false }
    },
    /* ---------- 批量（按钮挂在库视图标题行） ---------- */
    batchPrompts() {
      if (this.batchP) { this.batchPStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchI) { this.$root.toast('图片批量进行中，请先等它结束或停止'); return }
      if (!this.entries.length) { this.$root.toast('库里还没有条目'); return }
      this.askBatch = { kind: 'prompts' }
    },
    batchImages() {
      if (this.batchI) { this.batchIStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchP) { this.$root.toast('提示词批量进行中，请先等它结束或停止'); return }
      if (!this.entries.length) { this.$root.toast('库里还没有条目'); return }
      const have = this.entries.filter(e => e.images.length).length
      this.askBatch = { kind: 'images', have, miss: this.entries.length - have, total: this.entries.length }
    },
    askBatchAll() { this.askBatch = null; this.runBatchP(true) },
    askBatchMissing() { this.askBatch = null; this.runBatchP(false) },
    askBatchImgMissing() { this.askBatch = null; this.runBatchI(false) },
    batchImagesAll() { this.askBatch = null; this.runBatchI(true) },
    /**
     * 批量生成提示词：all=true 全部按档案重算并覆盖；false 只处理「档案已改未重算」+「还没有提示词」。
     * 逐个顺序执行，*Stop 置位后当前条目跑完即停（剩余丢弃），结束统一统计。
     * 🔴 全程按 id 定位条目：出图会重拉整库（entries 重建），持下标会指错人。
     */
    async runBatchP(all) {
      const L = stepLog(TAG)
      const ids = this.ordered.filter(e => {
        if (all) return !!String(e.profile || '').trim()
        return !String(e.prompt || '').trim() || this.dirtyOf(e)
      }).map(e => e.id)
      if (!ids.length) { this.$root.toast('没有需要生成提示词的条目'); return }
      this.askBatch = null
      this.batchP = true; this.batchPStop = false; this.busy = true
      this.batchPN = 0; this.batchPTotal = ids.length
      L.start('开始批量生成提示词（' + (all ? '全部按档案重算，覆盖已有' : '只处理档案有变动 / 还没有提示词的') + '）：待生成 ' +
        ids.length + ' 个（共 ' + this.entries.length + ' 个条目）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < ids.length; k++) {
          if (this.batchPStop || !this._alive) { stopped = true; break }
          const e = this.entries.find(x => x.id === ids[k])
          if (!e) continue
          this.batchPN = k + 1
          const okFlag = await this.genPrompt(e, { n: k + 1, total: ids.length })
          okFlag ? okN++ : badN++
        }
        const left = ids.length - okN - badN
        const sum = (stopped ? '批量生成提示词已停止' : '批量生成提示词结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各条目失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
        if (!badN) this.$root.toast(stopped ? '批量已停止（已完成部分保留）' : '全部提示词已生成')
      } finally {
        this.batchP = false; this.batchPStop = false; this.busy = false
        this.batchPN = 0; this.batchPTotal = 0
      }
    },
    /** 批量生成图片：all=false 只补还没有图的条目（已有图的跳过）；all=true 全部重出一张（完成自动选中新版） */
    async runBatchI(all) {
      const L = stepLog(TAG)
      const ids = this.ordered.filter(e => all || !e.images.length).map(e => e.id)
      if (!ids.length) { this.$root.toast('没有需要生成的条目'); return }
      this.askBatch = null
      this.batchI = true; this.batchIStop = false; this.busy = true
      this.batchIN = 0; this.batchITotal = ids.length
      L.start('开始批量生成图片（' + (all ? '全部重新生成，完成后自动选中新版本' : '只补还没有图的，跳过已有图') + '）：待生成 ' +
        ids.length + ' 个（共 ' + this.entries.length + ' 个条目）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < ids.length; k++) {
          if (this.batchIStop || !this._alive) { stopped = true; break }
          const e = this.entries.find(x => x.id === ids[k])
          if (!e) continue
          this.batchIN = k + 1
          const okFlag = await this.gen(e, { n: k + 1, total: ids.length })
          okFlag ? okN++ : badN++
        }
        const left = ids.length - okN - badN
        const sum = (stopped ? '批量生成图片已停止' : '批量生成图片结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各条目失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchI = false; this.batchIStop = false; this.busy = false
        this.batchIN = 0; this.batchITotal = 0
      }
    }
  }
}
</script>
