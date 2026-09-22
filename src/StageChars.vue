<template>
  <div>
    <div v-if="busy || shotsGening" class="progress"><div class="bar indeterminate"></div></div>
    <div v-if="!busy && !shotsGening && !cards.length" class="placeholder">确认分镜后，从分镜中自动提取角色与场景（含各自的档案与美术提示词）。</div>

    <!-- 单一网格：先摆角色、再摆场景；卡片左右结构（左大图 / 右档案 → 提示词 → 参数），无锁定随时可编辑
         脏标签（改编稿改过 → 建议重新出图）统一显示在本模块标题后面，见 App.vue 的 stage-head -->
    <div v-if="cards.length" class="grp">
      <div class="grp-head">
        <b>角色 &amp; 场景</b>
      </div>

      <div class="char-grid">
        <div v-for="it in ordered" :key="it.c.kind + '|' + it.c.name" class="ccard"
             :class="[it.c.kind, { 'card-busy': it.c._gen }]">
          <span v-if="it.c._gen" class="busy-txt"><i class="spin"></i>正在生成…</span>

          <!-- 左：大预览图（按原图比例完整显示）+ 类型标签 + 名称 -->
          <div class="cleft">
            <div class="bigprev">
              <img v-if="selFile(it.c)" :src="imgSrc(absOf(it.c, selFile(it.c)))" />
              <div v-else class="ph">{{ it.c.name[0] }}</div>
              <span class="kind-tag-pos" :class="it.c.kind">{{ it.c.kind === 'scene' ? '场景' : '角色' }}</span>
              <span v-if="dimOf(it.c)" class="dim-tag" title="当前预览图片的实际分辨率">{{ dimOf(it.c) }}</span>
            </div>
            <div class="char-name">
              {{ it.c.name }}
              <span v-if="it.c.kind !== 'scene'" class="role-tag">{{ it.c.role }}</span>
              <span v-if="genText(it.c)" class="gen-ms" :class="{ live: it.c._genAt }">{{ genText(it.c) }}</span>
            </div>
          </div>

          <!-- 右：档案（提示词的依据）→ 正向/负向提示词 → 小预览图 → 分辨率 → 生图按钮（固定右下角）
               链路：档案 → 生成提示词 → 生图；三级都随时可编辑 -->
          <div class="cright">
            <div class="f pf-box">
              <div class="pf-head">
                <label>{{ it.c.kind === 'scene' ? '场景档案' : '角色档案' }}
                  <span class="hint" style="font-size:10px">提示词的依据，可手改</span>
                </label>
                <span v-if="pgText(it.c)" class="hint pg-ms" :class="{ live: it.c._pgAt }">{{ pgText(it.c) }}</span>
                <span style="flex:1"></span>
                <span v-if="profStale(it.c)" class="stale" title="档案改动后提示词还没重算；点这里先消除提示"
                      @click="ackProfile(it.i)">档案已改 · 提示词待更新</span>
                <button class="btn sm" :class="{ regen: it.c._profRevAt > 0 }"
                        :disabled="busy || !String(it.c.profile || '').trim()"
                        title="按本卡的档案重新生成正向 / 负向提示词（会覆盖当前提示词，之后仍可手改）"
                        @click="genPromptFromProfile(it.i)">
                  <span v-if="it.c._pgGen" class="busy-txt"><i class="spin"></i>生成中…</span>
                  <span v-else>生成提示词</span>
                </button>
              </div>
              <textarea v-model="it.c.profile" :rows="it.c.kind === 'scene' ? 5 : 7"
                        placeholder="档案：每行一个字段「字段名：值」（来自剧本提取，可手工修改）…"
                        @change="touchProfile(it.c)"></textarea>
            </div>

            <div class="f ta-prompt"><label>正向提示词<span v-if="it.c.kind === 'scene'" class="hint" style="font-size:10px">场景生成时自动补空镜句（画面不留人物）</span></label>
              <textarea v-model="it.c.prompt" rows="5"
                        :placeholder="it.c.kind === 'scene' ? '场景提示词（空间/光线/陈设/氛围）…' : '人物提示词（外貌/服装/气质）…'"
                        @change="saveAll()"></textarea></div>
            <div class="f ta-neg"><label>负向提示词 <span class="hint" style="font-size:10px">Turbo 类模型（cfg=1）下不参与采样，保留备用</span></label>
              <textarea v-model="it.c.negative" rows="3" placeholder="不希望出现的元素（动漫、插画、低画质、水印…）"
                        @change="saveAll()"></textarea></div>

            <!-- 小预览图（抽卡记录，最多显示最新 4 张；点击选中作图生图底图，✕ 删除） -->
            <div class="f"><label>小预览图 <span class="hint" style="font-size:10px">点击选中为图生图底图</span></label>
              <div class="thumbs" v-if="it.c.candidates.length">
                <div v-for="t in shown(it.c)" :key="t.i" class="thumb-wrap">
                  <img :src="imgSrc(absOf(it.c, t.f))" :class="{ cur: t.i === it.c.cur }"
                       title="点击选中／再点一次取消选中" @click="pick(it.c, t.i)" />
                  <button class="img-x" title="删除这张图" @click.stop="askDel(it.c, t.i)">✕</button>
                </div>
              </div>
              <div v-else class="hint" style="font-size:11px">尚未出图</div>
            </div>

            <label class="card-res">分辨率
              <select v-model="it.c.res" :disabled="busy" @change="saveAll()">
                <option v-for="o in optsFor(it.c)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>

            <!-- 一键填充：把当前选中的这张图，填到所有包含该角色 / 该场景的镜头的参考图区 -->
            <div class="cops fill-row">
              <button class="btn ghost sm" :disabled="busy || !selFile(it.c)"
                      :title="'把当前选中的这张图填到所有包含「' + it.c.name + '」的镜头的参考图区（只填参考图，不动首尾帧）'"
                      @click="fillRefs(it.i)">
                一键填充
              </button>
            </div>

            <div class="ops-row">
              <button class="btn sm" :class="{ regen: it.c.refAsBase && it.c.cur >= 0 }" :disabled="busy" @click="gen(it.i)">
                {{ it.c.refAsBase && it.c.cur >= 0 ? '图生图' : '生图' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作条：提示文字靠左，按钮统一靠右（「批量生成图片 / 批量生成提示词」已上移到模块标题行，见 App.vue 的 #chars-batch） -->
    <div class="ops-bar">
      <span class="hint">角色图与场景图都保存到项目 assets 下（永不覆盖，可无限重生成）</span>
      <span style="flex:1"></span>
      <button class="btn" :disabled="!cards.length" @click="confirm">下一步</button>
    </div>

    <!-- 删除单张图：永久删除（物理删盘）/ 删除显示（仅移出列表） -->
    <div v-if="ask" class="modal-mask" @click.self="ask = null">
      <div class="modal">
        <div class="modal-title">删除这张{{ ask.c.kind === 'scene' ? '场景图' : '角色图' }}？</div>
        <div class="modal-body mono">{{ ask.c.name }} / {{ ask.f }}</div>
        <div class="modal-note">
          <b>永久删除</b>：从磁盘物理删除，无法恢复。<br>
          <b>删除显示</b>：只是不再在这里列出，磁盘文件仍保留在 项目/assets/{{ ask.c.kind === 'scene' ? 'scenes' : 'characters' }}/ 下。
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDel(true)">永久删除</button>
          <button class="btn ghost" @click="doDel(false)">删除显示</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="ask = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 批量生成提示词：范围二选一（全部重算 / 仅档案有变动的），可随时停止 -->
    <div v-if="askBatch" class="modal-mask" @click.self="askBatch = null">
      <div class="modal">
        <div class="modal-title">批量生成提示词</div>
        <div class="modal-note">
          <div><b>全部重新生成</b> —— 所有角色与场景都按各自档案重算提示词，<b>覆盖现有提示词（含手改过的）</b>。</div>
          <div style="margin-top:6px"><b>只生成需更新的</b> —— 仅处理「档案已改但提示词没重算」和「还没有提示词」的条目，其余不动。</div>
          <div style="margin-top:6px">生成过程会同时把同类其它档案下发给模型，保证新提示词与已有角色在至少 3 个维度上不撞。</div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="askBatchAll">全部重新生成</button>
          <button class="btn" @click="askBatchMissing">只生成需更新的</button>
          <button class="btn ghost" @click="askBatch = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 批量按钮：Teleport 到块 2 标题行（App.vue 的 #chars-batch），与块 3 的批量按钮同构 -->
    <Teleport v-if="tpReady" to="#chars-batch">
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && cards.some(c => String(c.profile || '').trim()), danger: batchP || batchPStop }"
              :disabled="batchPStop || batchI"
              :title="batchP ? '点击停止：当前条目跑完后，剩余条目不再执行' : '按档案批量重新生成提示词，或只处理档案有变动 / 还没有提示词的条目'"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchI && !batchIStop && cards.some(c => c.candidates.length), danger: batchI || batchIStop }"
              :disabled="batchIStop || batchP"
              :title="batchI ? '点击停止：当前条目跑完后，剩余条目不再执行' : '依次生成所有还没有图的角色图与场景图（已有图的跳过）'"
              @click="batchImages">
        <span v-if="batchIStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchI">停止批量({{ batchIN }}/{{ batchITotal }})</span>
        <span v-else>批量生成图片</span>
      </button>
    </Teleport>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog, secs, dbgPrompt } from './ulog.js'
