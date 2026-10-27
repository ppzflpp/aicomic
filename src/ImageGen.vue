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
              <img :src="imgSrc(r.path)" title="点击放大查看" @load="onRefLoad($event, i)" @click="preview(r)">
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
        <button class="btn ig-genbtn" :disabled="!canGen" @click="generate">生 成</button>
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
       <!-- 固定大小网格容器：格子 196×196（见 .ig-flow 的 --ig-cell），图片按原比例缩放到格内 -->
       <div class="ig-flow">
        <!-- 🔴 多任务排队（2026-10-23）：按任务中心活跃列表渲染，区分「生成中/排队中」 -->
        <div v-for="t in igTasks" :key="t.id" class="ig-tile genning" :class="{queued: t.status === 'queued'}">
          <i class="spin big"></i>
          <span class="g-txt">{{ t.status === 'running' ? (t.text || '生成中…') : '排队中…' }}</span>
          <button class="ig-stop" @click="stopTask(t.id)">取消</button>
        </div>
        <!-- 本次产物：最新一张排最前（results 是按下标追加上来的，展示时按 at 倒序） -->
        <div v-for="r in resultsDesc" :key="r.path" class="ig-tile">
          <div class="ig-ph">
            <img :src="imgSrc(r.path)" title="点击预览" @click="preview(r)" @load="onTileLoad($event, r.path)">
            <!-- 右上角：分辨率 · 生成时长（保持改造前原样） -->
            <span class="ig-tag">{{ tileMeta(r) }}</span>
            <!-- 图下方悬浮：生成时长胶囊（沿用旧 mode 徽标的样式） -->
            <span v-if="timeText(r)" class="ig-dur" title="本张图片的生成时间">{{ timeText(r) }}</span>
            <div class="ig-ov">
              <div class="ig-ovb">
                <button class="ig-m" title="把这张图加入参考图，继续迭代" @click="useAsRef(r)">用作参考</button>
                <button class="ig-m" title="把这次生成的配置回填到左侧，继续微调" @click.stop="fillBack(r)">回填配置</button>
                <button class="ig-m" title="查看这条记录的用户提示词与参数" @click.stop="viewPrompt(r)">查看提示词</button>
                <button class="ig-m del" title="把这张图片从硬盘永久删除" @click.stop="askDelete(r, 'results')">删除</button>
              </div>
            </div>
          </div>
        </div>
        <!-- 历史产物：imggen:history 已按 mtime 倒序返回，直接铺 -->
        <div v-for="h in history" :key="h.path" class="ig-tile dim">
          <div class="ig-ph">
            <img :src="imgSrc(h.path)" title="点击预览" @click="preview(h)" @load="onTileLoad($event, h.path)">
            <span class="ig-tag">{{ tileMeta(h) }}</span>
            <span v-if="timeText(h)" class="ig-dur" title="本张图片的生成时间">{{ timeText(h) }}</span>
            <div class="ig-ov">
              <div class="ig-ovb">
                <button class="ig-m" title="把这张图加入参考图，继续迭代" @click="useAsRef(h)">用作参考</button>
                <button class="ig-m" title="把这次生成的配置回填到左侧，继续微调" @click.stop="fillBack(h)">回填配置</button>
                <button class="ig-m" title="查看这条记录的用户提示词与参数" @click.stop="viewPrompt(h)">查看提示词</button>
                <button class="ig-m del" title="把这张图片从硬盘永久删除" @click.stop="askDelete(h, 'history')">删除</button>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!results.length && !history.length && !igTasks.length" class="ig-tile empty">
          <span>还没有生成记录<br>左侧配置好参数点「生成」</span>
        </div>
       </div>
      </div>
    </div>

    <!-- ═══ 查看提示词弹框（只读） ═══ -->
    <div class="ig-modal" v-if="promptView" @click.self="promptView=null">
      <div class="ig-modal-box">
        <div class="ig-modal-head">
          <span class="ig-modal-title">查看提示词</span>
          <button class="ig-modal-x" @click="promptView=null">✕</button>
        </div>
        <div class="ig-modal-body">
          <div class="ig-pb">
            <div class="ig-pb-lab">用户提示词</div>
            <div class="ig-pb-text">{{ promptView.raw || '（无）' }}</div>
          </div>
          <div class="ig-pb">
            <div class="ig-pb-lab">负面提示词</div>
            <div class="ig-pb-text" :class="{empty: !promptView.negative}">{{ promptView.negative || '（无）' }}</div>
          </div>
          <div class="ig-pb">
            <div class="ig-pb-lab">本次参数</div>
            <div class="ig-pb-text">
              <span>模式：{{ promptView.mode || '—' }}</span>
              <span style="opacity:.5"> · </span>
              <span>分辨率：{{ promptView.res || '—' }}</span>
              <span style="opacity:.5"> · </span>
              <span>步数：{{ promptView.steps || '—' }}</span>
              <span style="opacity:.5"> · </span>
              <span>CFG：{{ promptView.cfg != null ? promptView.cfg : '—' }}</span>
              <span style="opacity:.5"> · </span>
              <span>调度器：{{ promptView.scheduler || '—' }}</span>
              <span v-if="promptView.seed" style="opacity:.5"> · </span>
              <span v-if="promptView.seed">Seed：{{ promptView.seed }}</span>
            </div>
          </div>
        </div>
        <div class="ig-modal-foot">
          <button class="btn ghost" @click="promptView=null">关闭</button>
        </div>
      </div>
    </div>

    <!-- ═══ 删除确认框 ═══ -->
    <div class="ig-modal" v-if="delAsk" @click.self="delAsk=null">
      <div class="ig-modal-box" style="width:460px">
        <div class="ig-modal-head">
          <span class="ig-modal-title">删除这张图片</span>
          <button class="ig-modal-x" @click="delAsk=null">✕</button>
        </div>
        <div class="ig-modal-body">
          <p class="ig-del-tip">确定要从硬盘<b>永久删除</b>这张图片吗？删除后不可恢复。</p>
          <p class="ig-del-path">{{ delAsk.path }}</p>
        </div>
        <div class="ig-modal-foot">
          <button class="btn ghost" @click="delAsk=null">取消</button>
          <button class="btn danger" @click="doDelete">确认删除</button>
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
import { subscribe, submit, cancel, activeCount, activeTasks } from './taskCenter.js'

