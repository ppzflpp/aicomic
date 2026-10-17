<template>
  <div class="ig-wrap">
    <!-- ═══ 左：参数面板 ═══ -->
    <div class="ig-panel">
      <div class="ig-scroll">

        <div class="ig-sec">
          <div class="ig-lab">参考图
            <span class="ig-hint">不传 = 文生图 · 传图 = 以图为准 · {{ refs.length }}/10</span>
          </div>
          <div class="ig-refs">
            <div v-for="(r,i) in refs" :key="r.path" class="ig-ref full">
              <img :src="imgSrc(r.path)" title="点击放大查看" @click="preview(r)">
              <button class="ig-refx" title="移除" @click.stop="rmRef(i)">✕</button>
              <!-- 提示词反推：常驻悬浮在图片下方（本地 Qwen3.5 + mmproj 读图） -->
              <button class="ig-rev" :class="{on: r.busy}" :disabled="!!r.busy"
                      title="用本地大模型反推这张图的提示词" @click.stop="reverseRef(i)">
                <span v-if="r.busy" class="spin"></span>{{ r.busy ? '反推中…' : '反推提示词' }}
              </button>
            </div>
            <div v-if="refs.length<10" class="ig-ref add" title="添加参考图（可多选）" @click="addRefs">
              <span>＋</span><span>添加</span>
            </div>
          </div>
          <div class="ig-note" v-if="refs.length">多图写法：提示词里用「图1 / 图2 / 图3」引用 —— <a class="ig-ex" @click="fillExample">填入示例</a></div>
        </div>

        <div class="ig-sec">
          <div class="ig-lab">提示词 <a class="ig-ex" @click="fillExample">示例</a></div>
          <textarea class="ig-ta" v-model="prompt" :placeholder="modePlaceholder" rows="5"></textarea>
        </div>

        <div class="ig-sec">
          <div class="ig-lab">负面提示词</div>
          <textarea class="ig-ta sm" v-model="negative" rows="2"></textarea>
        </div>

        <div class="ig-sec">
          <div class="ig-lab">分辨率</div>
          <select class="ig-sel" v-model="res">
            <option v-for="o in resList" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>

        <div class="ig-sec">
          <div class="ig-lab">生成数量</div>
          <div class="ig-row">
            <div class="ig-cnt">
              <button v-for="n in 4" :key="n" class="popt" :class="{on: count===n}" @click="count=n"><b>{{ n }} 张</b></button>
            </div>
            <label class="ig-chk" style="margin-left:auto">
              <span class="ig-sw" :class="{on: lockSeed}" @click="lockSeed=!lockSeed"></span>锁定种子
            </label>
          </div>
          <input v-if="lockSeed" class="ig-seed" type="number" v-model.number="seed" placeholder="种子">
        </div>

        <div class="ig-sec">
          <div class="ig-lab">采样参数 <span class="ig-hint">采样器 euler · 2.1 推荐默认 25 步 / CFG 2.5</span></div>
          <div class="ig-row">
            <select class="ig-sel sm" v-model.number="steps" title="采样步数：越多越精细，越慢">
              <option :value="20">20 步</option><option :value="25">25 步</option>
              <option :value="30">30 步</option><option :value="40">40 步</option>
            </select>
            <select class="ig-sel sm" v-model.number="cfg" title="CFG 提示词强度：越高越贴提示词，过高会过饱和">
              <option :value="2">CFG 2.0</option><option :value="2.5">CFG 2.5</option>
              <option :value="3">CFG 3.0</option><option :value="3.5">CFG 3.5</option>
            </select>
            <select class="ig-sel sm" v-model="scheduler" title="调度器">
              <option value="simple">simple</option><option value="normal">normal</option><option value="beta">beta</option>
            </select>
          </div>
        </div>

      </div>
      <div class="ig-bottom">
        <div class="ig-modecard" v-if="refs.length" :class="{i2i: !editMode}" :title="editMode ? editHint : i2iHint">
          <label class="ig-chk big">
            <span class="ig-sw" :class="{on: editMode}" @click="editMode=!editMode"></span>
            <span class="ig-mt">编辑图片</span>
          </label>
          <span class="ig-msub">{{ editMode ? '指令改图' : '保构图重绘' }}</span>
        </div>
        <button class="btn ig-genbtn" :disabled="!canGen || busy" @click="generate">{{ busy ? '生成中…' : '生 成' }}</button>
      </div>
      <div class="ig-gensub err" v-if="errMsg">{{ errMsg }}</div>
      <div class="ig-gensub" v-else-if="infoMsg">{{ infoMsg }}</div>
      <div class="ig-gensub" v-else>产物保存在 工作区\图片生成\{{ today }}\</div>
    </div>

    <!-- ═══ 右：结果画廊 ═══ -->
    <div class="ig-canvas">
      <div class="ig-cbar">
        <span class="ig-t">结果</span>
        <span class="ig-chip2">本次 {{ results.length }} · 历史 {{ history.length }}</span>
        <span style="flex:1"></span>
        <button class="ig-tool" title="在资源管理器里打开今天的产物目录" @click="openOutDir">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.6 4.2c0-.7.6-1.2 1.2-1.2h3l1.3 1.5h6.1c.7 0 1.2.6 1.2 1.2v6c0 .7-.6 1.2-1.2 1.2H2.8c-.7 0-1.2-.6-1.2-1.2V4.2z"/>
          </svg>
          <span>打开文件夹</span>
        </button>
      </div>
      <div class="ig-gallery">
        <div v-if="busy" class="ig-tile genning">
          <i class="spin big"></i>
          <span class="g-txt">{{ busyText || '生成中…' }}</span>
          <button class="ig-stop" @click="stop">停止</button>
        </div>
        <div v-for="(r,i) in results" :key="r.path" class="ig-tile">
          <img :src="imgSrc(r.path)" title="点击预览" @click="preview(r)" @load="onTileLoad($event, r.path)">
          <span class="ig-badge" :class="{edit: r.mode==='图片编辑'}">{{ r.mode }}</span>
          <span class="ig-tag">{{ tileMeta(r) }}</span>
          <div class="ig-ov">
            <div class="ig-ovb">
              <button class="ig-m" title="把这张图加入参考图，继续迭代" @click="useAsRef(r)">用作参考</button>
              <button class="ig-m" @click="reveal(r.path)">文件夹</button>
            </div>
          </div>
        </div>
        <div v-for="h in history" :key="h.path" class="ig-tile dim">
          <img :src="imgSrc(h.path)" title="点击预览" @click="preview(h)" @load="onTileLoad($event, h.path)">
          <span class="ig-tag">{{ tileMeta(h) }}</span>
          <div class="ig-ov">
            <div class="ig-ovb">
              <button class="ig-m" title="把这张图加入参考图，继续迭代" @click="useAsRef(h)">用作参考</button>
              <button class="ig-m" @click="reveal(h.path)">文件夹</button>
            </div>
          </div>
        </div>
        <div v-if="!results.length && !history.length" class="ig-tile empty">
          <span>还没有生成记录<br>左侧配置好参数点「生成」</span>
        </div>
      </div>
    </div>

  </div>