import { parseRes, ratioLabel, resLabel, optsWith, seg, joinPath } from './resutil.js'
import {
  readPrompt, parseFallbacks, pickFallback, section, ensureSceneKeeper, composeSystem,
  normalizeProfile, profileDirty, profileBrief
} from './prompts.js'

// 兜底负向提示词（仅当大模型没给 negative、旧档案也没有时用）：反动漫词表 + 通用质量负面词
const DEFAULT_NEG = '动漫，二次元，插画，绘画，3D，游戏CG，卡通，塑料感，低画质，模糊，画面文字，水印，手部畸形，肢体错误，五官崩坏'
// 空镜必备句兜底（scenes.md 的「空镜必备句」小节读不到时才用）：场景图必须空镜，不能出现人物
const SCENE_KEEPER_DEFAULT = '古装剧实景布景空镜，画面里空无一人，只有建筑、陈设与自然环境'
const SHOW_MAX = 4   // 抽卡区最多渲染最新几张（磁盘与 candidates 记录不受影响）
// 分镜行参考图上限（与 StageShots 的 MAX_REF_IMG 保持一致）：一键填充不允许把镜头填爆
const MAX_REF_IMG = 9
const EMPTY_REFS = () => ({ images: [], videos: [], first: null, last: null })
const TAG = '阶段4 角色&场景'