const MODES = [
  { k: 't2i',  t: '文生图', tpl: 'character_qwen_image' },
  { k: 'edit', t: '图片编辑', tpl: 'character_edit' },
  { k: 'i2i',  t: '图生图', tpl: 'character_qwen_image' }
]

const TYPE = 'imggen'

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
      refs: [],            // [{path, src, dims}] —— 最多 10 张（官方多图上限）；dims = img onload 记的真实宽高
      res: '1024x1024',
      count: 1,
      steps: 25,           // 采样步数（默认 = 2.1 官方配方）
      cfg: 2.5,            // CFG 提示词强度
      scheduler: 'simple', // 调度器
      lockSeed: false,
      seed: 0,
      _submitting: false,  // 🔴 提交锁：防连点重复提交任务（多任务排队，按钮不再被「生成中」阻塞）
      errMsg: '',
      infoMsg: '',
      promptView: null,    // 查看提示词弹框数据 {raw, negative, mode, res, steps, cfg, scheduler, seed}
      delAsk: null,        // 删除确认框数据 {path, from}（from='results'|'history'，用于删除后局部移除）
      results: [],         // 本次会话产物 [{path, mode, ms, at, snapshot}]
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
      const base = (this.resOpts && this.resOpts.length) ? this.resOpts
        : [{ value: '1024x1024', label: '1024×1024（1:1）' }, { value: '768x1344', label: '768×1344（9:16）' }]
      // 🔴 上传参考图后，最前面插入「自动」档位 —— 分辨率 = 第一张参考图的真实尺寸
      //   （多图以第一张为准）。value 直接存 "WxH"，generate 里 split('x') 零改动。
      const d = this.refs[0] && this.refs[0].dims
      if (this.refs.length && d && d.w && d.h) {
        return [{ value: d.w + 'x' + d.h, label: '自动（' + d.w + '×' + d.h + '）' }, ...base]
      }
      return base
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
      // 🔴 多任务排队（2026-10-23）：不再因「有任务在跑」禁用按钮，只要参数就绪且未在提交中即可点
      if (this._submitting) return false
      if (this.effMode === 't2i') return this.prompt.trim().length > 0
      return this.prompt.trim().length > 0 && this.refs.length > 0
    },
    /* 结果排序（2026-10-17 用户要求）：按实际生成时间倒序 —— 最新一张排最前。
     * results 是循环里 push 进来的（越晚越靠后），所以展示层必须自己排，
     * 不能直接拿数组顺序铺；at 缺失的老数据回落到 0（排最后）。 */
    resultsDesc() {
      return this.results.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
    },
    /** 本模块当前活跃任务（在跑 + 排队），进行中在前、排队在后。change 订阅触发重渲染。 */
    igTasks() {
      return activeTasks().filter(t => t.type === TYPE).map(t => ({
        id: t.id,
        status: t.status,           // running | queued
        label: t.label || '图片生成',
        text: t.text || ''
      })).sort((a, b) => (a.status === 'running' ? -1 : 1) - (b.status === 'running' ? -1 : 1))
    }
  },
  watch: {
    // 🔴 本页常驻挂载（v-show），mounted 只跑一次、且可能早于「工作区加载完成」→
    //    那时 imgHistory('') 拿到空数组就再也不会重试，用户看到的「历史全空」就是这个：
    //    其他页面每次进入都重新拉数据，只有本页不会。盯住 workspace，一到就刷。
    'st.workspace'() { this.reloadHistory() }
  },
  async mounted() {
    try { this.resOpts = (await window.studio.resOptions() || {}).img || [] } catch (_) {}
    if (this.resList.length && !this.resList.some(o => o.value === this.res)) this.res = this.resList[0].value
    this.reloadHistory()
    // 订阅任务中心事件：本模块任务结束 → 回填结果；进度 → 更新侧栏悬浮文案
    this._offDone = subscribe('done', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offFail = subscribe('fail', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offCancel = subscribe('cancel', t => { if (t && t.task && t.task.type === TYPE) this.onTaskDone(t.task) })
    this._offProgress = subscribe('progress', t => { if (t && t.task && t.task.type === TYPE) this.onTaskProgress(t.task) })
    // 🔴 侧栏闪点统一走 change 事件重算（时序正确：change 在 bumpType(-1) 之后 emit）
    this._offChange = subscribe('change', () => {
      igState.busy = activeCount(TYPE) > 0
      if (!igState.busy) igState.text = ''
    })
  },
  beforeUnmount() {
    this._offDone && this._offDone()
    this._offFail && this._offFail()
    this._offCancel && this._offCancel()
    this._offProgress && this._offProgress()
    this._offChange && this._offChange()
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
    /**
     * 参考图 img 加载完 → 记录该张真实宽高到 refs[i].dims（2026-10-22）。
     * 第一张（i===0）拿到尺寸后，默认选中「自动」分辨率档位（值 = 第一张参考图尺寸）。
     */
    onRefLoad(e, i) {
      const im = e && e.target
      if (im && im.naturalWidth && im.naturalHeight) {
        this.refs[i].dims = { w: im.naturalWidth, h: im.naturalHeight }
        if (i === 0) this.res = im.naturalWidth + 'x' + im.naturalHeight
      }
    },
    rmRef(i) {
      this.refs.splice(i, 1)
      // 移除的是第一张 → 若新的第一张已记过尺寸，自动档随之更新并选中；否则回退普通档
      if (i === 0) {
        const d = this.refs[0] && this.refs[0].dims
        if (this.refs.length && d && d.w && d.h) this.res = d.w + 'x' + d.h
        else if (!this.refs.length) { const b = this.resList; if (b.length) this.res = b[0].value }
      }
    },
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
    clearRefs() {
      this.refs = []
      // 参考图清空 → 自动档消失，res 回退到普通档第一项
      const base = this.resList
      if (base.length && !base.some(o => o.value === this.res)) this.res = base[0].value
    },
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
    /** 右上角 meta：分辨率 + 生成时长（历史图没有时长就只显示分辨率）—— 保持改造前原样 */
    tileMeta(r) {
      const bits = []
      if (this.dims[r.path]) bits.push(this.dims[r.path])
      if (r.ms) bits.push((r.ms / 1000).toFixed(1) + 's')
      return bits.join(' · ')
    },
    /** 图下方悬浮胶囊：本张图的生成时间 yyyy-mm-dd hh:mm:ss（旧 mode 徽标样式）
     *  本次产物取 at（生成完成时刻），历史产物取 mtimeMs（文件落盘时刻）；都没有就不显示 */
    timeText(r) {
      const ms = Number(r && (r.at || r.mtimeMs)) || 0
      if (!ms) return ''
      const d = new Date(ms)
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    },
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
    /** 取消单个任务（排队中的立即取消；进行中的标记取消 + 中断 ComfyUI） */
    stopTask(id) {
      cancel(id)
      const running = activeTasks().find(t => t.type === TYPE && t.status === 'running' && t.id === id)
      if (running) window.studio.comfyCancel()
    },
    onTaskProgress(task) {
      igState.text = task.text || '出图中'
    },
    onTaskDone(task) {
      // igState.busy 由 change 订阅统一维护，这里只回填产物 + 提示失败
      igState.text = ''
      if (task && task.status === 'done' && task.result && task.result.images) {
        for (const img of task.result.images) this.results.push(img)
        this.reloadHistory()
        this.toast('完成 ' + task.result.images.length + ' 张')
      } else if (task && task.error && !/已停止生成|已取消|SKIP_CANCELLED/.test(String(task.error.message || task.error))) {
        this.errMsg = (task.error.message || String(task.error))
      }
    },
    /** 回填配置：把某条结果记录的生成快照填回左侧输入区 */
    fillBack(r) {
      const s = r.snapshot
      if (!s) { this.toast('这条记录没有保存配置快照'); return }
      this.prompt = s.prompt || ''
      this.negative = s.negative || ''
      this.refs = (s.refs || []).map(p => ({ path: p, busy: false }))
      // 参考图有/无决定 editMode 走向：有图 → 编辑模式；无图 → 文生图
      if (this.refs.length) this.editMode = true
      if (s.res) this.res = s.res
      if (s.count) this.count = s.count
      if (s.steps) this.steps = s.steps
      if (s.cfg != null) this.cfg = s.cfg
      if (s.scheduler) this.scheduler = s.scheduler
      if (s.lockSeed != null) this.lockSeed = s.lockSeed
      if (s.seed) this.seed = s.seed
      this.toast('已回填这版生成配置，可继续微调')
    },
    /** 查看提示词弹框：显示用户原提示词 + 本次参数（只读） */
    viewPrompt(r) {
      const s = r.snapshot || {}
      this.promptView = {
        raw: s.prompt || '',
        negative: s.negative || '',
        mode: s.mode || '',
        res: s.res || '',
        steps: s.steps,
        cfg: s.cfg,
        scheduler: s.scheduler || '',
        seed: s.seed || 0
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
        this.toast('已删除这张图片')
      } catch (e) {
        this.toast('删除失败：' + ((e && e.message) || e))
      }
    },
    async generate() {
      if (!this.canGen) return
      this._submitting = true   // 提交锁：防连点（任务本身走任务中心队列，不阻塞按钮）
      try {
        this.errMsg = ''
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
        // 🔴 锁定 seed 时，把当前 seed 固定下来，后续 N 张复用（原逻辑：第一张拿到 r.seed 后回填 params.seed）
        const seedLocked = this.lockSeed && Number(this.seed) > 0 ? Number(this.seed) : null
        const count = Math.max(1, Number(this.count) || 1)
        const modeTag = mv.t
        // 生成快照：本次生成的完整配置（供结果区「回填配置」「查看提示词」用）
        const snapshot = {
          prompt: this.prompt.trim(),              // 用户原提示词
          negative: this.negative.trim(),          // 负面提示词
          refs: this.refs.map(r => r.path),        // 参考图路径
          mode: this.effMode,                      // t2i | edit | i2i
          res: this.res,                           // 分辨率 "WxH"
          count: count,                            // 张数
          steps: this.steps,
          cfg: this.cfg,
          scheduler: this.scheduler,
          lockSeed: this.lockSeed,
          seed: Number(this.seed) || 0
        }
        // 🔴 快照一并塞进 params 传给主进程 → 写进产物旁车 JSON，历史图也能「回填配置 / 查看提示词」
        params.snapshot = snapshot
        // 提交任务中心：一次点击 = 一个任务（内含 count 张），排队串行跑
        submit({
          label: '图片生成 · ' + modeTag + (count > 1 ? ' ×' + count : ''),
          type: TYPE,
          episodeId: null,
          run: async (report) => {
            const images = []
            for (let i = 0; i < count; i++) {
              report({ done: i, total: count, label: '生成中 · 第 ' + (i + 1) + '/' + count + ' 张…' })
              const t0 = Date.now()
              const p = { ...params }
              if (seedLocked != null && !p.seed) p.seed = seedLocked
              const r = await window.studio.comfyGenerate({
                templateKey: mv.tpl, dir, baseName: 'imggen_' + Date.now() + '_' + i,
                params: p
              })
              for (const f of (r && r.files) || []) {
                // 🔴 comfyGenerate 返回的 files 只是文件名（writeUnique 只回 name）→ 必须拼绝对路径
                const abs = /^[a-zA-Z]:[\\/]/.test(f) ? f : dir + '\\' + f
                const ms = (r && r.elapsedMs) || (Date.now() - t0)
                images.push({ path: abs, mode: modeTag, ms, at: Date.now(), snapshot })
              }
            }
            return { images }
          }
        })
        // 🔴 提交成功后清空提示词（多任务排队：让用户能立刻输入下一个任务）
        this.prompt = ''
      } finally {
        this._submitting = false
      }
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
/* 结果画廊：固定大小网格（2026-10-18 用户要求）
   —— 每个格子同宽同高、行列对齐，不再是高度参差的瀑布流；
      图片用 object-fit:contain 缩放到格子内，完整显示不裁切（竖图/横图各自留边）。 */
.ig-gallery{flex:1;overflow-y:auto;padding:14px;}
.ig-flow{
  --ig-cell:196px;                                   /* 单个格子边长：只想改大小就改这一个值 */
  display:grid;
  grid-template-columns:repeat(auto-fill, var(--ig-cell));
  grid-auto-rows:var(--ig-cell);
  gap:12px;
  justify-content:start;
  align-content:start;
}
.ig-tile{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--line-soft);background:#0e1320;height:100%;}
.ig-tile.dim{opacity:.82;}
/* 图片层：叠层（悬停操作钮/底部时长胶囊）都锚在图片本体上 */
.ig-ph{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;}
/* 缩略图铺满整个格子（cover）：所有格子里的图看起来一样大 —— 这是「固定大小网格」的关键。
   原图比例不同，铺满时会裁掉一点边缘；点开预览看到的仍是完整原图。 */
.ig-tile img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;}
/* 右上角：分辨率 · 生成时长（保持改造前原样，常驻不随 hover） */
.ig-tag{position:absolute;top:8px;right:8px;font-size:10.5px;padding:2px 8px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);letter-spacing:.02em;white-space:nowrap;}
/* 图下方悬浮：生成耗时胶囊（沿用旧 mode 徽标 `.ig-badge` 的样式：半透明黑底 + 细边） */
.ig-dur{position:absolute;left:8px;bottom:8px;font-size:10.5px;padding:2px 9px;border-radius:12px;background:rgba(0,0,0,.55);color:#cfe1f8;border:1px solid rgba(255,255,255,.14);letter-spacing:.02em;white-space:nowrap;font-variant-numeric:tabular-nums;pointer-events:none;}
.ig-ov{position:absolute;left:0;right:0;bottom:0;padding:18px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;flex-direction:column;gap:6px;opacity:0;transition:.15s;}
.ig-tile:hover .ig-ov{opacity:1;}
.ig-tile img{cursor:zoom-in;}
.ig-ovb{display:flex;flex-wrap:wrap;justify-content:center;gap:5px;}
/* 生成中占位卡（结果区第一个格子）：与其它格子同尺寸，靠网格行高撑起来 */
.ig-tile.genning{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border-style:dashed;border-color:rgba(96,165,250,.4);height:100%;}
/* 排队中的任务卡片：转圈变暗、描边变淡，与「生成中」区分 */
.ig-tile.genning.queued{border-color:rgba(148,163,184,.3);}
.ig-tile.genning.queued .spin.big{border-color:rgba(148,163,184,.2);border-top-color:rgba(148,163,184,.5);}
.ig-tile.genning.queued .g-txt{color:var(--sub-2);}
.ig-tile.genning .spin.big{width:22px;height:22px;border-width:3px;}
.ig-tile.genning .g-txt{font-size:12px;color:var(--sub);text-align:center;line-height:1.6;}
.ig-m{font-size:11px;color:#dbe4f0;background:rgba(255,255,255,.12);border:none;border-radius:6px;padding:2px 8px;cursor:pointer;}
.ig-m:hover{background:rgba(59,130,246,.5);color:#fff;}
.ig-m.del:hover{background:rgba(239,68,68,.6);color:#fff;}
/* 删除确认框 */
.ig-del-tip{font-size:13px;line-height:1.7;color:var(--text);}
.ig-del-tip b{color:var(--danger);}
.ig-del-path{font-size:11.5px;color:var(--sub-2);word-break:break-all;background:#0e1320;border:1px solid var(--line);border-radius:8px;padding:8px 10px;line-height:1.6;}
.ig-tile.empty{display:flex;align-items:center;justify-content:center;color:var(--sub-2);font-size:12px;text-align:center;line-height:1.8;border-style:dashed;min-height:240px;grid-column:1 / -1;}
/* 查看提示词弹框（与视频生成同款） */
.ig-modal{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:200;}
.ig-modal-box{width:640px;max-width:92vw;max-height:84vh;background:var(--card);border:1px solid var(--line);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;}
.ig-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line-soft);flex-shrink:0;}
.ig-modal-title{font-size:14px;font-weight:600;color:var(--text);}
.ig-modal-x{background:none;border:none;color:var(--sub);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px;}
.ig-modal-x:hover{color:var(--text);background:rgba(255,255,255,.08);}
.ig-modal-body{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:16px;}
.ig-pb{display:flex;flex-direction:column;gap:8px;}
.ig-pb-lab{font-size:12px;font-weight:600;color:var(--sub);letter-spacing:.05em;}
.ig-pb-text{background:#0e1320;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.7;color:var(--text);white-space:pre-wrap;word-break:break-word;}
.ig-pb-text.empty{color:var(--sub-2);}
.ig-modal-foot{display:flex;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--line-soft);flex-shrink:0;}
</style>