</template>

<script>
/* 图片生成独立功能页（2026-10-17）：三条通道全部复用现有 2.1 管线，模式由「是否传参考图 + 编辑勾选」确定性路由 ——
 *   没传图            → 文生图   character_qwen_image（空 latent，denoise=1）
 *   传图 + 勾「编辑图片」→ 图片编辑 character_edit（2.1 原生编辑通道：TextEncodeQwenImage21 + images.image_1..N，denoise=1.0）
 *   传图 + 不勾        → 图生图   character_qwen_image + params.image（VAEEncode 潜变量，denoise=0.62）
 * 多图参考：params.images 数组（≤10），首图走既有槽、其余由 inference 动态注入 images.image_2..N。
 * 产物：<workspace>/图片生成/<日期>/，历史由 imggen:history 列举。 */
import { useProject as useProjectStore } from './stores/project.js'
import { igState } from './imggenState.js'
import { mediaUrl } from './mediaUrl.js'

const MODES = [
  { k: 't2i',  t: '文生图', tpl: 'character_qwen_image' },
  { k: 'edit', t: '图片编辑', tpl: 'character_edit' },
  { k: 'i2i',  t: '图生图', tpl: 'character_qwen_image' }
]

const EXAMPLES = {
  t2i: '电影感夜景，中国古代婚礼婚房内，红烛高照，新娘身着大红嫁衣与点翠凤冠端坐床沿，红盖头未掀，暖黄烛光与冷月色对比，写实摄影质感',
  edit: '把凤冠换成点翠样式，大红嫁衣改为金色霞帔，背景烛光保持不变，人物面部与姿势不动',
  i2i: '保持人物、构图与姿势不变，画面转为雪夜氛围，冷色调，飘雪'
}
const EXAMPLE_MULTI = '图1的人物穿上图2的服装，站到图3的场景中，保持人物面部与姿势不变，光线融合自然'

