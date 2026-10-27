<template>
  <div class="vg-wrap">
    <!-- ═══ 左：参数面板 ═══ -->
    <div class="vg-panel">
      <div class="vg-scroll">

        <div class="vg-sec">
          <div class="vg-lab">提示词</div>
          <textarea class="vg-ta" v-model="prompt" rows="5"
                    placeholder="描述你想生成的视频：画面、人物、动作、台词、环境音、配乐……"></textarea>
          <div class="vg-rewrite">
            <label class="vg-chk"
                   title="用 MiniMax H3 官方提示词规范重写你的描述：补全镜头、运镜、台词、环境音与配乐等结构，让模型理解更准确、成片更贴合预期。开启后生成时自动重写，原始描述与改写结果都会保留，可在结果区「查看提示词」对比。">
              <span class="vg-sw" :class="{on: rewriteOn}" @click="rewriteOn=!rewriteOn"></span>
              <span class="vg-rw-t">提示词重写</span>
            </label>
            <span class="vg-rw-hint" v-if="!rewriteOn">关闭时按原文生成</span>
            <span class="vg-rw-hint on" v-else>开启后按官方规范自动重写</span>
          </div>
        </div>

        <div class="vg-sec">
          <div class="vg-lab">参考素材
            <span class="vg-hint">传什么决定生成方式，自动判定</span>
          </div>
          <!-- 🔴 视频生成页专属素材区（2026-10-23）：复用全局 .ref-thumb/.rtag/.img-x/.ref-add 缩略图样式，
               但容器从全局的「单行横向滚动」改成网格自动换行（.vg-ref-grid，仅本页生效，不动分镜脚本）。
               参考图/参考视频角标带编号（1、2、3…），对应 H3 提示词里的 <Picture N> / <Video N>。 -->
          <div class="ref-row vg-ref-grid">
            <!-- 参考图（编号 = 注入顺序 = <Picture N>） -->
            <div v-for="(r,i) in refImages" :key="'ri'+r.path" class="ref-thumb">
              <img v-if="!missing(r.path)" :src="imgSrc(r.path)" :title="r.path">
              <span v-else class="vg-miss-thumb">已缺失</span>
              <span class="rtag">参考图 {{ i+1 }}</span>
              <button class="img-x" title="移除" @click.stop="rmRef('refImages', i)">✕</button>
            </div>
            <button class="ref-add" title="从本地选参考图（可多选）" @click="pick('refImages')">＋参考图</button>

            <!-- 参考视频（编号 = <Video N>） -->
            <div v-for="(r,i) in refVideos" :key="'rv'+r.path" class="ref-thumb vid">
              <video v-if="!missing(r.path)" :src="imgSrc(r.path)" muted preload="metadata"></video>
              <span v-else class="vg-miss-thumb">已缺失</span>
              <span class="rtag vid">视频 {{ i+1 }}</span>
              <button class="img-x" title="移除" @click.stop="rmRef('refVideos', i)">✕</button>
            </div>
            <button class="ref-add wide" title="从本地选参考视频（可多选）" @click="pick('refVideos')">＋参考视频</button>

            <!-- 首帧 -->
            <div v-if="firstFrame" class="ref-thumb">
              <img v-if="!missing(firstFrame)" :src="imgSrc(firstFrame)" :title="firstFrame">
              <span v-else class="vg-miss-thumb">已缺失</span>
              <span class="rtag">首帧</span>
              <button class="img-x" title="移除首帧" @click.stop="firstFrame=''">✕</button>
            </div>
            <button v-else class="ref-add" title="选一张图作为首帧（视频开头画面）" @click="pickFirst">＋首帧</button>

            <!-- 尾帧 -->
            <div v-if="lastFrame" class="ref-thumb">
              <img v-if="!missing(lastFrame)" :src="imgSrc(lastFrame)" :title="lastFrame">
              <span v-else class="vg-miss-thumb">已缺失</span>
              <span class="rtag">尾帧</span>
              <button class="img-x" title="移除尾帧" @click.stop="lastFrame=''">✕</button>
            </div>
            <button v-else class="ref-add" title="选一张图作为尾帧（视频结尾画面）" @click="pickLast">＋尾帧</button>
          </div>
        </div>

        <div class="vg-sec">
          <div class="vg-lab">视频质量</div>
          <div class="vg-tier-list">
            <div class="vg-tier" v-for="g in tierGroups" :key="g.base">
              <div class="vg-tier-head">{{ tierGroupLabel(g) }}</div>
              <div class="vg-ab-row">
                <button type="button" v-if="g.a" class="vg-ab" :class="{on: tier===g.a.key}" @click="tier=g.a.key">
                  <b>剪枝版</b>
                  <span class="vg-ab-desc">{{ g.a.desc }}</span>
                </button>
                <button type="button" v-if="g.b" class="vg-ab" :class="{on: tier===g.b.key}" @click="tier=g.b.key">
                  <b>原始版</b>
                  <span class="vg-ab-desc">{{ g.b.desc }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="vg-sec">
          <div class="vg-lab">视频比例</div>
          <div class="vg-aspect">
            <button v-for="a in aspectOptions" :key="a.id" class="vg-asp" :class="{on: aspect===a.id}" @click="aspect=a.id">
              <b>{{ a.label }}<em class="vg-asp-res" v-if="aspectResLabel(a.id)">{{ aspectResLabel(a.id) }}</em></b>
            </button>
          </div>
        </div>

        <div class="vg-sec">
          <div class="vg-dur-row">
            <span class="vg-lab" style="margin-bottom:0">时长</span>
            <div class="vg-dur-input">
              <input class="vg-dur-num" type="number" min="4" max="15" step="1" v-model.number="seconds"
                     @blur="clampSeconds">
              <span class="vg-dur-unit">秒</span>
            </div>
            <span class="vg-hint">4-15秒</span>
          </div>
        </div>

      </div>

      <div class="vg-bottom">
        <div class="vg-mode" v-if="modeHint">已自动判定：{{ modeHint }}</div>
        <button class="btn vg-genbtn" :disabled="!canGen" @click="generate">
          生成视频
        </button>
      </div>
    </div>

    <!-- ═══ 右：结果画廊 ═══ -->
    <div class="vg-canvas">
      <div class="vg-cbar">
        <span class="vg-t">结果</span>
        <span class="vg-chip">本次 {{ results.length }} · 历史 {{ history.length }}</span>
        <span style="flex:1"></span>
        <button class="vg-tool" title="在资源管理器里打开视频产物目录" @click="openOutDir">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.6 4.2c0-.7.6-1.2 1.2-1.2h3l1.3 1.5h6.1c.7 0 1.2.6 1.2 1.2v6c0 .7-.6 1.2-1.2 1.2H2.8c-.7 0-1.2-.6-1.2-1.2V4.2z"/>
          </svg>
          <span>打开文件夹</span>
        </button>
      </div>
      <div class="vg-gallery">
        <div class="vg-flow">
          <!-- 🔴 多任务排队（2026-10-23）：按任务中心活跃列表渲染，每个任务一张卡片，区分「生成中/排队中」 -->
          <div v-for="t in vgTasks" :key="t.id" class="vg-tile genning" :class="{queued: t.status === 'queued'}">
            <i class="spin big"></i>
            <span class="g-txt">{{ t.status === 'running' ? (t.text || '生成中…') : '排队中…' }}</span>
            <button class="vg-stop" @click="stopTask(t.id)">取消</button>
          </div>
          <div v-for="r in resultsDesc" :key="r.path" class="vg-tile">
            <div class="vg-ph" @click="preview(r)">
              <video :src="imgSrc(r.path)" muted preload="metadata"></video>
              <span class="vg-tag">{{ tileMeta(r) }}</span>
              <span v-if="timeText(r)" class="vg-dur">{{ timeText(r) }}</span>
              <div class="vg-ov">
                <div class="vg-ovb">
                  <button class="vg-m" title="把这次生成的配置回填到左侧，继续微调" @click.stop="fillBack(r)">回填配置</button>
                  <button class="vg-m" title="查看这条视频的用户原提示词与重写后的提示词" @click.stop="viewPrompt(r)">查看提示词</button>
                  <button class="vg-m del" title="把这段视频从硬盘永久删除" @click.stop="askDelete(r, 'results')">删除</button>
                </div>
              </div>
            </div>
          </div>
          <div v-for="h in history" :key="h.path" class="vg-tile dim">
            <div class="vg-ph" @click="preview(h)">
              <video :src="imgSrc(h.path)" muted preload="metadata"></video>
              <span class="vg-tag">{{ tileMeta(h) }}</span>
              <span v-if="timeText(h)" class="vg-dur">{{ timeText(h) }}</span>
              <div class="vg-ov">
                <div class="vg-ovb">
                  <button class="vg-m" title="把这次生成的配置回填到左侧，继续微调" @click.stop="fillBack(h)">回填配置</button>
                  <button class="vg-m" title="查看这条视频的用户原提示词与重写后的提示词" @click.stop="viewPrompt(h)">查看提示词</button>
                  <button class="vg-m del" title="把这段视频从硬盘永久删除" @click.stop="askDelete(h, 'history')">删除</button>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!results.length && !history.length && !vgTasks.length" class="vg-tile empty">
            <span>还没有生成记录<br>左侧填好提示词点「生成视频」</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 查看提示词弹框（只读） ═══ -->
    <div class="vg-modal" v-if="promptView" @click.self="promptView=null">
      <div class="vg-modal-box">
        <div class="vg-modal-head">
          <span class="vg-modal-title">查看提示词</span>
          <button class="vg-modal-x" @click="promptView=null">✕</button>
        </div>
        <div class="vg-modal-body">
          <div class="vg-pb">
            <div class="vg-pb-lab">用户原提示词</div>
            <div class="vg-pb-text">{{ promptView.raw || '（无）' }}</div>
          </div>
          <div class="vg-pb">
            <div class="vg-pb-lab">重写后的提示词 <span class="vg-pb-tag" v-if="promptView.rewritten">按 H3 官方规范重写</span><span class="vg-pb-tag dim" v-else>本次未开启重写</span></div>
            <div class="vg-pb-text" :class="{empty: !promptView.rewritten}">{{ promptView.rewritten || '（本次生成未开启「提示词重写」，按原文生成）' }}</div>
          </div>
        </div>
        <div class="vg-modal-foot">
          <button class="btn ghost" @click="promptView=null">关闭</button>
        </div>
      </div>
    </div>

    <!-- ═══ 删除确认框 ═══ -->
    <div class="vg-modal" v-if="delAsk" @click.self="delAsk=null">
      <div class="vg-modal-box" style="width:460px">
        <div class="vg-modal-head">
          <span class="vg-modal-title">删除这段视频</span>
          <button class="vg-modal-x" @click="delAsk=null">✕</button>
        </div>
        <div class="vg-modal-body">
          <p class="vg-del-tip">确定要从硬盘<b>永久删除</b>这段视频吗？删除后不可恢复。</p>
          <p class="vg-del-path">{{ delAsk.path }}</p>
        </div>
        <div class="vg-modal-foot">
          <button class="btn ghost" @click="delAsk=null">取消</button>
          <button class="btn danger" @click="doDelete">确认删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/* 视频生成独立功能页（2026-10-22）。
 * 复刻「图片生成」页的布局（左参数面板 + 右结果画廊），但生成走 MiniMax H3 视频管线（与创作台同模型）。
 * 核心特性：
 *  1. 智能路由（纯自动）：有参考图/视频 → Ref2VA；首帧+尾帧 → FL2VA；仅首帧 → I2VA；仅尾帧 → L2VA；纯文字 → T2VA。
 *     判定只作「生成按钮上方的小提示语」，不提供手动切换。
 *  2. 视频质量 = 创作台同款三档 × A/B（剪枝版/原始版），直接吃 resTiers()（同一份注册表）。
 *  3. 生成 → 提交任务中心（taskCenter.submit），切菜单/切集不中断；侧栏闪点读 activeCount('vidgen')。
 *  4. 每次生成把「提示词 + 参考图/视频/首尾帧 + 档位 + 比例 + 时长」快照写进产物旁车 JSON（主进程写），
 *     结果区 hover「回填配置」一键把这版配置填回左侧。参考图/视频若文件已删/移走 → 打「已缺失」标记。
 *  5. 产物归档 <workspace>/视频生成/<日期>/，历史由 vidgen:history 列举（带真实分辨率/时长/快照）。 */
import { useProject as useProjectStore } from './stores/project.js'
import { vgState } from './vidgenState.js'
import { subscribe, submit, cancel, activeCount, activeTasks } from './taskCenter.js'
import { mediaUrl } from './mediaUrl.js'

const TYPE = 'vidgen'

export default {
  name: 'VideoGen',
  data() {
    return {
      prompt: '',
      refImages: [],      // [{path}]
      refVideos: [],      // [{path}]
      firstFrame: '',     // 单张路径
      lastFrame: '',
      tier: '',
      aspect: '16:9',
      seconds: 5,
      rewriteOn: false,   // 「提示词重写」开关：开启后用 H3 官方规范重写 prompt 再提交
      results: [],        // 本次会话产物 [{path, width, height, durationSec, ms, at, snapshot}]
      history: [],        // <workspace>/视频生成/ 历史产物
      promptView: null,   // 查看提示词弹框数据 {raw, rewritten}
      delAsk: null,       // 删除确认框数据 {path, from}（from='results'|'history'）
      _submitting: false, // 🔴 提交锁：健康检查/重写是异步 await，期间防止用户连点重复提交任务
      _missing: new Set() // 本次会话里探测过「文件不存在」的路径缓存（回填时打标记）
    }
  },
  computed: {
    st() { return useProjectStore() },
    today() {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    },
    tierOptions() { return this.st.tierOptions || [] },
    aspectOptions() { return this.st.aspectOptions || [{ id: '16:9', label: '横版 16:9' }, { id: '9:16', label: '竖版 9:16' }] },
    /** 复用 App.vue 的「档位分组」逻辑：三档 × A/B（key 去尾 a/b 同前缀归一组） */
    tierGroups() {
      const opts = this.tierOptions
      const groups = []
      const seen = new Set()
      for (const t of opts) {
        if (seen.has(t.key)) continue
        const m = /^(.*?)([ab])$/.exec(t.key)
        if (!m) { groups.push({ base: t.key, a: { key: t.key, label: t.label, desc: t.desc }, b: null }); continue }
        const base = m[1]
        const other = opts.find(x => x.key === base + (m[2] === 'a' ? 'b' : 'a'))
        const a = m[2] === 'a' ? t : other
        const b = m[2] === 'a' ? other : t
        seen.add(t.key); if (other) seen.add(other.key)
        groups.push({
          base,
          a: a ? { key: a.key, label: a.label, desc: a.desc } : null,
          b: b ? { key: b.key, label: b.label, desc: b.desc } : null
        })
      }
      return groups
    },
    /** 智能路由判定（纯自动，只作提示语） */
    modeHint() {
      const hasRef = this.refImages.length > 0 || this.refVideos.length > 0
      if (hasRef) {
        const bits = []
        if (this.refImages.length) bits.push('参考图×' + this.refImages.length)
        if (this.refVideos.length) bits.push('参考视频×' + this.refVideos.length)
        return '参考生视频 Ref2VA（' + bits.join('+') + '）'
      }
      if (this.firstFrame && this.lastFrame) return '首尾帧 FL2VA'
      if (this.firstFrame) return '首帧 I2VA'
      if (this.lastFrame) return '尾帧 L2VA'
      return '文生视频 T2VA'
    },
    canGen() {
      // 🔴 多任务排队（2026-10-23）：不再因为「有任务在跑」就禁用按钮。
      //    只要提示词非空、且当前这次点击还没提交完（_submitting 防连点）就可点。
      return this.prompt.trim().length > 0 && !this._submitting
    },
    /** 本次结果按生成时间倒序（最新在前） */
    resultsDesc() {
      return this.results.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
    },
    /** 本模块当前活跃任务（在跑 + 排队），进行中在前、排队在后。change 订阅会触发重渲染。 */
    vgTasks() {
      return activeTasks().filter(t => t.type === TYPE).map(t => ({
        id: t.id,
        status: t.status,           // running | queued
        label: t.label || '视频生成',
        text: t.text || ''
      })).sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1))
    }
  },
  watch: {
    'st.workspace'() { this.reloadHistory() }
  },
  async mounted() {
    // tierOptions 由 store 初始化时 loadResOptions() 填充；这里只在仍未加载时补一次
    if (!this.st.tierOptions || !this.st.tierOptions.length) {
      try { this.st.tierOptions = (await window.studio.resTiers()) || []; } catch (_) {}
    }
    if (!this.tier) this.tier = (this.tierOptions.find(t => t.default) || this.tierOptions[0] || {}).key || ''
    this.reloadHistory()
    // 订阅任务中心事件：本地正在跑的任务结束 → 刷新结果；进度 → 更新侧栏悬浮文案
    this._offDone = subscribe('done', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offFail = subscribe('fail', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offCancel = subscribe('cancel', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offProgress = subscribe('progress', t => { if (t && t.task && t.task.type === TYPE) this.onTaskProgress(t.task) })
    // 🔴 侧栏闪点统一走 change 事件重算（2026-10-23）：done/fail/cancel 事件的 emit 发生在
    //    bumpType(-1) 之前，那时 activeCount 还是 1 → 在 done 里算会误判成「还有任务」导致圆点常亮。
    //    change 事件在 finally 的 bumpType(-1) 之后 emit，读到的 activeCount 才是准的。
    this._offChange = subscribe('change', () => {
      vgState.busy = activeCount(TYPE) > 0
      if (!vgState.busy) vgState.text = ''
    })
    // 切回本页时若有任务在跑 → 结果区任务卡片由 vgTasks 直接读任务中心，无需恢复本地状态
  },
  beforeUnmount() {
    this._offDone && this._offDone()
    this._offFail && this._offFail()
    this._offCancel && this._offCancel()
    this._offProgress && this._offProgress()
    this._offChange && this._offChange()
  },
  methods: {
    onShow() { this.reloadHistory() },
    imgSrc(abs) { return mediaUrl(abs) },
    /** 档位分组名：取该组 A/B 任一 label，去掉尾部 A/B 后缀（label 形如「速度优先A」） */
    tierGroupLabel(g) {
      const lbl = (g.a && g.a.label) || (g.b && g.b.label) || g.base
      return String(lbl).replace(/[AB]$/, '')
    },
    aspectResLabel(aspectId) {
      const t = this.tierOptions.find(x => x.key === this.tier)
      const c = (t && t.canvas) || {}
      return c[aspectId] || ''
    },
    async pick(kind) {
      const ext = kind === 'refVideos' ? 'video' : 'image'
      const picked = await window.studio.pickFiles(ext)
      for (const p of (picked || [])) {
        if (this[kind].some(r => r.path === p)) continue
        this[kind].push({ path: p })
      }
    },
    async pickFirst() { const p = await window.studio.pickFiles('image'); if (p && p[0]) this.firstFrame = p[0] },
    async pickLast() { const p = await window.studio.pickFiles('image'); if (p && p[0]) this.lastFrame = p[0] },
    rmRef(kind, i) { this[kind].splice(i, 1) },
    /** 时长输入框失焦时夹取到 4~15（整数） */
    clampSeconds() {
      const v = Number(this.seconds)
      if (!Number.isFinite(v)) { this.seconds = 5; return }
      this.seconds = Math.max(4, Math.min(15, Math.round(v)))
    },
    /** 判断某路径的文件是否已不存在（回填/缩略图用）。结果缓存到 _missing，避免重复 IPC。 */
    missing(path) {
      if (!path) return false
      if (this._missing.has(path)) return true
      // 首次判断：异步探测，先返回 false（缩略图正常加载），探测到缺失再置位
      this._probeMissing(path)
      return false
    },
    async _probeMissing(path) {
      if (this._missing.has(path) || this._probing && this._probing[path]) return
      this._probing = this._probing || {}
      this._probing[path] = true
      try {
        const st = await window.studio.fileStat(path)
        if (!st || !st.exists) { this._missing.add(path); this.$forceUpdate() }
      } catch (_) { this._missing.add(path); this.$forceUpdate() }
    },
    /** 右上角 tag：分辨率 · 视频时长（秒）。视频时长优先 ffprobe 探测值，其次本次请求的秒数。 */
    tileMeta(r) {
      const bits = []
      if (r.width && r.height) bits.push(r.width + '×' + r.height)
      if (r.durationSec) bits.push((+r.durationSec).toFixed(1) + 's')
      return bits.join(' · ')
    },
    /** 左下角胶囊：生成时间 · 生成时长（本次生成消耗的秒数）。 */
    timeText(r) {
      const ms = Number(r && (r.at || r.mtimeMs)) || 0
      if (!ms) return ''
      const d = new Date(ms)
      const p = n => String(n).padStart(2, '0')
      const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      // 生成时长（耗时）：r.ms（主进程 elapsedMs）存在则拼在时间后面
      const genMs = Number(r.ms) || 0
      return genMs > 0 ? stamp + ' · ' + (genMs / 1000).toFixed(1) + 's' : stamp
    },
    preview(r) {
      const file = String(r.path).split(/[\\/]/).pop()
      this.$root.openPreview({ file, path: r.path }, 'video', '视频生成')
    },
    reveal(p) { window.studio.revealFile(p) },
    openOutDir() { window.studio.openPath(this.st.workspace + '\\视频生成\\' + this.today) },
    // 统一走全局底部悬浮 toast（App.vue 的 this.$root.toast），别再内联到「生成视频」按钮下方
    toast(msg, ms) { if (this.$root && this.$root.toast) this.$root.toast(msg, ms) },
    async reloadHistory() {
      try {
        const list = await window.studio.vidHistory(this.st.workspace) || []
        const have = new Set(this.results.map(r => r.path))
        this.history = list.filter(f => !have.has(f.path))
      } catch (_) { this.history = [] }
    },
    /** 取消单个任务（排队中的立即取消；进行中的标记取消 + 中断 ComfyUI） */
    stopTask(id) {
      cancel(id)
      // 取消的是正在跑的那个 → 同步中断底层 ComfyUI（否则要等当前步跑完才停）
      const running = activeTasks().find(t => t.type === TYPE && t.status === 'running' && t.id === id)
      if (running) window.studio.comfyCancel('full')
    },
    /** 停止全部：取消所有本模块任务 + 中断 ComfyUI */
    stop() {
      // 取消当前 vidgen 任务：任务中心标记取消 + 底层中断 ComfyUI
      const tasks = (this._stTaskIds || [])
      for (const id of tasks) cancel(id)
      window.studio.comfyCancel('full')
    },
    onTaskProgress(task) {
      // 结果区任务卡片的文案直接读任务中心的 task.text，这里只同步侧栏悬浮文案
      vgState.text = task.text || '出视频中'
    },
    onTaskDone(task) {
      // vgState.busy 由 change 订阅统一维护（时序正确），这里只负责把产物回填进结果区
      vgState.text = ''
      if (task && task.status === 'done' && task.result && task.result.videos) {
        for (const v of task.result.videos) this.results.push(v)
        this.reloadHistory()
      } else if (task && task.error && !/已停止生成|已取消|SKIP_CANCELLED/.test(String(task.error.message || task.error))) {
        this.toast('生成失败：' + (task.error.message || task.error))
      }
    },
    /** 回填配置：把某条结果记录的生成快照填回左侧输入区 */
    async fillBack(r) {
      const s = r.snapshot
      if (!s) { this.toast('这条记录没有保存配置快照'); return }
      this.prompt = s.prompt || ''
      this.refImages = (s.refImages || []).map(p => ({ path: p }))
      this.refVideos = (s.refVideos || []).map(p => ({ path: p }))
      this.firstFrame = s.firstFrame || ''
      this.lastFrame = s.lastFrame || ''
      if (s.tier) this.tier = s.tier
      if (s.aspect) this.aspect = s.aspect
      if (s.seconds) this.seconds = s.seconds
      if (s.promptRewritten) this.rewriteOn = true
      this._missing = new Set()
      // 立即探测参考图/视频是否还存在，缺失的打标记
      for (const p of [...this.refImages.map(x => x.path), ...this.refVideos.map(x => x.path), this.firstFrame, this.lastFrame].filter(Boolean)) {
        this._probeMissing(p)
      }
      this.toast('已回填这版生成配置，可继续微调')
    },
    /** 查看提示词弹框：显示用户原提示词 + 重写后的提示词（只读） */
    viewPrompt(r) {
      const s = r.snapshot || {}
      this.promptView = {
        raw: s.prompt || '',
        rewritten: s.promptRewritten || ''
      }
    },
    /** 删除入口：弹确认框（记录来源，删除后只从对应数组局部移除，不整页重读） */
    askDelete(r, from) {
      this.delAsk = { path: r.path, from }
    },
    /** 确认删除：删主文件 + 同名 .json 旁车（存生成快照），然后只从对应数组 splice 掉这一项 */
    async doDelete() {
      const d = this.delAsk
      if (!d) return
      this.delAsk = null
      const abs = d.path
      try {
        await window.studio.deleteFile(abs)
        // 一并删旁车（<文件名>.json）：留着会成为孤儿，历史回读时读到没有主文件的快照
        try { await window.studio.deleteFile(abs + '.json') } catch (_) { /* 旁车可能本就不存在 */ }
        // 🔴 局部刷新：只移除被删那一项（按 path 定位），不 reloadHistory 全量重读
        if (d.from === 'results') {
          const i = this.results.findIndex(r => r.path === abs)
          if (i >= 0) this.results.splice(i, 1)
        } else {
          const i = this.history.findIndex(h => h.path === abs)
          if (i >= 0) this.history.splice(i, 1)
        }
        this.toast('已删除这段视频')
      } catch (e) {
        this.toast('删除失败：' + ((e && e.message) || e))
      }
    },
    async generate() {
      if (!this.canGen) return
      this.clampSeconds()   // 生成前夹取秒数到 4~15，防输入越界值直接点生成
      // 🔴 提交锁（2026-10-23）：健康检查 + 提示词重写都是异步 await，期间用户可能再点一次「生成视频」。
      //    用独立的 _submitting 锁防重入；注意不要用 running（running 现在表示「有任务在跑/排队」，
      //    多任务场景下生成中也要允许继续点，所以按钮只依赖 canGen = prompt 非空 && !_submitting）。
      this._submitting = true
      try {
        // —— 生成前先检查 ComfyUI 是否启动：没启动就提示手动启动，不提交任务 ——
        // （否则任务会卡在「提交前对账」的超时链上，用户点停止也停不掉）
        try {
          const h = await window.studio.inferHealth()
          if (h && h.comfyui === false) {
            this.toast('检测到 ComfyUI 还没启动，暂时无法生成视频。请先打开 ComfyUI Desktop（桌面版）等它进入主界面，再回到本页点「生成视频」即可，软件会自动接管。', 5200)
            return
          }
        } catch (_) {
          // 健康探测本身失败（IPC 异常等）不阻断生成，交给提交阶段的报错兜底
        }
        const dir = this.st.workspace + '\\视频生成\\' + this.today
        // 解析档位推荐画布（宽高）；取不到回退 864×480
        const t = this.tierOptions.find(x => x.key === this.tier)
        const canvas = (t && t.canvas && t.canvas[this.aspect]) || '864x480'
        const [w, h] = String(canvas).split('x').map(n => Number(n) || 0)
        const width = w || 864, height = h || 480
        const rawPrompt = this.prompt.trim()
        // —— 提示词重写（H3 官方规范）：开启时先把用户原文重写成结构化提示词 ——
        let finalPrompt = rawPrompt
        let rewritten = ''
        if (this.rewriteOn) {
          try {
            rewritten = await this.rewritePrompt(rawPrompt)
            if (rewritten) finalPrompt = rewritten
          } catch (e) {
            // 重写失败不阻断生成：退回原文，并提示用户
            this.toast('提示词重写失败，已按原文生成：' + ((e && e.message) || e))
          }
        }
        // 生成快照：本次生成的完整配置（写进产物旁车，供「回填配置」「查看提示词」用）
        const snapshot = {
          prompt: rawPrompt,                // 用户原提示词
          promptRewritten: rewritten,       // 重写后的提示词（未开启/失败时为空串）
          refImages: this.refImages.map(r => r.path),
          refVideos: this.refVideos.map(r => r.path),
          firstFrame: this.firstFrame,
          lastFrame: this.lastFrame,
          tier: this.tier,
          aspect: this.aspect,
          seconds: this.seconds
        }
      // 转纯对象送 IPC（避免响应式 Proxy 无法结构化克隆）
      const params = JSON.parse(JSON.stringify({
        prompt: finalPrompt,              // 发给模型的提示词（重写后或原文）
        refImages: this.refImages.map(r => r.path),
        refVideos: this.refVideos.map(r => r.path),
        firstFrame: this.firstFrame,
        lastFrame: this.lastFrame,
        width, height,
        seconds: this.seconds,
        tier: this.tier,
        aspect: this.aspect,
        snapshot
      }))
      const t0 = Date.now()
      const durSec = Number(this.seconds) || 5
      // —— 打印本次提交（调试用，Dragon 要求）：明确区分「发给模型」与「本地参数」——
      const dbgPrompt = [
        '========== 视频生成 · 提交 ==========',
        '▶ 发给模型的提示词（唯一文字输入）：',
        '    ' + (params.prompt || '（空）'),
        (rewritten ? '    （已按 H3 官方规范重写，原始描述见下）\n    原始：' + rawPrompt : ''),
        '▶ 本地参数（不发给模型，只决定怎么跑）：',
        '    分辨率 ' + width + '×' + height + ' · 时长 ' + durSec + ' 秒 · 档位 ' + this.tier + ' · ' + this.aspect,
        '    参考图：' + (params.refImages.length ? params.refImages.join('、') : '无'),
        '    参考视频：' + (params.refVideos.length ? params.refVideos.join('、') : '无'),
        '    首帧：' + (params.firstFrame || '无') + ' · 尾帧：' + (params.lastFrame || '无'),
        '========================================'
      ].join('\n')
      console.log(dbgPrompt)
      try { window.studio.logUi('视频生成', dbgPrompt, 'info') } catch (_) {}
      const id = submit({
        label: '视频生成 · ' + this.modeHint,
        type: TYPE,
        episodeId: null,   // 独立页，不绑集
        run: async (report) => {
          report({ done: 0, total: 1, label: '生成中…' })
          const r = await window.studio.comfyGenerate({
            templateKey: 'video',
            dir,
            baseName: 'vidgen_' + Date.now(),
            params,
            label: '视频生成'
          })
          // 生成时长优先用主进程给的 elapsedMs（与落盘 sidecar 同源）；没有就本地兜底
          const ms = (r && r.elapsedMs) || (Date.now() - t0)
          const videos = []
          for (const f of (r && r.files) || []) {
            const abs = /^[a-zA-Z]:[\\/]/.test(f) ? f : dir + '\\' + f
            videos.push({ path: abs, width, height, durationSec: durSec, ms, at: Date.now(), snapshot })
          }
          return { videos }
        }
      })
      // 记下任务 id 供 stop() 用
      this._stTaskIds = this._stTaskIds || []
      this._stTaskIds.push(id)
      // 任务跑完由 onTaskDone 收尾；这里不直接 await（交给任务中心串行调度）
      // 🔴 提交成功后清空提示词与参考素材：让用户能立刻输入下一个任务（多任务排队）。
      //    （快照已存进 params.snapshot，结果区「回填配置」能找回这一次的输入）
      this.prompt = ''
      this.refImages = []
      this.refVideos = []
      this.firstFrame = ''
      this.lastFrame = ''
      } finally {
        // 无论成功/失败/健康检查拦截，都释放提交锁，允许下一次点击
        this._submitting = false
      }
    },
    /** 用 H3 官方规范重写提示词（走 llmChat，云端/本地大模型） */
    async rewritePrompt(raw) {
      const hasRef = this.refImages.length > 0 || this.refVideos.length > 0
      const isFirstLast = !hasRef && this.firstFrame && this.lastFrame
      const mode = hasRef ? 'Ref2VA（参考图/视频生视频）'
        : isFirstLast ? 'FL2VA（首尾帧生视频）'
        : this.firstFrame ? 'I2VA（首帧生视频）'
        : this.lastFrame ? 'L2VA（尾帧生视频）'
        : 'T2VA（文生视频）'
      const system = [
        '你是 MiniMax H3 视频生成提示词重写专家。请把用户的视频需求，重写成 H3 官方规范的结构化提示词。',
        '',
        '## 当前模式：' + mode,
        '## 目标时长：' + this.seconds + ' 秒（描述的时间轴必须落在该时长内）',
        '',
        '## 重写规则（务必遵守）：',
        hasRef
          ? '- 参考生视频（Ref2VA）六段式，按顺序输出：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music。'
          : '- 基础模式三段式，按顺序输出：integrated_multimodal_description / overall_soundscape / non_diegetic_music。',
        '- 正文用英文写；对白、歌词、屏幕可见文字保留原文（中文就写中文）。',
        '- 用 [Shot 1] 开头（不加时间戳），后续镜头用 [Shot 2] At MM:SS.mmm, ... 标记切换点，时间递增且落在时长内。',
        '- 每个镜头写清：构图、主体位置、环境与光线、动作、运镜（动作类型+幅度+速度）、声音。',
        (hasRef ? '- 🔴 有参考图时，主体的外观（发型、发色、服装、身材、肤色、配饰）**一律不要描述、不要猜测**——它们由参考图决定。只写主体的动作、位置、情绪与运镜。' : ''),
        '- 说话人用稳定 ID 如 (S1)；对白写 <d>[语言] 内容</d>；画外音写 says in an off-screen voiceover。',
        '- overall_soundscape 用 1~4 句英文总结环境音/动作音/非语言人声；non_diegetic_music 用 1~3 句写配乐，没有则 N/A。',
        '- 优先写具体可感的细节，避免 cinematic、beautiful 这类抽象词。',
        '',
        hasRef
          ? [
            '## 🔴 参考素材引用规范（Ref2VA 模式强制，绝不可违反）：',
            '模型实际收到的参考图/参考视频已按「<Picture 1>/<Picture 2>…（参考图）、<Video 1>/<Video 2>…（参考视频）」编号注入，编号见下方「用户需求」里的素材清单。',
            '1. subject_definitions 里，每个可复用主体必须定义成 <Subject N>，并在定义内用 <Picture N> 或 <Video N> 指明它来自哪张图/哪段视频。例如：`<Subject 1> is the fighter in <Picture 1>.` 或 `<Subject 2> is the fighter in <Picture 2>.`',
            '2. 🔴 **绝不要描述或猜测参考图里主体的外观**（发型、发色、服装颜色/样式、身材、肤色、配饰、是否戴拳套/缠手带等）——你看不到图片，猜出来的都是错的，会覆盖参考图的真实长相。定义句只写「<Subject N> is the ... in <Picture N>」并点明角色身份（如 female fighter），外观交给参考图本身。',
            '3. 用户原文里若写了「图1/图2/第1张图」等说法，一律对应到素材清单里的 <Picture N>；用户若给人物起了名字（如 A、B），名字只是便于你理解，输出时必须把它们写进对应 <Subject N> 的定义，绝不能直接用 A:/B: 当标签。',
            '4. 同一个主体的多张参考图（不同视角）必须合并成一个 <Subject N>，在定义里一次列出全部来源，如 `<Subject 1> is the car shown in <Picture 1>-<Picture 3>, front, side and rear views of the same vehicle.`',
            '5. 只有人物类 <Subject N> 能说话（挂 (Sx) 音色槽）；场景/道具/动作类 Subject 永不分配音色槽、永不持有台词。',
            '6. 禁止自造任何别的身份标签；reference 关系一律通过 <Subject N> ↔ <Picture N>/<Video N> 表达。'
          ].join('\n')
          : '',
        '',
        '只输出重写后的提示词正文，不要任何解释、前缀或 Markdown 代码块围栏。'
      ].filter(s => s !== '').join('\n')

      // 🔴 2026-10-23 修复：把参考素材清单喂给大模型，否则它不知道「图1/图2」对应什么，
      //    会自造 A:/B: 这类标签，导致 <Picture N> 引用缺失、参考图失效。
      const refList = []
      this.refImages.forEach((r, i) => {
        refList.push('<Picture ' + (i + 1) + '> = 第 ' + (i + 1) + ' 张参考图')
      })
      this.refVideos.forEach((r, i) => {
        refList.push('<Video ' + (i + 1) + '> = 第 ' + (i + 1) + ' 段参考视频')
      })
      const user = '用户需求：' + raw +
        (refList.length ? '\n\n【参考素材清单（模型实际收到的注入顺序，编号不可改动）】\n' + refList.join('\n') : '')
      const text = await window.studio.llmChat([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], { temperature: 0.5, maxTokens: 8192, stage: 'vidgen-rewrite', label: '视频生成·提示词重写', timeoutMs: 180000 })
      const out = (text || '').trim()
      if (!out) throw new Error('大模型没有返回重写结果')
      return out
    }
  }
}
</script>

<style scoped>
.vg-wrap{display:grid;grid-template-columns:390px 1fr;gap:14px;height:100%;min-height:0;}
.vg-panel{background:var(--card);border:1px solid var(--line-soft);border-radius:var(--r-lg);display:flex;flex-direction:column;min-height:0;}
.vg-scroll{flex:1;overflow-y:auto;padding:14px;}
.vg-sec{margin-bottom:16px;}
.vg-lab{font-size:11px;font-weight:600;color:var(--sub);letter-spacing:.12em;margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.vg-hint{font-weight:400;letter-spacing:0;color:var(--sub-2);}
.vg-ta{width:100%;background:#0e1320;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:9px 11px;font:12.5px/1.6 inherit;resize:vertical;}
.vg-ta:focus{outline:none;border-color:var(--blue);}
.vg-ta::placeholder{color:var(--sub-2);}
/* 参考素材：复用全局 .ref-thumb / .rtag / .img-x / .ref-add 缩略图样式（与分镜脚本同源）。
   这里补三样：① 网格换行容器（覆盖全局 .ref-row 的单行横向滚动，仅本页生效）；
   ② 「文件已缺失」占位；③ 视频缩略图容器。 */
.vg-ref-grid{
  display:flex; flex-wrap:wrap; overflow-x:visible; overflow-y:visible;
  height:auto; align-items:flex-start; align-content:flex-start;
}
.vg-miss-thumb{font-size:10px;color:var(--warn);display:flex;align-items:center;justify-content:center;width:100%;height:100%;text-align:center;line-height:1.3;padding:2px;}
.ref-thumb video{width:100%;height:100%;object-fit:contain;background:#0b0f16;border-radius:6px;display:block;}
/* 视频质量：三档 × A/B */
.vg-tier-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;}
.vg-tier{border:1px solid var(--line);border-radius:10px;padding:9px;}
.vg-tier-head{font-size:12.5px;font-weight:600;color:#dbe5f5;margin-bottom:6px;}
.vg-ab-row{display:flex;flex-direction:column;gap:6px;}
.vg-ab{display:flex;flex-direction:column;align-items:flex-start;gap:2px;background:#161d2a;border:1px solid #2c3646;border-radius:8px;padding:7px 8px;cursor:pointer;text-align:left;width:100%;transition:border-color .15s,background .15s;}
.vg-ab:hover{border-color:var(--blue);}
.vg-ab b{font-size:11.5px;font-weight:600;color:#dbe5f5;}
.vg-ab-desc{font-size:10px;line-height:1.5;color:#7f8ea8;}
.vg-ab.on{border-color:var(--blue);background:rgba(37,99,235,.14);}
.vg-ab.on b{color:#fff;}
/* 视频比例 */
.vg-aspect{display:flex;gap:8px;}
.vg-asp{flex:1;background:#161d2a;border:1px solid #2c3646;border-radius:8px;padding:7px 9px;cursor:pointer;text-align:left;}
.vg-asp b{font-size:12px;font-weight:600;color:#dbe5f5;display:flex;flex-direction:column;gap:2px;}
.vg-asp-res{font-size:10px;color:#7f8ea8;font-style:normal;font-weight:400;}
.vg-asp.on{border-color:var(--blue);background:rgba(37,99,235,.14);}
.vg-asp.on b{color:#fff;}
/* 时长 */
.vg-dur-row{display:flex;align-items:center;gap:12px;}
.vg-dur-input{display:flex;align-items:center;gap:8px;}
.vg-dur-num{width:120px;background:#0e1320;border:1px solid var(--line);border-radius:8px;color:var(--text);padding:7px 10px;font-size:13px;}
.vg-dur-num:focus{outline:none;border-color:var(--blue);}
.vg-dur-unit{font-size:12px;color:var(--sub);}
/* 底部 */
.vg-bottom{margin:0 14px 6px;}
.vg-mode{font-size:11px;color:var(--sub-2);text-align:center;margin-bottom:8px;}
.vg-genbtn{width:100%;padding:9px 18px;font-size:13.5px;letter-spacing:.14em;}
.vg-gensub{text-align:center;font-size:11px;color:var(--sub-2);margin:6px 14px 12px;}
.vg-stop{font-size:11px;color:var(--warn);background:none;border:none;cursor:pointer;margin-left:8px;}
/* 结果画廊（复刻图片生成） */
.vg-canvas{background:var(--card);border:1px solid var(--line-soft);border-radius:var(--r-lg);display:flex;flex-direction:column;min-height:0;}
.vg-cbar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line-soft);flex-shrink:0;}
.vg-t{font-weight:500;font-size:13px;}
.vg-chip{font-size:11px;color:var(--sub);border:1px solid var(--line);border-radius:20px;padding:1px 10px;}
.vg-tool{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1;color:#a9bdd8;background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.26);border-radius:999px;padding:6px 13px 6px 11px;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}
.vg-tool svg{width:13px;height:13px;fill:currentColor;opacity:.85;}
.vg-tool:hover{color:#fff;background:rgba(96,165,250,.16);border-color:rgba(96,165,250,.55);}
.vg-gallery{flex:1;overflow-y:auto;padding:14px;}
/* 结果格子自适应铺满：随结果区宽度自动排布，左右不留白（2026-10-22 Dragon 要求） */
.vg-flow{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));grid-auto-rows:200px;gap:12px;align-content:start;}
.vg-tile{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--line-soft);background:#0e1320;height:100%;}
.vg-tile.dim{opacity:.82;}
.vg-ph{position:relative;width:100%;height:100%;cursor:pointer;}
.vg-ph video{width:100%;height:100%;object-fit:cover;display:block;background:#0e1320;}
.vg-tag{position:absolute;top:8px;right:8px;font-size:10.5px;padding:2px 8px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);white-space:nowrap;}
.vg-dur{position:absolute;left:8px;bottom:8px;font-size:10.5px;padding:2px 9px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);white-space:nowrap;font-variant-numeric:tabular-nums;pointer-events:none;}
.vg-ov{position:absolute;left:0;right:0;bottom:0;padding:18px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;flex-direction:column;gap:6px;opacity:0;transition:.15s;}
.vg-tile:hover .vg-ov{opacity:1;}
.vg-ovb{display:flex;flex-wrap:wrap;justify-content:center;gap:5px;}
.vg-m{font-size:11px;color:#dbe4f0;background:rgba(255,255,255,.12);border:none;border-radius:6px;padding:2px 8px;cursor:pointer;}
.vg-m:hover{background:rgba(59,130,246,.5);color:#fff;}
.vg-m.del:hover{background:rgba(239,68,68,.6);color:#fff;}
/* 删除确认框 */
.vg-del-tip{font-size:13px;line-height:1.7;color:var(--text);}
.vg-del-tip b{color:var(--danger);}
.vg-del-path{font-size:11.5px;color:var(--sub-2);word-break:break-all;background:#0e1320;border:1px solid var(--line);border-radius:8px;padding:8px 10px;line-height:1.6;}
.vg-tile.genning{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border-style:dashed;border-color:rgba(96,165,250,.4);height:100%;}
/* 排队中的任务卡片：转圈变暗、描边变淡，与「生成中」区分 */
.vg-tile.genning.queued{border-color:rgba(148,163,184,.3);}
.vg-tile.genning.queued .spin.big{border-color:rgba(148,163,184,.2);border-top-color:rgba(148,163,184,.5);}
.vg-tile.genning.queued .g-txt{color:var(--sub-2);}
.vg-tile.genning .spin.big{width:22px;height:22px;border-width:3px;}
.vg-tile.genning .g-txt{font-size:12px;color:var(--sub);text-align:center;line-height:1.6;}
.vg-tile.empty{display:flex;align-items:center;justify-content:center;color:var(--sub-2);font-size:12px;text-align:center;line-height:1.8;border-style:dashed;min-height:240px;grid-column:1 / -1;}
/* 提示词重写开关 */
.vg-rewrite{display:flex;align-items:center;gap:10px;margin-top:8px;}
.vg-chk{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--sub);cursor:pointer;}
.vg-rw-t{font-size:12.5px;color:var(--sub);white-space:nowrap;}
.vg-rw-hint{font-size:11px;color:var(--sub-2);}
.vg-rw-hint.on{color:var(--blue-hi);}
.vg-sw{width:32px;height:18px;border-radius:10px;background:#232c3d;position:relative;transition:.15s;flex-shrink:0;display:inline-block;cursor:pointer;}
.vg-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#7d8798;transition:.15s;}
.vg-sw.on{background:var(--grad-deep);}
.vg-sw.on::after{left:16px;background:#fff;}
/* 查看提示词弹框（只读） */
.vg-modal{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:200;}
.vg-modal-box{width:640px;max-width:92vw;max-height:84vh;background:var(--card);border:1px solid var(--line);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;}
.vg-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line-soft);flex-shrink:0;}
.vg-modal-title{font-size:14px;font-weight:600;color:var(--text);}
.vg-modal-x{background:none;border:none;color:var(--sub);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px;}
.vg-modal-x:hover{color:var(--text);background:rgba(255,255,255,.08);}
.vg-modal-body{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:16px;}
.vg-pb{display:flex;flex-direction:column;gap:8px;}
.vg-pb-lab{font-size:12px;font-weight:600;color:var(--sub);letter-spacing:.05em;display:flex;align-items:center;gap:8px;}
.vg-pb-tag{font-size:10.5px;color:var(--blue-hi);border:1px solid rgba(96,165,250,.35);border-radius:10px;padding:1px 8px;font-weight:400;letter-spacing:0;}
.vg-pb-tag.dim{color:var(--sub-2);border-color:var(--line);}
.vg-pb-text{background:#0e1320;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.7;color:var(--text);white-space:pre-wrap;word-break:break-word;}
.vg-pb-text.empty{color:var(--sub-2);}
.vg-modal-foot{display:flex;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--line-soft);flex-shrink:0;}
</style>
