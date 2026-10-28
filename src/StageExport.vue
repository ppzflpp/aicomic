<template>
  <div>
    <div v-if="busy" class="progress"><div class="bar indeterminate"></div></div>

    <!-- 导出设置弹窗（2026-10-20，Dragon）：输出分辨率 / 添加字幕 / 响度归一 都收进来，
         确认后才真正开始拼。每次导出都单独留档，所以这几项选择只影响这一次。 -->
    <div v-if="ex.open" class="modal-mask" @click.self="closeExport">
      <div class="modal ex-modal">
        <div class="modal-title">导出成片</div>
        <div class="ex-note">
          把本集 {{ shots.length }} 个镜头（共 {{ durTextCn }}）按顺序拼成一条 MP4，留档在「项目/成片」。
          <template v-if="upFilmCount">其中 <b>{{ upFilmCount }}</b> 个镜头用超分后的版本。</template>
        </div>

        <label class="ex-row">
          <span class="ex-k">输出分辨率</span>
          <select class="res-sel" v-model="outRes" :disabled="busy" @change="onRes">
            <option v-for="o in outOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span class="ex-tip">{{ outHint }}</span>
        </label>

        <label class="ex-row">
          <span class="ex-k">添加字幕</span>
          <input type="checkbox" v-model="subsEnabled" :disabled="busy" @change="onSubs" />
          <span class="ex-tip">勾选后把对白烧录进画面；不勾则成片不带任何字幕</span>
        </label>

        <label class="ex-row">
          <span class="ex-k">响度归一</span>
          <input type="checkbox" v-model="normEnabled" :disabled="busy" @change="onNorm" />
          <span class="ex-tip">统一各镜音量到同一响度（-16 LUFS），治镜头之间 BGM 忽大忽小</span>
        </label>

        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn sec" :disabled="busy" @click="closeExport">取消</button>
          <button class="btn" :disabled="busy" @click="confirmExport">
            <span v-if="busy" class="busy-txt"><i class="spin"></i>导出中…</span>
            <span v-else>开始导出</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 超分选择弹窗：只负责「选哪些镜头 + 倍率」。点「开始超分」后弹窗立刻关闭，
         逐镜进度写在镜头格上、汇总在标题栏那颗按钮里（不在这里）。 -->
    <div v-if="up.open" class="modal-mask" @click.self="closeUpDialog">
      <div class="modal modal-lg up-modal">
        <div class="modal-title">视频超分 · 已选 {{ upPicked.length }} / {{ upList.length }} 个镜头</div>
        <div class="up-note">
          <p>建议先用「质量优先」档位生成视频，再做超分 —— 源头画面越扎实，放大后的细节越好。</p>
          <p>超分很吃显存：如果中途报显存不足（OOM），把放大倍率调低一档重试，<b>1.5 倍最稳</b>。</p>
          <p>耗时也长，单镜通常数分钟到十几分钟，镜头越长、画布越大越久。开始后这个窗口会关掉，
            可以切到别的模块干别的，回来看镜头格上的蒙版即可。</p>
          <div class="up-ref">
            参考值：<b>864×480 · 6.6 秒 · 2 倍 ≈ 10 分钟</b>；同样长度的 1344×768 约为它的 2～3 倍（按像素量估算）。
          </div>
        </div>
        <div class="up-tools">
          <label class="up-all">
            <input type="checkbox" :checked="upAllOn" @change="toggleAll" /> 全选
          </label>
          <span style="flex:1"></span>
          <label class="up-scale">放大倍率
            <select v-model.number="up.scale">
              <option :value="1.5">1.5 倍</option>
              <option :value="2">2 倍（推荐）</option>
              <option :value="3">3 倍</option>
            </select>
          </label>
        </div>

        <div class="up-list">
          <label v-for="it in upList" :key="'u' + it.i" class="up-row" :class="{ done: !!it.upRes }">
            <input type="checkbox" v-model="up.sel[it.i]" />
            <b>镜头 {{ it.i + 1 }}</b>
            <span class="up-src">{{ it.res || '—' }}</span>
            <span v-if="it.upRes" class="up-tag">已超分</span>
            <span v-else class="up-tag pending">未超分</span>
          </label>
        </div>

        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn sec" @click="closeUpDialog">取消</button>
          <button class="btn" :disabled="!upPicked.length" @click="doUpscale">开始超分</button>
        </div>
      </div>
    </div>

    <!-- 超分失败明细（只在有失败时出现）：进度不在这里，见标题栏按钮 + 镜头格蒙版 -->
    <div v-if="up.err" class="up-bar bad">
      <span class="up-txt bad">{{ up.msg }}</span>
      <span style="flex:1"></span>
      <button class="btn sec" @click="clearUpErr">关闭</button>
      <pre class="up-err">{{ up.err }}</pre>
    </div>
    <!-- 镜头格 × N + 成片格 × 1：格子数跟着镜头数走。已选中的镜头在对应格子里显示那版视频；
         超分跑完的镜头显示超分版并挂「超分视频」绿标（成片也用它）；还没生成的显示「待生成」占位符。
         成片格只显示最新一版；历史成片仍留在磁盘上，可用「打开所在文件夹」查看。 -->
    <div v-if="cells.length || films.length" class="film-grid">
      <div v-for="c in cells" :key="'s' + c.i" class="vcard" :class="{ confirmed: c.confirmed }">
        <div class="video-box">
          <!-- 等待 / 正在超分：半透明蒙版压住画面，中间写清这一镜在干嘛（否则看不出是卡了还是在跑）。
               跑完换成左上角「超分视频」绿标（成片也会用这一版，见 exportFilm）。 -->
          <template v-if="upSt(c.i)">
            <div class="up-mask"></div>
            <span class="up-chip" :class="upSt(c.i)">
              <i v-if="upSt(c.i) === 'run'" class="spin"></i>{{ upStText(c.i) }}
            </span>
          </template>
          <span v-else-if="c.isUp" class="up-badge"
                :title="'已超分：' + resText(c.srcRes) + ' → ' + resText(c.res) + '（点「超分视频」可换倍率重做）'">
            超分视频
          </span>
          <video v-if="c.path && srcMap[c.path]" :src="srcMap[c.path]" controls></video>
          <div v-else class="ph">
            <span v-if="c.path && loadingSrc[c.path]" class="busy-txt"><i class="spin"></i>加载中…</span>
            <template v-else>镜头 {{ c.i + 1 }}<br>{{ c.confirmed ? '加载中…' : '待生成' }}</template>
          </div>
        </div>
        <div class="vmeta">
          <!-- 第 1 行：镜头号 · 角色 · 场景；第 2 行：时长 · 分辨率 · 生成耗时 -->
          <div class="vm-l1">
            <b>镜头 {{ c.i + 1 }}</b>
            <span v-if="c.chars">{{ c.chars }}</span>
            <span v-if="c.scene" class="vm-scene">{{ c.scene }}</span>
          </div>
          <div class="vm-l2">
            <span>{{ c.dur }}s</span>
            <span>{{ resText(c.res) }}</span>
            <span v-if="c.genMs" class="gen-ms">耗时 {{ fmtMs(c.genMs) }}</span>
          </div>
        </div>
      </div>

      <div class="vcard film-card" :class="{ confirmed: !!latest }">
        <div class="video-box">
          <video v-if="latest && srcMap[latest.path]" :src="srcMap[latest.path]" controls></video>
          <div v-else class="ph">
            <span v-if="latest && loadingSrc[latest.path]" class="busy-txt"><i class="spin"></i>加载中…</span>
            <template v-else>成片<br>{{ busy ? '组装中…' : (exportable ? '点「导出成片」开始组装' : '待选齐全部镜头') }}</template>
          </div>
        </div>
        <div class="vmeta">
          <!-- 第 1 行：成片 · 生成时间；第 2 行：时长 · 分辨率 · 导出耗时 -->
          <div class="vm-l1">
            <b>成片</b>
            <span v-if="latest">{{ fmtTime(latest.mtimeMs) }}</span>
            <span v-else class="hint">整集拼接后的最终成片</span>
          </div>
          <div class="vm-l2" v-if="latest">
            <span>{{ durText(latest) }}</span>
            <span>{{ res(latest) }}</span>
            <span v-if="latest.elapsedMs" class="gen-ms">耗时 {{ fmtMs(latest.elapsedMs) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!cells.length && !films.length" class="placeholder">本集还没有镜头；请先在第 4 块生成分镜、生成视频。</div>

    <!-- 操作条：提示文字靠左；「输出分辨率 / 添加字幕 / 导出成片」三个功能 Teleport 到块 4 标题栏靠右（#export-ops）。
         🔴 Teleport 延迟挂载（tpReady）：section :key 切集整棵重建，脱离文档时 querySelector 拿不到落点会静默丢弃 -->
    <Teleport v-if="tpReady" to="#export-stats">
      <!-- 镜头数与总时长（2026-10-20，Dragon）：模块标题行靠左，实时跟随分镜增删 / dur 编辑。
           口径与分镜块「总时长 Ns」一致（Number(dur)||0 累加）—— 同一屏两处必须给同一个数。 -->
      <span v-if="shots.length" class="total-dur"
            :title="'本集 ' + shots.length + ' 个镜头加起来 ' + totalDur + ' 秒（成片还会加上转场和片头片尾，实际更长）'">
        共 {{ shots.length }} 个镜头 · 共 {{ durTextCn }}
      </span>
    </Teleport>
    <Teleport v-if="tpReady" to="#export-ops">
      <!-- 视频超分（SeedVR2）：紧挨着「导出成片」（2026-10-20，Dragon），小号淡蓝胶囊。
           点它 = 弹窗选镜头；跑起来后变红 = 「停止超分」，并显示已完成 / 总数。 -->
      <button class="btn sec up-btn" :class="{ stop: up.busy }"
              :disabled="up.busy ? false : (busy || !upList.length)"
              @click="up.busy ? stopUpscale() : openUpscale()"
              :title="up.busy ? '停止超分（已经做完的镜头保留，剩余的不再跑）'
                : (upList.length ? '选择镜头做超分（SeedVR2 本地推理，逐镜排队，单镜数分钟起）' : '还没有已选中的镜头视频')">
        <template v-if="up.busy"><i class="spin"></i>停止超分 已完成 {{ up.done }}/{{ up.total }}</template>
        <template v-else>超分视频</template>
      </button>
      <!-- 导出成片：点开弹窗选「输出分辨率 / 添加字幕 / 响度归一」→ 确认后才开始拼。
           超分在跑的时候禁止导出：跑到一半导会把半新半旧的版本拼进去。 -->
      <!-- 导出成片 = 本模块的主操作：标题栏里唯一的实心蓝（pro）；超分视频是描边次要按钮 -->
      <button class="btn pro" :class="{ regen: !!exportFile }" :disabled="busy || up.busy || !exportable" @click="openExport">
        <span v-if="busy" class="busy-txt"><i class="spin"></i>导出中…</span>
        <span v-else>导出成片</span>
      </button>
    </Teleport>
    <div class="ops-bar">
      <span class="hint">拼接全部已选中镜头成一条 MP4：点「导出成片」可挑输出分辨率、是否烧录对白字幕、是否做响度归一；每次导出都各自留档在 项目/成片/（文件名带集名前缀；本块只显示最新一版，历史版本点右侧「打开所在文件夹」看）</span>
      <span style="flex:1"></span>
      <button class="btn sec" v-if="films.length" @click="reveal">打开所在文件夹</button>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'

/** '宽x高' → [w, h] */
function parseRes(v) { const m = /^(\d+)x(\d+)$/i.exec(String(v || '')); return m ? [+m[1], +m[2]] : [1920, 1080] }

export default {
  name: 'StageExport',
  data() {
    return {
      busy: false, exportFile: null, films: [], srcMap: {}, loadingSrc: {},
      // 🔴 分镜目录实测分辨率映射（文件名 → {width,height}）。由主进程 listVideosWithMeta 探测，
      //    用于镜头格显示「当前选中那版视频」的真实画布（不再依赖 v.res 档位预设，二采档才不显示旧值）。
      shotMeta: {},
      outRes: 'auto', tpReady: false,
      // 导出设置弹窗（分辨率 / 字幕 / 响度归一 都收在这里，确认后才开始拼）
      ex: { open: false },
      // 超分：弹窗只用来「选镜头 + 倍率」；逐镜状态（在跑 / 等待）在镜头格上，汇总在标题栏按钮
      up: { open: false, sel: {}, st: {}, busy: false, stopping: false, scale: 2, total: 0, done: 0, msg: '', err: '' }
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    shots() { return this.ep ? this.ep.shots : [] },
    videoState() { return this.ep ? this.ep.videoState : {} },
    /**
     * 本集镜头总时长（秒）—— 口径与 StageShots 的 totalDur **逐字一致**（`Number(dur) || 0` 累加），
     * 同一屏上（块 3 标题 / 块 4 标题）不能给出两个不一样的数。
     */
    totalDur() { return this.shots.reduce((a, s) => a + (Number((s || {}).dur) || 0), 0) },
    /** 「4 分 30 秒」；不足 1 分钟只写秒，整分不带尾巴（2026-10-20，Dragon 要求 x 分 x 秒） */
    durTextCn() {
      const t = Math.round(this.totalDur)
      const m = Math.floor(t / 60), s = t % 60
      if (m <= 0) return s + ' 秒'
      return m + ' 分' + (s ? ' ' + s + ' 秒' : '')
    },
    /** 镜头格：一格一个镜头。已选中的版本 → 带上该版本视频的绝对路径；否则 path 为 null（显示占位符）
     *  🔴 超分（v.up）优先于原始版本：超分跑完后这一格与成片都用超分文件，原视频仍留在盘上，
     *     用户想换回来只需重新选版本 / 重跑超分（我们不删原始产物）。 */
    cells() {
      const dir = this.ep ? this.ep.shotDir : ''
      return this.shots.map((s, i) => {
        const v = this.videoState[i] || {}
        const srcFile = v.confirmed && v.cur >= 0 ? (v.files[v.cur] || null) : null
        const upFile = (v.up && v.up.file) ? v.up.file : null
        // 🔴 超分产物落在 <分镜>/_upscale/ 子目录里，不能只拼文件名：
        //    v.up.rel 是相对「分镜」的路径（_upscale\xxx_超分.mp4）；早期记录没存 rel，
        //    但 file 只有文件名 → 补上 _upscale\ 前缀（否则拼出来的路径不存在：
        //    格子永远停在「加载中…」，成片也会拿到不存在的文件）。
        const upRel = upFile
          ? (v.up.rel || (/[\\/]/.test(upFile) ? upFile : '_upscale\\' + upFile))
          : null
        const file = upRel || srcFile
        // 🔴 真实画布（2026-10-28）：镜头格分辨率显示「当前选中那版视频」的**实测**分辨率，
        //    不再依赖 v.res（档位预设）。二采档第一遍 864×480、第二遍放大 1344×768，
        //    v.res 停在预设值就会显示旧分辨率。实测值由主进程探测缓存在 shotMeta（文件名→宽高）；
        //    查不到（超分产物不在分镜目录 / 探测未完成）再回退 v.res。
        const m = file && this.shotMeta[file]
        const realRes = m && m.width ? (m.width + 'x' + m.height) : ''
        return {
          i, confirmed: !!v.confirmed, file, isUp: !!upRel,
          path: file && dir ? dir + '\\' + file : null,
          chars: s.chars || '', scene: s.scene || '', dur: s.dur || 8,
          srcRes: v.res || '',
          res: upRel ? (v.up.res || realRes || v.res || '') : (realRes || v.res || ''),
          // 耗时：超分格显示**超分这次**的耗时（不是原视频生成耗时 —— 那是上一次的事）
          genMs: upRel ? (v.up.ms || 0) : (v.genMs || 0)
        }
      })
    },
    /** 成片格显示最新一版成片（listMedia 按生成时间倒序） */
    latest() { return this.films.length ? this.films[0] : null },
    /** 「已选中镜头」的路径串（只用于 watch：变了就补读 base64） */
    cellPaths() { return this.cells.map(c => c.path || '').join('|') },
    exportable() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.videoState[i] && this.videoState[i].confirmed)
    },
    /** 可超分的镜头 = 已经有选中版本的镜头（没出片的镜头没东西可超） */
    upList() {
      const out = []
      this.shots.forEach((s, i) => {
        const v = this.videoState[i] || {}
        const f = v.confirmed && v.cur >= 0 ? ((v.files || [])[v.cur] || '') : ''
        if (!f) return
        out.push({ i, res: v.res ? String(v.res).replace(/x/i, '×') : '', upRes: (v.up && v.up.res) ? String(v.up.res).replace(/x/i, '×') : '' })
      })
      return out
    },
    /** 弹窗里勾选的镜头下标 */
    upPicked() { return this.upList.filter(it => this.up.sel[it.i]) },
    /** 本次成片里会有几个镜头用超分版本（cells 已算好 isUp，只数不改口径） */
    upFilmCount() { return this.cells.filter(c => c.isUp).length },
    /** 全选状态：全部勾上才算（空列表不算） */
    upAllOn() { return this.upList.length > 0 && this.upPicked.length === this.upList.length },
    /** 输出档位（固定预设，与模型无关）；已保存的值不在档位里时补进去。
       「自动」永远排第一（旧主进程 / 旧方案没给这一项时也不会丢）。 */
    outOpts() {
      const list = ((this.st.resOptions || {}).out || []).slice()
      if (!list.some(o => o.value === 'auto')) list.unshift({ value: 'auto', label: '自动（跟第一个镜头）' })
      if (this.outRes && !list.some(o => o.value === this.outRes)) {
        const [w, h] = parseRes(this.outRes)
        const g = (a, b) => { while (b) { [a, b] = [b, a % b] } return a || 1 }
        const d = g(w, h)
        list.unshift({ value: this.outRes, label: w + '×' + h + '（' + (w / d) + ':' + (h / d) + '）' })
      }
      return list
    },
    /** 「自动」到底等于多少：取第一个已选镜头**生成时**的分辨率（真值以主进程探测为准，这里只做提示） */
    autoResText() {
      const c = this.cells.find(x => x.res) || null
      return c ? String(c.res).replace(/x/i, '×') : ''
    },
    /** 操作条文案：自动 → 显示将要跟随的分辨率；固定档 → 显示统一到多少 */
    outHint() {
      if (this.outRes !== 'auto') return '统一 ' + this.outRes.replace('x', '×')
      return this.autoResText
        ? '跟随第一个镜头 ' + this.autoResText + '（不缩放、不补边）'
        : '跟随第一个镜头的分辨率（不缩放、不补边）'
    },
    /** 添加字幕勾选状态：按集记住（存 videos.json 的 opts.subs；缺省 = 勾选，保持历史行为） */
    subsEnabled: {
      get() { const o = (this.videoState || {}).opts; return o ? o.subs !== false : true },
      set(v) {
        if (!this.ep) return
        if (!this.videoState.opts) this.videoState.opts = {}
        this.videoState.opts.subs = !!v
      }
    },
    /** 响度归一勾选状态：按集记住（opts.loud；缺省 = 勾选）。关掉 = 与改造前一致（各镜原始音量） */
    normEnabled: {
      get() { const o = (this.videoState || {}).opts; return o ? o.loud !== false : true },
      set(v) {
        if (!this.ep) return
        if (!this.videoState.opts) this.videoState.opts = {}
        this.videoState.opts.loud = !!v
      }
    }
  },
  watch: {
    'st.current'(ep) {
      if (!ep) return
      this.exportFile = ep.exportFile || null
      this.outRes = (ep.res && ep.res.out) || 'auto'
      this.srcMap = {}; this.loadingSrc = {}   // 换集：清掉上一集的视频缓存
      this.loadList()   // 换集/重启恢复后都要重扫本集成片
      this.syncCells()
    },
    // 进块 → 补齐镜头格 base64 预览（组装已改手动：不再自动开始导出）
    'pl.active'(v) { if (v === 6) this.syncCells() },
    // 已选中镜头的路径集合变化（在上一块点选了别的版本）→ 补齐 base64 预览
    'cellPaths'() { this.syncCells() },
    /**
     * 🔴 重新生成分镜（2026-10-09）：本集的镜头视频与成片文件已被归档搬到 _trash/，
     * 分镜块置 mediaSyncAt 通知本块 —— 必须重扫目录并丢掉旧 base64。
     * 不这么做的话 `films` 还是上一次扫盘的结果，成片格会继续挂着**已被搬走的**旧成片
     * （与当前分镜早已不对应，用户看到的就是「点完生成分镜，成片还在」）。
     */
    'st.current.mediaSyncAt'() {
      if (!this.ep) return
      this.exportFile = null
      this.films = []
      this.srcMap = {}; this.loadingSrc = {}
      this.loadList()
      this.syncCells()
    }
  },
  created() {
    if (this.ep) { this.exportFile = this.ep.exportFile || null; this.outRes = (this.ep.res && this.ep.res.out) || 'auto'; this.loadList() }
    this.syncCells()
  },
  /** 🔴 标题栏 Teleport 延迟挂载：mounted 后 DOM 才真正插入文档，#export-ops 此时才可被 querySelector 命中 */
  mounted() {
    this.$nextTick(() => { this.tpReady = true })
  },
  methods: {
    fmtMs,   // 🔴 必须注册进 methods：模板看不到模块作用域的导入（曾因漏注册 → 成片格一渲染就抛
             //     "fmtMs is not a function" → 整个组件卸载 → 组装成片模块全空白，重启也无法恢复）
    /** 切换输出分辨率：只影响本集后续导出 */
    onRes() { this.st.setEpisodeRes('out', this.outRes) },
    /** 切换「添加字幕」：落库到 videos.json 的 opts（StageShots 的 saveVideos 会原样带过这个键） */
    async onSubs() { await this.st.saveArtifact('videoState', this.ep.videoState) },
    /** 切换「响度归一」：同上，落库到 videos.json 的 opts.loud */
    async onNorm() { await this.st.saveArtifact('videoState', this.ep.videoState) },
    /* ---------------- 导出设置弹窗：先选（分辨率 / 字幕 / 响度归一）再导 ---------------- */
    openExport() {
      if (this.busy || this.up.busy || !this.exportable) return
      this.ex.open = true
    },
    closeExport() { if (!this.busy) this.ex.open = false },
    /** 确认导出：先关窗（导出进度看顶部进度条与成片格，不再挡画面），再走原来的导出流程 */
    confirmExport() {
      this.ex.open = false
      this.exportFilm()
    },
    /* ---------------- 视频超分（SeedVR2）：弹窗只选镜头，状态都在镜头格 / 标题栏按钮上 ---------------- */
    /** 标题栏按钮（空闲态）：打开选择弹窗，默认勾上「还没超分」的镜头 */
    openUpscale() {
      if (this.up.busy) return
      const sel = {}
      for (const it of this.upList) sel[it.i] = !it.upRes
      this.up.open = true
      this.up.sel = sel
      this.up.st = {}
      this.up.err = ''; this.up.msg = ''
    },
    closeUpDialog() { if (!this.up.busy) this.up.open = false },
    toggleAll(e) {
      const on = !!e.target.checked
      const sel = { ...this.up.sel }
      for (const it of this.upList) sel[it.i] = on
      this.up.sel = sel
    },
    /** 某个镜头此刻的超分状态：'' | wait | run | done | fail（done 由 cells 的绿标体现） */
    upSt(i) { return this.up.st[i] || '' },
    upStText(i) {
      const s = this.up.st[i]
      if (s === 'wait') return '等待超分'
      if (s === 'run') return '正在超分'
      if (s === 'fail') return '超分失败'
      return ''
    },
    clearUpErr() { this.up.err = ''; this.up.msg = ''; this.up.st = {} },
    /** 标题栏红色按钮 = 停止：中断 ComfyUI 当前任务，循环在下一个镜头前收手 */
    async stopUpscale() {
      if (!this.up.busy || this.up.stopping) return
      this.up.stopping = true
      this.up.msg = '正在停止超分…'
      try { await window.studio.comfyCancel() } catch (e) { /* 停不下来也要让循环自己收尾 */ }
    },
    async doUpscale() {
      if (this.up.busy) return
      const picks = this.upPicked.map(it => it.i)
      if (!picks.length) return
      const epId = this.ep.id
      const dir = this.ep.shotDir                 // <项目>/分镜/
      const outDir = dir + '\\_upscale'           // 超分产物单独一层：不会混进「镜头版本」列表
      const scale = Number(this.up.scale) || 2
      // 🔴 点了「开始超分」弹窗立刻关：选择已经拿到，进度看镜头格蒙版 + 标题栏按钮
      this.up.open = false
      // 🔴 先把所有被选中的镜头置为「等待超分」，再逐个置「正在超分」——
      //    要一次性建好键，Vue 2 才能追踪后续的赋值（后加 key 不是响应式）
      const st = {}
      for (const it of this.upList) st[it.i] = picks.includes(it.i) ? 'wait' : ''
      this.up.st = st
      this.up.busy = true; this.up.stopping = false
      this.up.err = ''; this.up.total = picks.length; this.up.done = 0
      this.up.msg = '正在超分 1 / ' + picks.length
      const fails = []
      for (let n = 0; n < picks.length; n++) {
        // 用户中途切了集 / 点了停止：立刻收手，绝不把结果写到别的集的 videoState 里
        if (!this.ep || this.ep.id !== epId) { fails.push('已切换到别的集，剩余镜头未超分'); break }
        if (this.up.stopping) break
        const i = picks[n]
        const v = this.videoState[i] || {}
        const srcFile = (v.files && v.cur >= 0) ? (v.files[v.cur] || '') : ''
        if (!srcFile) { this.up.st[i] = 'fail'; fails.push('镜头 ' + (i + 1) + '：没有已选中的视频'); continue }
        this.up.st[i] = 'run'
        this.up.msg = '正在超分 镜头 ' + (i + 1) + '（' + (n + 1) + ' / ' + picks.length + ' · ' + scale + ' 倍）'
        try {
          const r = await window.studio.comfyUpscale({ file: dir + '\\' + srcFile, outDir, scale })
          if (!this.ep || this.ep.id !== epId) { fails.push('已切换到别的集，剩余镜头未超分'); break }
          // 🔴 rel = 相对「分镜」的路径：cells 用它拼绝对路径（少了 _upscale 这一层就会读不到文件）
          v.up = {
            file: r.file, rel: /[\\/]/.test(r.file) ? r.file : '_upscale\\' + r.file,
            res: r.width + 'x' + r.height, ms: r.elapsedMs, at: Date.now(), from: srcFile, scale
          }
          this.up.st[i] = ''   // 蒙版撤掉 → cells 立刻换成「超分视频」绿标
          this.up.done++
          await this.st.saveArtifact('videoState', this.videoState)
          this.syncCells()   // 立刻换成超分版预览（不再停在「加载中…」）
        } catch (e) {
          const m = String((e && e.message) || e)
          if (this.up.stopping || /已停止生成|已取消/.test(m)) {
            this.up.st[i] = ''      // 被用户停掉的这一镜不算失败，蒙版撤掉
            fails.push('镜头 ' + (i + 1) + '：已停止')
            break
          }
          this.up.st[i] = 'fail'
          fails.push('镜头 ' + (i + 1) + '：' + m)
        }
      }
      const stopped = this.up.stopping
      this.up.busy = false
      if (stopped) {
        // 停止：已完成保留（绿标留下），未跑完的蒙版撤掉
        this.up.err = ''
        this.up.msg = ''
        for (const k of Object.keys(this.up.st)) if (this.up.st[k] !== 'fail') this.up.st[k] = ''
        this.up.st = { ...this.up.st }
        this.$root.toast('已停止超分：完成 ' + this.up.done + ' 个镜头（成片会用已完成的超分版本）')
      } else if (!fails.length) {
        // 全成功 → 只留「超分视频」绿标
        this.up.msg = ''
        this.up.st = {}
        this.$root.toast('超分完成：' + this.up.done + ' 个镜头（成片会用超分版本）')
      } else {
        this.up.err = fails.join('\n\n')
        this.up.msg = '完成 ' + this.up.done + ' / ' + picks.length + ' 个，失败 ' + fails.length + ' 个'
      }
      this.up.stopping = false
      this.pruneSrc()
    },
    async loadList() {
      if (!this.ep) return
      const dir = this.ep.filmDir   // <项目>/成片（全项目共用）
      const pre = this.ep.prefix || ''   // 只列本集的成片（文件名 = <集名>_<时间戳>.mp4）
      try {
        // 元信息（时间/分辨率/导出耗时）与封面抽帧在主进程完成并缓存，目录没变化时几乎零开销
        const films = await window.studio.listMedia(dir, pre)
        if (this.ep && this.ep.filmDir !== dir) return   // 异步期间可能已切到别的集
        this.films = films
        // 🔴 分镜目录实测分辨率（2026-10-28）：扫一次拿每个镜头视频的真实画布，
        //    cells() 用「当前选中那版视频」的文件名查它，显示真实分辨率（二采档不再停旧值）。
        //    同样走 .meta.json 缓存，目录没变化时几乎零开销。
        const sdir = this.ep.shotDir
        this.shotMeta = {}
        if (sdir) {
          const shots = await window.studio.listMedia(sdir, '')   // 分镜目录不分前缀（单集目录）
          const m = {}
          for (const f of (Array.isArray(shots) ? shots : [])) {
            if (f.width) m[f.file] = { width: f.width, height: f.height }
          }
          this.shotMeta = m
        }
        // 与镜头模块一致：视频直接带播放控件展示。
        // 🔴 成片多次导出各自留档（2026-10-09）→ 只有**最新一版**需要预读 base64：
        //    历史成片不预加载，否则每多导一次就多几十 MB base64 常驻内存。
        if (films.length) this.loadVideo(films[0])
      } catch (e) { this.st.fail(e) }
    },
    /** 给「已选中镜头」的视频补读 base64（进模块即后台加载，加载完格子直接显示播放控件） */
    syncCells() {
      for (const c of this.cells) if (c.path) this.loadVideo({ path: c.path })
    },
    /** 清掉不再被成片格/镜头格引用的 base64 缓存（成片留档后只保留最新一版 + 当前镜头视频） */
    pruneSrc() {
      const keep = new Set()
      if (this.films.length) keep.add(this.films[0].path)   // 成片格只显示最新一版
      for (const c of this.cells) if (c.path) keep.add(c.path)
      Object.keys(this.srcMap).forEach(p => { if (!keep.has(p)) delete this.srcMap[p] })
    },
    /* 视频 base64 读取：进模块即后台加载，加载完卡片直接显示播放控件 */
    async loadVideo(it) {
      if (this.srcMap[it.path] || this.loadingSrc[it.path]) return
      this.loadingSrc[it.path] = true
      try {
        const b64 = await window.studio.readFileBase64(it.path)
        if (b64) this.srcMap[it.path] = 'data:video/mp4;base64,' + b64
      } catch (e) { /* 文件不存在（例如镜头视频被删）→ 保持占位符，不报错 */ }
      finally { delete this.loadingSrc[it.path] }
    },
    fmtTime(ms) {
      if (!ms) return '未知'
      const d = new Date(ms)
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    },
    res(it) { return it.width ? it.width + '×' + it.height : '未知' },
    /** 镜头格第 2 行的分辨率：该镜头生成视频时选的档位（未生成显示 —） */
    resText(v) { return v ? String(v).replace(/x/i, '×') : '—' },
    /** 成片时长：主进程用 ffprobe 实测的 durationSec */
    durText(f) { const d = f && f.durationSec; return d ? d.toFixed(1) + 's' : '—' },
    fmtSize(bytes) {
      const mb = bytes / 1024 / 1024
      return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB'
    },
    async exportFilm() {
      this.busy = true
      const t0 = Date.now()
      this.pl.beginGen(6)
      try {
        // 🔴 取 cells 而不是 videoState：cells 已经把「超分版本优先」算进去了 ——
        //    成片该用哪一版，只有 cells 这一个口径（与格子里显示的视频必须一致）。
        //    路径也用 cells 的绝对路径：超分版在 分镜/_upscale/ 子目录里，不能再拿 shotDir 硬拼。
        const videos = this.shots.map((s, i) => ({
          file: (this.cells[i] && this.cells[i].path) ? this.cells[i].path : '',
          dialogue: s.dialogue || '',
          dur: s.dur || 8
        }))
        const outDir = this.ep.filmDir   // <项目>/成片（全项目共用；按集名前缀隔离）
        const outName = this.ep.name + '_' + Date.now()
        // 「自动」= 不在渲染层猜分辨率：主进程探测**第一个镜头的真实画布**并据此拼装
        const auto = this.outRes === 'auto'
        const [rw, rh] = auto ? [0, 0] : parseRes(this.outRes)
        const out = await window.studio.exportVideo({
          outDir, outName, videos,
          subtitles: this.subsEnabled, width: rw, height: rh, autoRes: auto,
          // 方案 D：逐镜响度归一（勾选框控制；关掉 = 各镜原始音量）
          normalize: this.normEnabled,
          // 🔴 必须带 scope：导出时主进程会删「本集之外的旧成片」，缺了就会删掉别的集的成片
          scope: this.ep.prefix || this.ep.name
        })
        this.exportFile = out.split('\\').pop()
        this.pl.markGen(6, Date.now() - t0)
        this.st.invalidateMedia(this.ep.projectId, 'films')   // 左侧树「成片」下次展开刷新
        // ⚠️ 阶段 7 不做锁定（用户明确要求）：不再调 pl.confirm(6)，
        // 否则 done[6]=true → inert 生效 → 成片不能播放、按钮全部变灰。
        this.$root.toast('成片已导出：' + this.exportFile)
        await this.loadList()   // 导出完立刻刷新（最新一版进成片格）
        this.pruneSrc()         // 成片留档：只保留最新一版的 base64，早先几版及时释放
      } catch (e) { this.st.fail(e) } finally { this.busy = false; this.pl.endGen(6) }
    },
    reveal() {
      window.studio.revealFile((this.films.length ? this.films[0].path : this.ep.filmDir + '\\' + this.exportFile))
    }
  }
}
</script>

<style scoped>
/* 悬浮 tag：这一格用的是超分后的版本（叠在播放框左上角，不挡点击 —— 播放框是原生控件） */
.up-badge{
  position:absolute; top:6px; left:6px; z-index:3; pointer-events:none;
  font-size:11px; line-height:1; padding:4px 8px; border-radius:999px; font-weight:700;
  background:rgba(16,185,129,.92); color:#06291f; box-shadow:0 2px 8px rgba(0,0,0,.45);
}
/* 标题栏「导出成片」左边的超分小按钮：淡蓝描边胶囊（不抢视觉），跑起来变红 = 停止 */
/* 超分视频 = 标题栏里的次要操作：跟其它次要按钮同一套描边胶囊（方案 2：一行只留「导出成片」一个实心） */
/* 标题栏按钮统一走「方案 B 深蓝 + 亮蓝」全实心（scoped 选择器带属性选择器，优先级高于全局
   .stage-head .btn，所以这里必须写实心底色，否则会露出全局规则之下仍为透明） */
.btn.sec.up-btn{
  display:inline-flex; align-items:center; gap:5px;
  padding:4px 12px; font-size:11.5px; font-weight:500; line-height:1.35;
  border-radius:999px; border:1px solid #2b4d8f;
  background:#1e3a8a; color:#bfdbfe; box-shadow:none;
}
.btn.sec.up-btn:hover:not(:disabled){
  border-color:#4d7fd6; background:#1e40af; color:#e8f2ff;
  box-shadow:none; filter:none;
}
/* 运行中的「停止超分」：实心红，压住旁边的亮蓝「导出成片」 */
.btn.sec.up-btn.stop{
  background:#b91c1c; border-color:#ef4444; color:#fff;
}
.btn.sec.up-btn.stop:hover:not(:disabled){background:#dc2626; border-color:#f87171; color:#fff;}
.up-btn .spin{width:11px; height:11px; border-width:2px; border-color:rgba(255,255,255,.35); border-top-color:#fff;}

/* 等待 / 正在超分：半透明蒙版盖住画面（看得出还在，但不会误以为已经好了） */
.up-mask{
  position:absolute; inset:0; z-index:2; pointer-events:none;
  background:rgba(6,12,22,.55);
  backdrop-filter:blur(1.5px);
}
.up-chip{
  position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:3;
  display:inline-flex; align-items:center; gap:6px; pointer-events:none;
  font-size:12px; line-height:1; padding:7px 12px; border-radius:999px; font-weight:700;
  box-shadow:0 4px 14px rgba(0,0,0,.5); white-space:nowrap;
}
.up-chip.wait{background:rgba(148,163,184,.94); color:#0b1220;}
.up-chip.run{background:rgba(56,189,248,.96); color:#062231;}
.up-chip.fail{background:rgba(239,68,68,.95); color:#2a0b0b;}
.up-chip .spin{width:12px; height:12px; border-width:2px; border-color:rgba(6,34,49,.3); border-top-color:#062231;}

/* 导出设置弹窗：分辨率 / 字幕 / 响度归一 三行，确认后才开始拼 */
.ex-modal{width:min(500px,92vw);}
.ex-note{font-size:12px; color:var(--sub); line-height:1.7; margin-bottom:6px;}
.ex-note b{color:#9fd8f5;}
.ex-row{
  display:flex; align-items:center; gap:10px;
  padding:10px 0; border-top:1px solid var(--line-soft);
  font-size:12.5px; color:#c7d2e0; cursor:pointer;
}
.ex-k{flex:0 0 76px; color:#9fb0c8;}
.ex-tip{flex:1; font-size:11.5px; color:var(--sub); line-height:1.6;}
.ex-row input[type="checkbox"]{width:15px; height:15px; margin:0; accent-color:#38bdf8; cursor:pointer;}

/* 超分选择弹窗（只选镜头 + 倍率；开始后立即关闭） */
.up-modal{width:min(560px,94vw);}
.up-note{
  font-size:12px; color:var(--sub); line-height:1.75; margin-bottom:10px;
  background:rgba(56,189,248,.06); border:1px solid rgba(56,189,248,.2);
  border-radius:8px; padding:9px 12px;
}
.up-note p{margin:0 0 5px;}
.up-note p:last-of-type{margin-bottom:0;}
.up-note b{color:#bfe7fb; font-weight:600;}
.up-ref{
  margin-top:8px; padding-top:7px; font-size:11.5px; color:#8b95a9;
  border-top:1px dashed rgba(56,189,248,.22);
}
.up-ref b{color:#9fd8f5;}
.up-tools{display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:12px; color:#aab6c8;}
.up-all{display:flex; align-items:center; gap:6px; cursor:pointer;}
.up-scale{display:flex; align-items:center; gap:6px;}
.up-scale select{
  background:#0f141d; color:#dbe4f0; border:1px solid var(--line); border-radius:6px;
  padding:3px 6px; font-size:12px;
}
.up-list{
  max-height:260px; overflow:auto; border:1px solid var(--line-soft);
  border-radius:8px; background:#0f141d;
}
.up-row{
  display:flex; align-items:center; gap:10px; padding:7px 10px; cursor:pointer;
  font-size:12px; color:#c7d2e0; border-bottom:1px solid rgba(255,255,255,.04);
}
.up-row:last-child{border-bottom:none;}
.up-row.done{background:rgba(16,185,129,.06);}
.up-src{color:var(--sub);}
.up-tag{margin-left:auto; font-size:11px; color:#6ee7b7;}
.up-tag.pending{color:#8b94a6;}

/* 超分失败明细（只在有失败时出现；进度不在这里） */
.up-bar{
  display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  margin:0 0 12px; padding:8px 12px; font-size:12px; color:#c7d2e0;
  border:1px solid rgba(239,68,68,.42); border-radius:var(--r-sm);
  background:rgba(239,68,68,.07);
}
.up-txt{color:#c7d2e0;}
.up-txt.bad{color:#fca5a5;}
.up-err{
  flex:0 0 100%; margin:2px 0 0; max-height:140px; overflow:auto; white-space:pre-wrap;
  font-size:11.5px; line-height:1.7; color:#fca5a5; background:#1a1113;
  border:1px solid rgba(239,68,68,.25); border-radius:8px; padding:8px 10px;
}
</style>