export default {
  data() {
    return {
      editMode: true,    // 有参考图时的走向：勾选 = 编辑通道（指令改图）；取消 = 图生图（保构图低噪重绘）
      prompt: '',
      negative: '模糊, 变形, 多余肢体, 水印, 文字',
      refs: [],            // [{path, src}] —— 最多 10 张（官方多图上限）
      res: '1024x1024',
      count: 1,
      steps: 25,           // 采样步数（默认 = 2.1 官方配方）
      cfg: 2.5,            // CFG 提示词强度
      scheduler: 'simple', // 调度器
      lockSeed: false,
      seed: 0,
      busy: false,
      busyText: '',
      errMsg: '',
      infoMsg: '',
      results: [],         // 本次会话产物 [{path, mode, ms}]
      history: [],         // <workspace>/图片生成/ 历史产物
      resOpts: null,       // [{value,label}] —— 独立页不依赖当前项目，直接从主进程取
      dims: {}             // path → 'W×H'（img onload 记录，悬浮 meta 显示）
    }
  },
  computed: {
    st() { return useProjectStore() },
    today() {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    },
    resList() {
      return (this.resOpts && this.resOpts.length) ? this.resOpts
        : [{ value: '1024x1024', label: '1024×1024（1:1）' }, { value: '768x1344', label: '768×1344（9:16）' }]
    },
    /* 🔴 合并后的路由（2026-10-17 二轮拍板）：不再让用户选模式 ——
     *   没传参考图 = 文生图；传了图 = 默认「编辑图片」勾选（编辑通道），
     *   取消勾选 = 图生图（保构图低噪重绘）。全程确定性，不做提示词语义判断。 */
    effMode() {
      if (!this.refs.length) return 't2i'
      return this.editMode ? 'edit' : 'i2i'
    },
    editHint() {
      return this.refs.length > 1
        ? '勾选 = 按提示词改图：只写「要改成什么」，没提到的都保持不变；多图用「图1/图2」引用'
        : '勾选 = 按提示词改图：只写「要改成什么」，没提到的（人物、构图、光线）都保持不变'
    },
    i2iHint() {
      return '取消勾选 = 以参考图为底整体重绘：保留构图与人物，适合改氛围、转风格'
    },
    modePlaceholder() {
      return { t2i: '描述画面：主体 + 环境 + 光线 + 质感（支持中文）',
        edit: '描述「要改成什么」：只写变化，没提到的都会保持不变',
        i2i: '描述「整体氛围怎么变」：构图与人物自动保留' }[this.effMode]
    },
    canGen() {
      if (this.effMode === 't2i') return this.prompt.trim().length > 0
      return this.prompt.trim().length > 0 && this.refs.length > 0
    }
  },
  /* 任务状态镜像到 igState：页面本身用 v-show 常驻（切菜单不销毁，生成不中断），
   * 但侧栏看不见结果区 → 需要这个跨组件的小状态显示「还在跑」的小圆点。 */
  watch: {
    busy(v) { igState.busy = !!v; if (!v) igState.text = '' },
    busyText(v) { igState.text = v || '' },
    // 🔴 本页常驻挂载（v-show），mounted 只跑一次、且可能早于「工作区加载完成」→
    //    那时 imgHistory('') 拿到空数组就再也不会重试，用户看到的「历史全空」就是这个：
    //    其他页面每次进入都重新拉数据，只有本页不会。盯住 workspace，一到就刷。
    'st.workspace'() { this.reloadHistory() }
  },
  async mounted() {
    try { this.resOpts = (await window.studio.resOptions() || {}).img || [] } catch (_) {}
    if (this.resList.length && !this.resList.some(o => o.value === this.res)) this.res = this.resList[0].value
    this.reloadHistory()
  },
  methods: {
    /** 每次切回本页时由 App 调用：常驻挂载没有 mounted 时机，历史得手动刷（见 App.vue 的 st.view watcher） */
    onShow() { this.reloadHistory() },
    imgSrc(abs) {
      // 2026-10-17：改走 studio-media:// 协议（原来是 IPC 读 base64 再拼 data URL）。
      // 缩略图不再常驻几 MB 的 base64 字符串，点击预览也不必再读一遍文件。
      return mediaUrl(abs)
    },
    async addRefs() {
      const picked = await window.studio.pickFiles('image')
      for (const p of (picked || [])) {
        if (this.refs.length >= 10) break
        if (this.refs.some(r => r.path === p)) continue
        this.refs.push({ path: p, busy: false })
      }
    },
    rmRef(i) { this.refs.splice(i, 1) },
    /**
     * 提示词反推（本地 Qwen3.5-9B + mmproj，走 imggen:reverse）：
     * 成功后**自动填入提示词框**（覆盖原内容，用户明确要求「自动填充」）。
     * 反推期间该图按钮显示「反推中…」，可同时反推多张（各自独立，主进程 singleFlight 会串行排队）。
     */
    async reverseRef(i) {
      const r = this.refs[i]
      if (!r || r.busy) return
      r.busy = true
      this.errMsg = ''
      try {
        const res = await window.studio.imgReverse(r.path)
        if (!res || !res.text) throw new Error('没有拿到提示词内容')
        this.prompt = res.text
        this.toast('反推完成，已填入提示词（' + (res.ms / 1000).toFixed(1) + 's）')
      } catch (e) {
        this.errMsg = '提示词反推失败：' + ((e && e.message) || e)
      } finally {
        r.busy = false
      }
    },
    clearRefs() { this.refs = [] },
    fillExample() {
      this.prompt = (this.effMode === 'edit' && this.refs.length > 1) ? EXAMPLE_MULTI : EXAMPLES[this.effMode]
    },
    async useAsRef(r) {
      if (this.refs.some(x => x.path === r.path)) { this.toast('已在参考图中'); return }
      if (this.refs.length >= 10) { this.toast('参考图已满 10 张'); return }
      this.refs.push({ path: r.path, busy: false })
      this.editMode = true   // 「用作参考」的自然走向 = 继续编辑
      this.toast('已加入参考图（' + this.refs.length + '/10）')
    },
    /** 放大预览：复用 App 全局的媒体预览弹窗（与角色&场景卡同一套 —— 标题栏 + 分辨率/体积 + 所在文件夹），
     *  不再用本页自制 lightbox（用户反馈：那个框太大、太素）。 */
    preview(r) {
      const file = String(r.path).split(/[\\/]/).pop()
      this.$root.openPreview({ file, path: r.path }, 'image', '图片生成')
    },
    /** 图块 img 加载完 → 记录真实分辨率（悬浮 meta 用） */
    onTileLoad(e, p) {
      const im = e && e.target
      if (im && im.naturalWidth && !this.dims[p]) {
        this.dims[p] = im.naturalWidth + '×' + im.naturalHeight
        this.$forceUpdate()
      }
    },
    /** 悬浮 meta：分辨率 + 生成时长（历史图没有时长就只显示分辨率） */
    tileMeta(r) {
      const bits = []
      if (this.dims[r.path]) bits.push(this.dims[r.path])
      if (r.ms) bits.push((r.ms / 1000).toFixed(1) + 's')
      return bits.join(' · ')
    },
    reveal(p) { window.studio.revealFile(p) },
    openOutDir() { window.studio.openPath(this.st.workspace + '\\图片生成\\' + this.today) },
    toast(msg) {
      this.infoMsg = msg
      clearTimeout(this._toastT)
      this._toastT = setTimeout(() => { this.infoMsg = '' }, 2500)
    },
    async reloadHistory() {
      try {
        const list = await window.studio.imgHistory(this.st.workspace) || []
        const have = new Set(this.results.map(r => r.path))
        this.history = list.filter(f => !have.has(f.path))
      } catch (_) { this.history = [] }
    },
    stop() { window.studio.comfyCancel() },
    async generate() {
      if (!this.canGen || this.busy) return
      this.busy = true; this.errMsg = ''
      const mv = MODES.find(m => m.k === this.effMode)
      const [w, h] = String(this.res).split('x').map(n => Number(n) || 0)
      const dir = this.st.workspace + '\\图片生成\\' + this.today
      const params = { prompt: this.prompt.trim(), negative: this.negative.trim(),
        steps: this.steps, cfg: this.cfg, scheduler: this.scheduler }
      if (this.effMode === 'edit') {
        params.images = this.refs.map(r => r.path)
        params.resolution = Math.max(w, h) || 1024
        // 编辑通道输出宽高：官方编码节点 latent 跟参考图比例走，必须显式指定（2026-10-17 修分辨率不一致）
        params.ew = w; params.eh = h
      } else {
        params.width = w; params.height = h
        if (this.effMode === 'i2i' && this.refs.length) params.image = this.refs[0].path
      }
      if (this.lockSeed && Number(this.seed) > 0) params.seed = Number(this.seed)
      let okCnt = 0
      for (let i = 0; i < this.count; i++) {
        const t0 = Date.now()
        try {
          this.busyText = '生成中 · 第 ' + (i + 1) + '/' + this.count + ' 张…'
          const r = await window.studio.comfyGenerate({
            templateKey: mv.tpl, dir, baseName: 'imggen_' + Date.now(),
            params
          })
          for (const f of (r && r.files) || []) {
            // 🔴 comfyGenerate 返回的 files 只是文件名（writeUnique 只回 name）→ 必须拼绝对路径：
            //    否则缩略图取不到文件（一块空白）、与历史去重也对不上（裸名 vs 全路径）→ 同一张图出现两次
            const abs = /^[a-zA-Z]:[\\/]/.test(f) ? f : dir + '\\' + f
            // 时长优先用主进程给的 elapsedMs（与落盘 sidecar 同源），保证本次与历史的数字一致
            const ms = (r && r.elapsedMs) || (Date.now() - t0)
            this.results.push({ path: abs, mode: mv.t, ms })
          }
          if (this.lockSeed && !params.seed && r && r.seed) params.seed = r.seed
          okCnt++
        } catch (e) {
          this.errMsg = (e && e.message) || String(e)
          break   // 第一张就报错（如模型缺失）就别连着烧完剩余数量
        }
      }
      this.busy = false; this.busyText = ''
      if (okCnt) { this.toast('完成 ' + okCnt + ' 张'); this.reloadHistory() }
    }
  }
}
</script>