// ---- 档案 → 提示词（单卡「生成提示词」按钮与批量共用）----
const PC_IDENTITY = '你是古装真人实拍剧的美术设定师。任务：把一条档案（角色或场景的设定事实）翻译成一条中文生图提示词和一条中文负向提示词。'
const PC_CONTRACT = `只输出一个 JSON 对象，不要输出任何解释、注释或 Markdown 代码块：
{"prompt":"中文正向生图提示词","negative":"中文负向提示词"}
硬性约束：prompt 是逗号分隔的短语串（不要整句、不要换行），严格按规范里的固定顺序书写；prompt 不得写入档案里没有任何线索的关键设定；negative 必须包含反动漫词表（动漫、二次元、插画、绘画、3D、游戏CG、卡通、塑料感），不得与正向自相矛盾。`
const PC_FALLBACK = PC_IDENTITY + '\n' + PC_CONTRACT + `
规范文件读取失败，按内置要求写：角色按「摄影定调 → 年龄性别 → 脸型五官 → 皮肤纹理与真实发丝 → 服装款式材质颜色 → 神态 → 光线镜头 → 真人化收尾」顺序，收尾用「真人古装剧剧照，照片级真实」；场景按「摄影定调 → 空镜声明 → 室内外 → 空间结构 → 陈设 → 材质 → 光线 → 天气 → 真人化收尾」顺序，收尾用「古装剧实景布景照片，照片级真实」，且正向里必须含空镜陈述「画面里空无一人」、不得出现「剧照/演员/人像」与「无人物」这类写法。`

// 内置兜底模板：项目规范文件（chars.md / scenes.md）整体丢失且无法补齐时才用到（古风真人实拍）
const FALLBACK_TPL = {
  hero: '极其逼真的真人古装摄影作品，8K超高清，单反相机人像镜头拍摄，一名年轻男主角，五官立体，真实皮肤纹理与毛孔，发丝有真实质感，古风服饰，真实布料褶皱与光泽，全身像，简洁背景，柔和自然光，浅景深背景虚化，真人古装剧剧照，照片级真实，{name}',
  npc: '极其逼真的真人古装摄影作品，8K超高清，单反相机人像镜头拍摄，一名配角，五官清晰有辨识度，真实皮肤纹理，古风服饰，真实布料质感，全身像，简洁背景，自然光，浅景深背景虚化，真人古装剧剧照，照片级真实',
  scene: '极其逼真的古装剧实景照片，8K超高清，单反相机拍摄，古装剧实景布景空镜，画面里空无一人，只有建筑与环境陈设，真实材质纹理，黄昏黄金时刻光线，浅景深背景虚化，电影级调色，照片级真实，{name}'
}

/** 取 scenes.md「空镜必备句」小节里的那句话（跳过括号说明行 / 列表符号行） */
function pickKeeper(md) {
  const body = section(md, '空镜')
  if (!body) return ''
  for (const raw of String(body).split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln || /^[（(]/.test(ln) || /^[-*#>]/.test(ln)) continue
    return ln
  }
  return ''
}

/** 相对时间文案（「刚刚 / N 分钟前」；依赖每秒 tick 的调用方自己 void live） */
function agoText(ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
  return Math.floor(d / 86400000) + ' 天前'
}

/**
 * 解析「档案 → 提示词」的输出（容错）：
 * 优先 JSON（{"prompt","negative"} / 裸字符串）；模型只回了一段文本就当正向提示词用。
 */
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
  } catch (_) {
    return { prompt: raw.trim(), negative: '' }
  }
}

/** 读项目级兜底模板（chars.md / scenes.md 的「## 兜底默认」小节）+ 空镜必备句，失败回退内置 */
async function fallbackTemplates() {
  const out = { ...FALLBACK_TPL, keeper: SCENE_KEEPER_DEFAULT }
  try {
    const cl = parseFallbacks(await readPrompt('chars.md'))
    const hero = pickFallback(cl, ['主人公', '主角', 'hero'])
    const npc = pickFallback(cl, ['配角', 'npc', 'npc角色'])
    if (hero) out.hero = hero
    if (npc) out.npc = npc
  } catch (_) { /* 用内置 */ }
  try {
    const smd = await readPrompt('scenes.md')
    const sc = pickFallback(parseFallbacks(smd), ['场景', 'scene'])
    if (sc) out.scene = sc
    const keeper = pickKeeper(smd)
    if (keeper) out.keeper = keeper
  } catch (_) { /* 用内置 */ }
  return out
}