<style scoped>
.ig-wrap{display:grid;grid-template-columns:390px 1fr;gap:14px;height:100%;min-height:0;}
/* ── 左：参数面板 ── */
.ig-panel{background:var(--card);border:1px solid var(--line-soft);border-radius:var(--r-lg);display:flex;flex-direction:column;min-height:0;}
.ig-scroll{flex:1;overflow-y:auto;padding:14px;}
.ig-sec{margin-bottom:16px;}
.ig-lab{font-size:11px;font-weight:600;color:var(--sub);letter-spacing:.12em;margin-bottom:7px;display:flex;align-items:center;gap:8px;}
.ig-hint{font-weight:400;letter-spacing:0;color:var(--sub-2);}
.ig-ex{margin-left:auto;font-size:11px;color:var(--blue-hi);cursor:pointer;}.ig-ex{margin-left:0;}
.ig-note{font-size:11px;color:var(--sub-2);margin-top:6px;line-height:1.6;}
/* 「编辑图片」勾选卡：有参考图时出现在底栏，与生成按钮同行。勾 = 编辑通道；不勾 = 图生图。 */
.ig-bottom{display:flex;align-items:center;gap:10px;margin:0 14px 6px;}
.ig-modecard{flex:1.5;min-width:0;display:flex;align-items:center;gap:10px;background:#0e1320;border:1px solid var(--line);border-radius:12px;padding:8px 12px;cursor:default;transition:border-color .15s;}
.ig-modecard.i2i{border-color:rgba(96,165,250,.35);}
.ig-chk.big{gap:9px;flex-shrink:0;}
.ig-chk .ig-mt{font-size:13px;font-weight:600;color:var(--text);letter-spacing:.04em;white-space:nowrap;}
.ig-msub{margin-left:auto;font-size:11px;color:var(--sub-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ig-ta,.ig-sel{width:100%;background:#0e1320;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:9px 11px;font:12.5px/1.6 inherit;resize:vertical;}
.ig-ta:focus,.ig-sel:focus{outline:none;border-color:var(--blue);}
.ig-ta::placeholder{color:var(--sub-2);}
.ig-ta.sm{min-height:48px;}
.ig-sel{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--sub) 50%),linear-gradient(135deg,var(--sub) 50%,transparent 50%);background-position:calc(100% - 16px) 55%,calc(100% - 11px) 55%;background-size:5px 5px;background-repeat:no-repeat;cursor:pointer;}
.ig-refs{display:flex;flex-wrap:wrap;gap:8px;}
.ig-ref{width:86px;height:86px;border:1px dashed #33405a;border-radius:10px;background:#0e1320;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--sub-2);font-size:11px;cursor:pointer;position:relative;overflow:hidden;}
.ig-ref:hover{border-color:var(--blue);color:var(--blue-hi);}
.ig-ref.full{border-style:solid;border-color:var(--line);}
.ig-ref.full img{cursor:zoom-in;}
.ig-ref img{width:100%;height:100%;object-fit:cover;display:block;}
/* 移除参考图：圆底小钮，压在缩略图右上角（方形药丸太抢眼，用户 2026-10-17 要求改圆形） */
.ig-refx{
  position:absolute;top:4px;right:4px;width:18px;height:18px;padding:0;
  display:flex;align-items:center;justify-content:center;
  background:rgba(8,12,20,.72);border:1px solid rgba(255,255,255,.18);border-radius:50%;
  color:#e8eef8;font-size:10px;line-height:1;cursor:pointer;z-index:2;
  backdrop-filter:blur(2px);transition:background .15s,border-color .15s,transform .15s;
}
.ig-refx:hover{background:rgba(220,60,60,.92);border-color:rgba(255,120,120,.7);transform:scale(1.08);}
/* 反推提示词：常驻悬浮在参考图底部（用户 2026-10-17 要求与右上角 ✕ 一样常显，不要 hover 才出现） */
.ig-rev{
  position:absolute;left:4px;right:4px;bottom:4px;height:20px;padding:0 6px;
  display:flex;align-items:center;justify-content:center;gap:4px;
  font-size:10.5px;line-height:1;color:#dbe8fb;white-space:nowrap;
  background:rgba(8,12,20,.72);border:1px solid rgba(255,255,255,.18);border-radius:999px;
  cursor:pointer;z-index:2;backdrop-filter:blur(2px);
  transition:background .15s,border-color .15s,color .15s,transform .15s;
}
.ig-rev.on{color:#cfe1f8;}
.ig-rev:hover{background:rgba(37,99,235,.92);border-color:rgba(96,165,250,.7);color:#fff;}
.ig-rev:disabled{cursor:default;color:#cfe1f8;}
.ig-rev .spin{width:9px;height:9px;border-width:1.5px;border-color:rgba(255,255,255,.28);border-top-color:#9dc0ef;}
.ig-row{display:flex;align-items:center;gap:8px;}
/* 生成数量：与「新建项目」同款 popt 选项卡（全局样式），这里只管布局与小尺寸 */
.ig-cnt{flex:1;min-width:0;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
.ig-cnt .popt{padding:7px 6px;align-items:center;justify-content:center;text-align:center;}
.ig-cnt .popt b{font-size:12px;}
/* 采样参数：三个并排小 select */
.ig-sel.sm{flex:1;min-width:0;width:auto;padding:7px 26px 7px 9px;font-size:12px;}
.ig-chk{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--sub);cursor:pointer;}
.ig-sw{width:32px;height:18px;border-radius:10px;background:#232c3d;position:relative;transition:.15s;flex-shrink:0;display:inline-block;}
.ig-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#7d8798;transition:.15s;}
.ig-sw.on{background:var(--grad-deep);}
.ig-sw.on::after{left:16px;background:#fff;}
.ig-seed{margin-top:8px;width:100%;background:#0e1320;border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px 10px;font-size:12px;}
/* 生成按钮：用全局 .btn（与新建项目确认按钮同款），这里只管布局 */
.ig-genbtn{flex:1;min-width:118px;padding:9px 18px;font-size:13.5px;letter-spacing:.14em;}
.ig-gensub{text-align:center;font-size:11px;color:var(--sub-2);margin:2px 14px 12px;}
.ig-gensub.err{color:var(--danger);}
.ig-stop{font-size:11px;color:var(--warn);background:none;border:none;cursor:pointer;margin-left:8px;}
/* ── 右：结果画廊 ── */
.ig-canvas{background:var(--card);border:1px solid var(--line-soft);border-radius:var(--r-lg);display:flex;flex-direction:column;min-height:0;}
.ig-cbar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line-soft);flex-shrink:0;}
.ig-t{font-weight:500;font-size:13px;}
.ig-chip2{font-size:11px;color:var(--sub);border:1px solid var(--line);border-radius:20px;padding:1px 10px;}
/* 结果区工具按钮：药丸描边 + 图标，hover 亮蓝（原来是个裸文字框，太素） */
.ig-tool{
  display:inline-flex;align-items:center;gap:6px;
  font-size:12px;line-height:1;color:#a9bdd8;
  background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.26);border-radius:999px;
  padding:6px 13px 6px 11px;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s,box-shadow .15s;
}
.ig-tool svg{width:13px;height:13px;fill:currentColor;opacity:.85;}
.ig-tool:hover{color:#fff;background:rgba(96,165,250,.16);border-color:rgba(96,165,250,.55);box-shadow:0 2px 10px rgba(37,99,235,.25);}
.ig-tool:active{transform:translateY(1px);}
.ig-gallery{flex:1;overflow-y:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;align-content:start;}
.ig-tile{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--line-soft);aspect-ratio:1;background:#0e1320;}
.ig-tile.dim{opacity:.82;}
.ig-tile img{width:100%;height:100%;object-fit:cover;display:block;}
.ig-badge{position:absolute;top:8px;left:8px;font-size:10.5px;padding:2px 9px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);}
.ig-badge.edit{border-color:rgba(96,165,250,.5);color:#a8c6ef;}
/* 分辨率 + 生成时长：常驻右上角小 tag（不用 hover） */
.ig-tag{position:absolute;top:8px;right:8px;font-size:10.5px;padding:2px 8px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);letter-spacing:.02em;white-space:nowrap;}
.ig-ov{position:absolute;left:0;right:0;bottom:0;padding:18px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;flex-direction:column;gap:6px;opacity:0;transition:.15s;}
.ig-tile:hover .ig-ov{opacity:1;}
.ig-tile img{cursor:zoom-in;}
.ig-ovb{display:flex;flex-wrap:wrap;justify-content:center;gap:5px;}
/* 生成中占位卡（结果区第一个格子） */
.ig-tile.genning{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border-style:dashed;border-color:rgba(96,165,250,.4);}
.ig-tile.genning .spin.big{width:22px;height:22px;border-width:3px;}
.ig-tile.genning .g-txt{font-size:12px;color:var(--sub);text-align:center;line-height:1.6;}
.ig-m{font-size:11px;color:#dbe4f0;background:rgba(255,255,255,.12);border:none;border-radius:6px;padding:2px 8px;cursor:pointer;}
.ig-m:hover{background:rgba(59,130,246,.5);color:#fff;}
.ig-tile.empty{display:flex;align-items:center;justify-content:center;color:var(--sub-2);font-size:12px;text-align:center;line-height:1.8;border-style:dashed;}
</style>