export default {
  name: 'StageChars',
  data() {
    return {
      cards: [], busy: false, _b64: {}, _dims: {}, ask: null, _keeper: SCENE_KEEPER_DEFAULT,
      // 批量任务（块 2 标题行的两个按钮）：
      //   batch*=队列在跑；*Stop=已点停止等当前条目收尾；askBatch=范围选择弹窗
      //   batch*N/Total=按钮上的进度（正在处理第 N 个 / 共 Total 个），跑完/停止归零
      batchP: false, batchPStop: false, batchPN: 0, batchPTotal: 0,
      batchI: false, batchIStop: false, batchIN: 0, batchITotal: 0,
      askBatch: null,
      // 🔴 Teleport 延迟挂载开关：块 2 的 <section :key> 切集时整棵重建，Vue 在脱离文档的子树里
      // 挂载本组件时 document.querySelector('#chars-batch') 拿不到目标 → 内容被静默丢弃。
      // 必须 mounted + nextTick（DOM 已插入文档）后再渲染 Teleport
      tpReady: false,
      // 有生成在跑时 = 该次生成所属的集 id；切集时改置 'SWITCHED'（收尾写库守卫据此丢弃，防旧集数据写进新集）
      _busyEpId: null
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    /** 单一网格的摆放顺序：先角色、后场景（同类内部保持原顺序），每项带上在 cards 里的真实下标 */
    ordered() {
      const rank = { character: 0, scene: 1 }
      return this.cards.map((c, i) => ({ c, i }))
        .sort((a, b) => ((rank[a.c.kind] || 0) - (rank[b.c.kind] || 0)) || (a.i - b.i))
    },
    /** 依赖每秒自增的 tick，让「生成中 已用 X」实时刷新 */
    live() { return this.pl.tick },
    /** 分镜生成进行中（阶段3 一次产出 分镜+角色/场景档案）→ 本块同步显示进度条，表示两块同时工作 */
    shotsGening() { return !!this.pl.genStartAt[2] }
  },
  watch: {
    'st.current'(ep) {
      // 生成在跑时切了集：自动请求停止（当前条目跑完即停，剩余丢弃）；
      // 并把 _busyEpId 置哨兵，让在途任务的收尾写库被守卫丢弃——否则旧集数据会写进新集
      if (this.batchP || this.batchI || this.busy) {
        this.batchPStop = this.batchIStop = true
        this._busyEpId = 'SWITCHED'
        this.$root.toast('已切换剧集：当前条目完成后批量停止，剩余任务丢弃')
      }
      if (ep) this.init(ep)
    },
    // 🔴 各块常驻挂载（无锁定随时可见）：分镜/档案在别处生成后要立即反映到这里
    'st.current.chars'() { this.rebuildSoon() },
    'st.current.scenes'() { this.rebuildSoon() },
    'st.current.shots'() { this.rebuildSoon() },
    'pl.active'(v) {
      if (v !== 3 || this.busy) return
      // 🔴 进入本块必须按「上一阶段的最新产出」重建卡片：
      //    组件在打开剧集时就全部挂载了，那一刻分镜还不存在；
      //    用户生成完分镜点「下一步」只是把数据写进 st.current（同引用，watch('st.current') 不触发）。
      this.syncFromEpisode()
    }
  },
  created() { if (this.ep) this.init(this.ep) },
  mounted() {
    // 🔴 批量按钮靠 Teleport 挂到块 2 标题行：必须等 DOM 真正插入文档（mounted + nextTick）后再渲染，
    //    否则切集重挂载时 querySelector('#chars-batch') 落空 → 内容被静默丢弃（按钮不出现）
    this.$nextTick(() => { this.tpReady = true })
  },
  methods: {
    ratioLabel,
    resLabel,
    /** 分镜/档案在他处更新后延迟重建（合并同帧多次触发；生成中不重建） */
    rebuildSoon() {
      clearTimeout(this._rt)
      this._rt = setTimeout(() => { if (this.ep && !this.busy) this.init(this.ep) }, 150)
    },
    /** 按当前剧集重建卡片（进入本块时调用；档案/出图/分辨率都会保留） */
    async syncFromEpisode() { if (this.ep) await this.init(this.ep) },
    /** 由上一阶段的产出构建卡片：已有档案优先，分镜里出现但档案缺失的名字用兜底模板补 */
    async init(ep) {
      const olds = []
      for (const o of ep.chars || []) olds.push({ ...o, kind: 'character' })
      for (const o of ep.scenes || []) olds.push({ ...o, kind: 'scene' })
      const byKey = new Map(olds.filter(o => o.name).map(o => [o.kind + '|' + o.name, o]))

      // 分镜里出现的角色名与场景名（保序）
      const names = { character: [], scene: [] }
      for (const s of ep.shots || []) {
        for (const n of String(s.chars || '').split(/[、,，/]/)) {
          const t = n.trim()
          if (t && names.character.indexOf(t) < 0) names.character.push(t)
        }
        const sc = String(s.scene || '').trim()
        if (sc && names.scene.indexOf(sc) < 0) names.scene.push(sc)
      }
      // 已有档案但分镜没提到的名字也保留（可能用户手动加过图）
      for (const o of olds) if (names[o.kind].indexOf(o.name) < 0) names[o.kind].push(o.name)

      const tpl = await fallbackTemplates()
      this._keeper = tpl.keeper || SCENE_KEEPER_DEFAULT   // 场景图的空镜必备句（来自 scenes.md）
      const out = []
      for (const kind of ['character', 'scene']) {
        names[kind].forEach((name, idx) => {
          const old = byKey.get(kind + '|' + name) || {}
          const role = kind === 'scene' ? '场景' : (old.role || (idx === 0 ? '主人公' : '配角'))
          const t = kind === 'scene'
            ? (tpl.scene || FALLBACK_TPL.scene)
            : (role === '主人公' ? tpl.hero : tpl.npc)
          out.push({
            kind,
            name,
            role,
            // 档案（提示词的依据）：来自分镜提取，用户可手改；_profRev/_profRevAt/_profAck 是脏标记依据
            profile: normalizeProfile(old.profile || ''),
            _profRevAt: old._profRevAt || 0,
            _profRev: old._profRev || 0,
            _profAck: old._profAck || 0,
            prompt: old.prompt || (t || '').replace(/\{name\}/g, name),
            negative: old.negative || DEFAULT_NEG,
            promptMs: old.promptMs || 0,
            promptAt: old.promptAt || 0,
            candidates: Array.isArray(old.candidates) ? old.candidates.slice() : [],
            cur: typeof old.cur === 'number' ? old.cur : -1,
            res: old.res || '',
            genMs: old.genMs || 0,
            // 脏标记依据：图片版本号（重生成/换图自增）——分镜行的素材签名按它判断「上游已变化」
            _imgRev: old._imgRev || 1
          })
        })
      }
      // 逐张卡分辨率默认值（未单独设置过 → 取剧集配置）；清掉上次会话的运行态字段
      const defRes = (ep.res && ep.res.img) || '1216x832'
      this.cards = out
      this.cards.forEach(c => {
        delete c._gen; delete c._genAt; delete c._pgGen; delete c._pgAt
        if (!c.res) c.res = defRes
      })
    },
    /** 该类型的图根目录：<项目>/assets/characters 或 <项目>/assets/scenes */
    rootOf(c) {
      const a = this.ep && this.ep.assetsDir
      return a ? joinPath(a, c.kind === 'scene' ? 'scenes' : 'characters') : ''
    },
    /** 某张卡的图目录：<项目>/assets/<类型>/<名称> */
    dirOf(c) { return joinPath(this.rootOf(c), seg(c.name)) },
    /** 某张图的绝对路径 */
    absOf(c, f) { return joinPath(this.dirOf(c), f) },
    /** 卡片上的耗时文案：生成中实时计时 / 完成后显示本次生成耗时 */
    genText(c) {
      void this.live
      if (c._genAt) return '生成中 已用 ' + fmtMs(Date.now() - c._genAt)
      return c.genMs ? '耗时 ' + fmtMs(c.genMs) : ''
    },
    /** 档案区的时间文案：正在生成提示词 / 上次生成提示词的时间 */
    pgText(c) {
      void this.live
      if (c._pgAt) return '生成提示词 已用 ' + fmtMs(Date.now() - c._pgAt)
      return c.promptAt ? '提示词 ' + agoText(c.promptAt) : ''
    },
    /** 该卡当前生效的分辨率（未单独设置过 → 剧集配置） */
    resOf(c) { return c.res || (this.ep && this.ep.res && this.ep.res.img) || '1216x832' },
    /** 档位按当前底模过滤；该卡已保存的值不在档位里时补进去（保证显示正确） */
    optsFor(c) { return optsWith((this.st.resOptions || {}).img, this.resOf(c)) },
    /** 大预览当前图片的实际分辨率（'1216×832'，读到为止显示空） */
    dimOf(c) {
      const f = this.selFile(c)
      if (!f) return ''
      return this._dims[this.absOf(c, f)] || ''
    },
    /** 图片载入后读真实尺寸（用于分辨率角标） */
    readDims(abs, src) {
      if (this._dims[abs]) return
      const im = new Image()
      im.onload = () => { this._dims[abs] = im.naturalWidth + '×' + im.naturalHeight }
      im.src = src
    },
    selFile(c) { return c.cur >= 0 ? (c.candidates[c.cur] || null) : null },
    /** 抽卡区只渲染最新 SHOW_MAX 张，返回时带上真实下标 */
    shown(c) { return c.candidates.map((f, i) => ({ f, i })).slice(-SHOW_MAX) },
    imgSrc(abs) {
      // 绝对路径 → base64（IPC 只能拿 base64，浏览器不能直接读本地文件）
      if (!abs) return ''
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''   // 占位，避免同一张图被重复读盘
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) {
          this._b64[abs] = 'data:image/png;base64,' + b64
          this.readDims(abs, this._b64[abs])   // 顺带读真实尺寸（大预览角标）
        }
        else delete this._b64[abs]   // 读取失败不缓存空串，下次渲染重试（文件可能稍后才落盘）
      })
      return ''
    },
    /** 点缩略图：选中并放大到主预览，同时把它指定为「图生图」底图；再点同一张 → 取消选中（回到文生图） */
    pick(c, i) {
  c = this.liveCard(c)   // 缩略图点击可能来自重建前的旧卡对象
  if (c.cur === i) { c.cur = -1; c.refAsBase = false } else { c.cur = i; c.refAsBase = true }
  this.saveAll()
},
    askDel(c, i) { this.ask = { c, i, f: c.candidates[i] } },
    /** 🔴 卡片可能因 rebuildSoon 被整体替换（保存→watch→150ms 后 init 重建），
     *  弹窗/异步回调里持有的旧对象已脱离 this.cards —— 任何写操作前先按
     *  「类型+名字」重新解析当前活卡，文件名是稳定标识，用它找回下标 */
    liveCard(c) { return this.cards.find(x => x.kind === c.kind && x.name === c.name) || c },
    async doDel(permanent) {
      const f = this.ask.f
      const c = this.liveCard(this.ask.c)
      const i = c.candidates.indexOf(f)
      this.ask = null
      if (i < 0) return
      const L = stepLog(TAG)
      try {
        if (permanent) {
          const abs = this.absOf(c, f)
          await window.studio.deleteFile(abs)
          delete this._b64[abs]
          L.done('已永久删除图片：' + c.name + '/' + f)
        } else {
          L.done('已从列表移除（磁盘保留）：' + c.name + '/' + f)
        }
        c.candidates.splice(i, 1)
        if (c.cur === i) c.cur = -1
        else if (c.cur > i) c.cur -= 1
        c._imgRev = (c._imgRev || 1) + 1   // 图片集合变化 → 下游签名失配即提示
        this.st.invalidateMedia(this.ep.projectId, 'characters')
        await this.saveAll()
      } catch (e) {
        L.fail('删除图片失败', null, e)
        this.st.fail(e)
      } finally { this.ask = null }
    },
    /** 落库守卫：生成在跑时切了集（_busyEpId = 'SWITCHED'）→ 在途任务的收尾写库直接丢弃，
     *  防止旧集的 chars/scenes 被写进新切换的集（st.saveArtifact 写的是 this.current.id） */
    canSave() {
      return !(this._busyEpId && this.st.current && this._busyEpId !== this.st.current.id)
    },
    /** 落库：拆成 chars.json（角色）与 scenes.json（场景）两个工件 */
    async saveAll() {
      if (!this.canSave()) return
      const clean = (kind) => this.cards.filter(c => c.kind === kind).map(o => {
        const c = { ...o }                  // _gen / _genAt / _pgGen / _pgAt / refAsBase 是运行时字段，不落库
        delete c._gen; delete c._genAt; delete c.refAsBase; delete c._pgGen; delete c._pgAt; delete c.kind
        return c
      })
      await this.st.saveArtifact('chars', clean('character'))
      await this.st.saveArtifact('scenes', clean('scene'))
    },
    /* ================= 档案（提示词的依据） ================= */
    /** 档案是否落后于提示词（纯函数，读取用；不修改任何响应式数据） */
    profStale(c) { return profileDirty(c) },
    /** 用户编辑档案：档案版本 +1 → 卡片出现「档案已改 · 提示词待更新」并立即落库 */
    async touchProfile(c) {
      const card = this.liveCard(c)
      card._profRev = (card._profRev || 0) + 1
      card._profAck = 0
      await this.saveAll()
    },
    /** 点掉档案脏标记：先不动提示词（只记下「这个版本我看过了」） */
    async ackProfile(i) {
      const c = this.cards[i]
      if (!c) return
      c._profAck = c._profRev || 0
      await this.saveAll()
    },
    /** 同类其它条目的档案（生成提示词时下发，保证与已有角色/场景在外观维度上错开） */
    othersOf(c) { return this.cards.filter(x => x.kind === c.kind && x.name !== c.name) },
    /**
     * 档案 → 提示词（单卡「生成提示词」按钮；批量也走这里）：
     * 读 profile.md + chars.md / scenes.md 组装 system，把本卡档案与同类其它档案一起下发，
     * 模型返回 {prompt, negative} 覆盖当前提示词（之后仍可手改）。
     */
    async genPromptFromProfile(i, ctx) {
      const c = this.cards[i]
      if (!c) return false
      if (!String(c.profile || '').trim()) {
        this.$root.toast('「' + c.name + '」还没有档案，先填写档案或重新生成分镜')
        return false
      }
      const isScene = c.kind === 'scene'
      const what = isScene ? '场景提示词' : '角色提示词'
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.busy = true
      c._pgGen = true
      c._pgAt = Date.now()
      const t0 = Date.now()
      this.pl.beginGen(3)
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在按档案生成' + what + '：' + c.name + prog)
      try {
        const system = await composeSystem({
          identity: PC_IDENTITY,
          specs: ['profile.md', isScene ? 'scenes.md' : 'chars.md'],
          contract: PC_CONTRACT, fallback: PC_FALLBACK
        })
        const others = profileBrief(this.othersOf(c), c.name)
        const user = (isScene ? '场景' : '角色') + '档案（这是本次提示词的唯一依据）：\n' + c.profile +
          (others ? '\n\n【本项目同类已有档案】新写的提示词必须与它们在至少 3 个维度上明显不同（体型 / 发型 / 服装主色 / 配饰等），不得撞脸撞色：\n' + others : '') +
          '\n\n任务：按上面的档案，为「' + c.name + '」写一条正向生图提示词与一条负向提示词。'
        dbgPrompt(TAG, '档案 → 提示词 · ' + (isScene ? '场景' : '角色') + '「' + c.name + '」', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 1024, json: true, label: TAG })
        const out = parsePcOut(text)
        if (!out.prompt) throw new Error('LLM 未返回正向提示词')
        c.prompt = out.prompt
        c.negative = out.negative || c.negative || DEFAULT_NEG
        c.promptMs = Date.now() - t0
        c.promptAt = Date.now()
        c._profRevAt = c._profRev || 0     // 提示词已对齐当前档案 → 脏标记消失
        c._profAck = c._profRev || 0
        await this.saveAll()
        L.done(what + '「' + c.name + '」生成完成：' + out.prompt.length + ' 字' + (out.negative ? '（含负向）' : '（未返回负向，沿用原值）'), c.promptMs)
        return true
      } catch (e) {
        L.fail(what + '「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        delete c._pgAt; c._pgGen = false; this.busy = false; this.pl.endGen(3)
        if (!this.batchI && !this.batchP) this._busyEpId = null
      }
    },
    /** 生成某张卡的图（逐张分辨率取该卡自己的配置）；角色与场景走同一套流程 */
    async gen(i, ctx) {
      const c = this.cards[i]
      if (!c) return false
      const isScene = c.kind === 'scene'
      const what = isScene ? '场景图' : '角色图'
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.busy = true
      c._gen = true
      c._genAt = Date.now()      // 卡片上「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(3)
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      // 🔴 只有用户显式点选缩略图（refAsBase）才走图生图：生成完成后自动选中的「最新图」只用于预览，
      //    否则每次重生成都会拿上一张当底图，把上一次画面里的人物/瑕疵一并继承下来（场景出「人」的元凶之一）
      const fromRef = !!c.refAsBase && c.cur >= 0
      // 场景图强制空镜：正向里缺空镜陈述时补上「空镜必备句」（取自 scenes.md，可随时改）
      const positive = isScene ? ensureSceneKeeper(c.prompt, this._keeper) : c.prompt
      const [rw, rh] = parseRes(this.resOf(c))
      L.start('正在生成' + what + '：' + c.name + prog + '（' + rw + 'x' + rh +
        ' · ' + resLabel(this.optsFor(c), this.resOf(c)) +
        (fromRef ? ' · 图生图，参考：' + c.candidates[c.cur] : ' · 文生图') + '）')
      try {
        const dir = this.dirOf(c)
        dbgPrompt(TAG, '图片模型 · ' + what + '「' + c.name + '」', [
          ['positive', positive],
          ['negative', c.negative || DEFAULT_NEG],
          ['size', rw + 'x' + rh + '（' + resLabel(this.optsFor(c), this.resOf(c)) + '）'],
          ['mode', fromRef ? '图生图 denoise 0.62，参考图 ' + c.candidates[c.cur] : '文生图' + (isScene ? '（已补空镜句）' : '')]
        ])
        const r = await window.studio.comfyGenerate({
          templateKey: 'character', dir, baseName: c.name,
          params: {
            prompt: positive, negative: c.negative || DEFAULT_NEG,
            width: rw, height: rh,
            // 选了缩略图 → 图生图（拿那张图当底图重绘，denoise 0.62）；没选 → 纯文生图
            ...(fromRef ? { image: this.absOf(c, c.candidates[c.cur]) } : {})
          },
          label: TAG
        })
        // 可无限重生成：磁盘与 candidates 记录全部保留，只是抽卡区最多显示最新 4 张
        c.candidates = [...c.candidates, ...r.files]
        c.cur = c.candidates.length - 1   // 自动选中最新图（只为预览）
        c.refAsBase = false               // 但不当作下一次的图生图底图（避免继承上一张画面里的人物）
        const ms = Date.now() - t0
        c.genMs = ms                 // 逐条耗时（持久化，显示在该卡标题旁）
        c._imgRev = (c._imgRev || 1) + 1   // 图片版本 +1：引用本资产图片的镜头提示词会被标 ⚠
        delete c._genAt
        await this.saveAll()
        this.pl.markGen(3, ms)
        this.st.invalidateMedia(this.ep.projectId, 'characters')   // 左侧树 assets 下次展开刷新
        L.done(what + '「' + c.name + '」生成完成：' + r.files.join('、'), ms)
        this.$root.toast(c.name + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail(what + '「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        delete c._genAt; c._gen = false; this.busy = false; this.pl.endGen(3)
        if (!this.batchI && !this.batchP) this._busyEpId = null
      }
    },
    /* ================= 批量任务（块 2 标题行的两个按钮） ================= */
    /** 「批量生成提示词」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围 */
    batchPrompts() {
      if (this.batchP) { this.batchPStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchI) { this.$root.toast('图片批量进行中，请先等它结束或停止'); return }
      if (!this.cards.length) { this.$root.toast('还没有角色/场景，先点「生成分镜」'); return }
      this.askBatch = { kind: 'prompts' }
    },
    /** 「批量生成图片」：跑动中点击 = 请求停止；空闲直接开跑（跳过已有图的条目） */
    batchImages() {
      if (this.batchI) { this.batchIStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchP) { this.$root.toast('提示词批量进行中，请先等它结束或停止'); return }
      if (!this.cards.length) { this.$root.toast('还没有角色/场景，先点「生成分镜」'); return }
      this.runBatchI()
    },
    askBatchAll() { this.askBatch = null; this.runBatchP(true) },
    askBatchMissing() { this.askBatch = null; this.runBatchP(false) },
    /**
     * 批量生成提示词：all=true 全部按档案重算并覆盖；false 只处理「档案已改未重算」+「还没有提示词」。
     * 逐个顺序执行，batchPStop 置位后当前条目跑完即停（剩余丢弃），结束统一统计。
     */
    async runBatchP(all) {
      const L = stepLog(TAG)
      const idx = []
      for (let i = 0; i < this.cards.length; i++) {
        const c = this.cards[i]
        if (all) {
          if (String(c.profile || '').trim()) idx.push(i)   // 没有档案的条目没法按档案生成（按钮已禁用，双保险）
          continue
        }
        if (!String(c.prompt || '').trim() || profileDirty(c)) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成提示词的条目'); return }
      this.askBatch = null
      this.batchP = true; this.batchPStop = false; this.busy = true
      this.batchPN = 0; this.batchPTotal = idx.length
      L.start('开始批量生成提示词（' + (all ? '全部按档案重算，覆盖已有' : '只处理档案有变动 / 还没有提示词的') + '）：待生成 ' +
        idx.length + ' 个（共 ' + this.cards.length + ' 个角色/场景）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          // 🔴 每轮开头都查停止标记 + 切集哨兵：切集后剩余任务一律丢弃（旧循环持有的 index 已指向新集）
          if (this.batchPStop || this._busyEpId === 'SWITCHED') { stopped = true; break }
          this.batchPN = k + 1
          const okFlag = await this.genPromptFromProfile(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
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
        if (!this.batchI) this._busyEpId = null
      }
    },
    /** 批量生成图片：只补还没有图的条目（已有图的跳过，可用单卡按钮无限重生成），可随时停止 */
    async runBatchI() {
      const L = stepLog(TAG)
      const idx = []
      for (let i = 0; i < this.cards.length; i++) {
        if (!this.cards[i].candidates.length) idx.push(i)
      }
      if (!idx.length) {
        this.$root.toast('没有需要生成的条目（都已有图；可用单卡按钮无限重生成）')
        return
      }
      this.batchI = true; this.batchIStop = false; this.busy = true
      this.batchIN = 0; this.batchITotal = idx.length
      L.start('开始批量生成图片：待生成 ' + idx.length + ' 个（共 ' + this.cards.length + ' 个角色/场景，跳过 ' +
        (this.cards.length - idx.length) + ' 个已有图）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchIStop || this._busyEpId === 'SWITCHED') { stopped = true; break }
          this.batchIN = k + 1
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成图片已停止' : '批量生成图片结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各自失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchI = false; this.batchIStop = false; this.busy = false
        this.batchIN = 0; this.batchITotal = 0
        if (!this.batchP) this._busyEpId = null
      }
    },
    async confirm() {
      await this.saveAll()
      this.pl.confirm(3, this.ep.id)
      this.$root.toast('角色 & 场景已确认')
    },
    /* ---- 一键填充：把当前选中的这张图批量填进「包含该角色/该场景」的镜头的参考图区 ---- */
    /** 该镜头是否包含这张卡（角色比对 shots[].chars，场景比对 shots[].scene） */
    shotHas(c, s) {
      const raw = String((c.kind === 'scene' ? s.scene : s.chars) || '')
      if (!raw) return false
      if (c.kind === 'scene') return raw.trim() === c.name || raw.includes(c.name)
      return raw.split(/[、,，/]/).map(x => x.trim()).includes(c.name) || raw.includes(c.name)
    },
    /**
     * 一键填充：把该卡**当前选中**的那张图追加到所有命中镜头的 refs.images。
     * - 只填参考图（不动首帧/尾帧）；镜头已有这张图 → 跳过；参考图已满 9 张 → 跳过
     * - 结束后用 toast 汇总（填了几个、跳过几个及原因）
     * - 命中的镜头会因此亮 ⚠（素材签名变了 → 提示词应重新生成），这是预期行为
     */
    async fillRefs(i) {
      const c = this.liveCard(this.cards[i])
      const f = c ? this.selFile(c) : null
      if (!c || !f) { this.$root.toast('请先在小预览图里选中一张，再点「一键填充」'); return }
      const ep = this.ep
      const shots = (ep && ep.shots) || []
      if (!shots.length) { this.$root.toast('还没有镜头；先在第 4 块生成分镜再填充'); return }
      const abs = this.absOf(c, f)
      // 🔴 工件在 store 里，必须整份复制出来改完再落库（改同引用会漏存）
      const prompts = JSON.parse(JSON.stringify(ep.prompts || []))
      while (prompts.length < shots.length) prompts.push({ text: '', refs: EMPTY_REFS() })
      let hit = 0, dup = 0, full = 0
      shots.forEach((s, k) => {
        if (!this.shotHas(c, s)) return
        if (!prompts[k]) prompts[k] = { text: '', refs: EMPTY_REFS() }
        const p = prompts[k]
        if (!p.refs) p.refs = EMPTY_REFS()
        if (!Array.isArray(p.refs.images)) p.refs.images = []
        const imgs = p.refs.images
        if (imgs.indexOf(abs) >= 0) { dup++; return }
        if (imgs.length >= MAX_REF_IMG) { full++; return }
        imgs.push(abs)
        hit++
      })
      if (!hit) {
        const why = []
        if (dup) why.push(dup + ' 个镜头已有这张图')
        if (full) why.push(full + ' 个镜头参考图已满 ' + MAX_REF_IMG + ' 张')
        this.$root.toast(why.length ? '没有可填充的镜头（' + why.join('、') + '）'
          : '没有镜头包含「' + c.name + '」，未填充')
        return
      }
      try {
        await this.st.saveArtifact('prompts', prompts)
        // 通知常驻挂载的「分镜脚本」块按最新工件重建表单（否则它的本地副本会把这次填充覆盖回去）
        ep.promptsSyncAt = Date.now()
      } catch (e) { this.st.fail(e); return }
      const skip = []
      if (dup) skip.push(dup + ' 个已有该图')
      if (full) skip.push(full + ' 个已满 ' + MAX_REF_IMG + ' 张')
      this.$root.toast('已把「' + c.name + '」的这张图填入 ' + hit + ' 个镜头的参考图区' +
        (skip.length ? '（跳过 ' + skip.join('、') + '）' : '') + '；这些镜头的提示词已标 ⚠，记得重新生成')
    }
  }
}
</script>
