<template>
  <div>
    <div v-if="busy || pBusy || vBusy" class="progress"><div class="bar indeterminate"></div></div>

    <div v-if="!shots.length && !adapted && !busy" class="placeholder" style="margin-bottom:8px">尚无分镜。先在第 2 块完成改编稿再点「生成分镜」，或直接手动添加镜头。</div>

    <!-- 脏标记（改编稿改过 → 分镜需重新生成）统一显示在本模块标题后面，见 App.vue 的 stage-head -->

    <!-- 列表视图：每行 = 该镜头的分镜编辑 | H3 提示词（含分辨率+生成视频） | 视频预览。
         🔴 无锁定：所有分区随时可编辑；上游变化由 ⚠ 脏标记提示。 -->
    <div class="shot-list">
      <div v-for="(s, i) in shots" :key="i" class="shot-row" :class="{ sel: sel === i }" @click="sel = i">
        <!-- 分区1：分镜（原阶段3 字段；只读展示入口，本区只保留删除；「生成提示词」已移到提示词区）
             🔴 无锁定：所有分区随时可编辑；上游变化由 ⚠ 脏标记提示。 -->
        <div class="zone-1">
          <div class="row-head">
            <span class="zone-tag">分镜</span>
            <b>镜头 {{ i + 1 }}</b>
            <span class="dur">{{ s.dur }}s</span>
            <span v-if="durWarn(i).length" class="dur-warn"
              :title="durWarn(i).join('\n')">⚠ 时长偏紧</span>
            <span style="flex:1"></span>
            <button class="del-btn" title="删除此镜头" @click="askDelShot(i)">✕</button>
          </div>
          <div class="f"><label>场景</label><input v-model="s.scene" @change="touchShot(s)" /></div>
          <div class="f"><label>角色</label><input v-model="s.chars" @change="touchShot(s)" /></div>
          <div class="f"><label>画面动作</label><textarea v-model="s.action" rows="3" @change="touchShot(s)"></textarea></div>
          <div class="f"><label>对白</label><textarea v-model="s.dialogue" rows="2" @change="touchShot(s)"></textarea></div>
          <div class="row2">
            <div class="f"><label>镜头语言</label><input v-model="s.camera" @change="touchShot(s)" /></div>
            <div class="f"><label>时长/秒</label><input v-model.number="s.dur" type="number" min="4" max="15" step="1"
              @change="s.dur = clampDur(s.dur); touchShot(s)" /></div>
          </div>
        </div>

        <!-- 分区2：H3 提示词。自上而下固定顺序：
             ① 标题行（H3 提示词 · 耗时 · 脏标） ② 提示行（角色 · 时长 · 动作摘要）
             ③ 素材区（单行） ④ 提示词文本框 ⑤ 「生成提示词」按钮（靠左）
             ⑥ 视频分辨率 ⑦ 路线提示靠左 + 「生成视频」靠右 -->
        <div class="zone-2">
          <div class="row-head">
            <span class="zone-tag">H3 提示词</span>
            <span v-if="genTextP(i)" class="gen-ms" :class="{ live: prompts[i] && prompts[i]._genAt }">{{ genTextP(i) }}</span>
            <span style="flex:1"></span>
            <span v-if="promptStale(i)" class="stale" @click="ackPrompt(i)" title="点击消除提示">
              分镜/素材已变化 · <b>生成</b>后消失
            </span>
          </div>
          <div class="vmeta">
            <span v-if="prompts[i] && prompts[i]._gen" class="busy-txt"><i class="spin"></i>正在生成提示词…</span>
            <div class="hint" style="margin-top:3px">{{ s.chars }} · {{ s.dur }}s · {{ s.dialogue || s.action }}</div>
          </div>

          <!-- 参考素材：都可不选（什么都不选＝纯文字）。全部素材排在**同一行**（不换行，放不下就横向滚动）：
               参考图1、参考图2…（＋参考图）｜ 视频1、视频2…（＋参考视频）｜ 首帧 ｜ 尾帧。
               图片类 3:4 竖框 64×85、视频类 4:3 横框 113×85，三类等高 85；
               左侧文字标签已去掉 —— 改到每张图左上角显示角标（参考图 / 视频 / 首帧 / 尾帧） -->
          <div class="refs" v-if="prompts[i]">
            <div class="ref-row">
              <div v-for="(f, k) in prompts[i].refs.images" :key="'ri' + k" class="ref-thumb">
                <img :src="refSrc(f)" :title="f" />
                <span class="rtag">参考图</span>
                <button class="img-x" title="移除" @click.stop="delRef(i, 'images', k)">✕</button>
              </div>
              <button v-if="prompts[i].refs.images.length < maxRefImg" class="ref-add" :title="'从本地选参考图（最多 ' + maxRefImg + ' 张）'" @click="addRef(i, 'images')">参考图</button>

              <div v-for="(f, k) in prompts[i].refs.videos" :key="'rv' + k" class="ref-thumb vid" :title="f">
                <video v-if="refVidSrc(f)" :src="refVidSrc(f)" controls preload="metadata"></video>
                <div v-else class="ph-mini"><i class="spin"></i>加载中…</div>
                <span class="rtag vid">视频</span>
                <button class="img-x" title="移除" @click.stop="delRef(i, 'videos', k)">✕</button>
              </div>
              <button v-if="prompts[i].refs.videos.length < maxRefVid" class="ref-add wide" :title="'从本地选参考视频（最多 ' + maxRefVid + ' 个）'" @click="addRef(i, 'videos')">参考视频</button>

              <div v-if="prompts[i].refs.first" class="ref-thumb">
                <img :src="refSrc(prompts[i].refs.first)" title="首帧" />
                <span class="rtag">首帧</span>
                <button class="img-x" title="移除首帧" @click.stop="clearFrame(i, 'first')">✕</button>
              </div>
              <button v-else class="ref-add" title="选一张图作为首帧" @click="pickFrame(i, 'first')">首帧</button>

              <div v-if="prompts[i].refs.last" class="ref-thumb">
                <img :src="refSrc(prompts[i].refs.last)" title="尾帧" />
                <span class="rtag">尾帧</span>
                <button class="img-x" title="移除尾帧" @click.stop="clearFrame(i, 'last')">✕</button>
              </div>
              <button v-else class="ref-add" title="选一张图作为尾帧（与首帧配合可做首尾帧过渡）" @click="pickFrame(i, 'last')">尾帧</button>
            </div>
          </div>

          <!-- 提示词文本：高度自适应，占满本区剩余空间（内容超出在框内滚动） -->
          <div class="f ta-main"><textarea v-model="prompts[i].text" rows="6" placeholder="H3 提示词（英文结构化）…"
                                           @change="touchPrompt(i)"></textarea></div>

          <!-- 「生成提示词」（次级功能：绿色）：在提示词框下方，靠左单独一行 -->
          <div class="cops gen-p-row">
            <button class="btn sec sm"
                    :disabled="pBusy || !prompts[i]" title="按本行分镜与参考素材重新生成本镜头的 H3 提示词"
                    @click="genP(i)">
              <span v-if="prompts[i] && prompts[i]._gen" class="busy-txt"><i class="spin"></i>生成中…</span>
              <span v-else>生成提示词</span>
            </button>
          </div>

          <!-- 底部：生成路线提示靠左｜视频分辨率 + 生成视频按钮靠右 -->
          <div class="cops zone-foot">
            <span class="ref-mode">
              <span v-if="prompts[i]" class="mode-tag" :class="modeOf(prompts[i]).cls">{{ modeOf(prompts[i]).tag }}</span>
              <span v-if="prompts[i]" class="hint">{{ modeOf(prompts[i]).text }}</span>
            </span>
            <span style="flex:1"></span>
            <!-- 视频分辨率（从提示词上方移入；宽度按内容自适应，不撑满父布局） -->
            <label class="card-res res-fit" v-if="vstate[i]">视频分辨率
              <select v-model="vstate[i].res" :disabled="vBusy || (vstate[i] && vstate[i].confirmed)" @change="saveVideos()">
                <option v-for="o in optsFor(i)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <button class="btn sm" :class="{ regen: vstate[i] && vstate[i].files.length }"
                    :disabled="vBusy || !prompts[i] || !prompts[i].text.trim()" @click="genV(i)">
              生成视频
            </button>
          </div>
        </div>

        <!-- 分区3：视频预览（生成按钮与分辨率都在左侧 H3 提示词区；已生成的视频任何状态都能播放）
             同一镜头的多个版本上下摆放，最多显示最新 2 个（两者平分上方剩余区域）；
             点击哪个哪个变当前版本（蓝框）= 即选中（生成完成自动选中最新版，无「采用」按钮） -->
        <div class="zone-3">
          <div class="row-head"><span class="zone-tag">视频生成</span></div>
          <!-- 固定 2 个等高槽位（标题 / 文案之外的空间平分），每槽一个 16:9 播放框；
               没有视频时两槽都显示占位符；只有 1 个视频时占第 1 槽、第 2 槽仍是占位符 → 行高与份高都不跳动。
               点击哪个哪个变当前版本（蓝框） -->
          <div class="vid-stack" :class="{ 'card-busy': vstate[i] && vstate[i]._gen }">
            <span v-if="vstate[i] && vstate[i]._gen" class="busy-txt"><i class="spin"></i>生成中…</span>
            <div v-for="(v, si) in slotList(i)" :key="'slot' + si" class="vslot">
            <div v-if="v" class="video-box"
                 :class="{ cur: v.k === curIdx(i), stalevid: videoStale(i) }"
                 :title="'点击选为当前版本（第 ' + (v.k + 1) + ' 版）'" @click="setVideo(i, v.k)">
              <video v-if="videoSrc(v.f)" :src="videoSrc(v.f)" controls></video>
              <!-- 防误播遮挡层：盖住画面区（底部控制条除外），点它 = 选中该版本，不会触发播放；
                   播放只能通过视频自带控制条的播放按钮 -->
              <div v-if="videoSrc(v.f)" class="vid-shield"></div>
              <div v-else class="ph">镜头 {{ i + 1 }}<br>加载中…</div>
              <span class="vid-ver">{{ v.k + 1 }}/{{ vstate[i].files.length }}</span>
            </div>
              <div v-else class="video-box">
                <div class="ph">镜头 {{ i + 1 }}<br>待生成</div>
              </div>
            </div>
          </div>
          <div class="vmeta">
            <b>镜头 {{ i + 1 }}</b> <span class="hint">{{ s.chars }} · {{ durOf(i) }}s</span>
            <span v-if="genTextV(i)" class="gen-ms" :class="{ live: vstate[i] && vstate[i]._genAt }">{{ genTextV(i) }}</span>
            <!-- 本次生成实际使用的参考素材（生成时快照落库，素材后改了也不影响「这一版视频用了什么」的追溯） -->
            <div class="hint refs-used" v-if="vstate[i] && vstate[i].refsUsed"
                 :title="refsTitle(vstate[i].refsUsed)">{{ refsText(vstate[i].refsUsed) }}</div>
            <!-- 脏标记：提示词/分镜/素材图在上次视频生成之后又变了 -->
            <div v-if="videoStale(i)" class="stale" style="margin-top:4px" @click="ackVideo(i)" title="点击消除提示">
              上游已更新 · <b>生成视频</b>后消失
            </div>
          </div>
        </div>
      </div>

      <!-- 手动加镜头：放在已生成镜头的最后一行（无镜头时就是唯一入口） -->
      <div class="shot-row add-row" @click="addRow">
        <span class="add-plus">＋</span>
        <span class="add-txt">手动添加镜头</span>
      </div>
    </div>

    <!-- 2026-09-23：本块底部的三行说明文字（整块生成耗时 / 角色·场景档案产出条数提示 / 分阶段操作提示）
         已按需求全部移除，产物下方不再挂任何说明行；批量入口在模块标题行 -->

    <!-- 批量按钮：Teleport 到块 3 标题行、状态文本左边（App.vue 的 #shots-batch），常驻可见。
         空闲 = 「批量生成提示词 / 批量生成视频」；跑动中 = 「停止批量」（再点不响应）；
         已请求停止 = 「停止中…」（禁点，当前子任务跑完自动恢复） -->
    <Teleport v-if="tpReady" to="#shots-batch">
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && prompts.some(p => p.text.trim()), danger: batchP || batchPStop }"
              :disabled="batchPStop || batchV"
              :title="batchP ? '点击停止：当前镜头跑完后，剩余镜头不再执行' : '重新生成所有镜头的提示词，或只补缺失的'"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchV && !batchVStop && shots.some((_, i) => vstate[i] && vstate[i].files.length), danger: batchV || batchVStop }"
              :disabled="batchVStop || batchP"
              :title="batchV ? '点击停止：当前镜头跑完后，剩余镜头不再执行' : '重新生成所有镜头的视频，或只补没有视频的镜头'"
              @click="batchVideos">
        <span v-if="batchVStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchV">停止批量({{ batchVN }}/{{ batchVTotal }})</span>
        <span v-else>批量生成视频</span>
      </button>
    </Teleport>

    <!-- 批量范围选择弹窗（全部重新生成 / 只生成缺失的） -->
    <div v-if="askBatch" class="modal-mask" @click.self="askBatch = null">
      <div class="modal">
        <div class="modal-title">批量生成{{ askBatch.kind === 'prompts' ? '提示词' : '视频' }}</div>
        <div class="modal-body">
          共 {{ shots.length }} 个镜头，请选择生成范围：
          <div style="margin-top:6px">
            <b>全部重新生成</b> —— {{ askBatch.kind === 'prompts'
              ? '覆盖所有镜头的已有提示词（已生成的视频保留，标 ⚠ 上游已更新）'
              : '所有镜头都出新视频，新版本追加、旧版本保留可切换' }}；
          </div>
          <div><b>只生成缺失的</b> —— {{ askBatch.kind === 'prompts'
            ? '只为还没有提示词的镜头生成'
            : '只为还没有任何视频文件的镜头出片（已生成但未采用的不动）' }}。</div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="askBatchAll">全部重新生成</button>
          <button class="btn" @click="askBatchMissing">只生成缺失的</button>
          <button class="btn ghost" @click="askBatch = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog, secs, dbgPrompt } from './ulog.js'
import { composeSystem, normalizeProfile } from './prompts.js'
import { durWarnings } from './promptlib.js'
import { parseRes, resLabel, optsWith, clampDur, seg, joinPath } from './resutil.js'
import { touchRevs, sigEq } from './stale.js'

// 代码固定的身份说明与输出契约（JSON 三块 + json 模式顶层必须是对象）
const IDENTITY = '你是资深漫剧分镜师。任务：把漫剧化改编稿拆分为镜头列表，并同时产出角色档案与场景档案。'
const CONTRACT = `只输出一个 JSON 对象，不要输出任何解释、注释或 Markdown 代码块，格式如下：
{"shots":[{"scene":"地点·内外-时段","chars":"角色A、角色B","action":"画面与动作描述（可拍摄）","dialogue":"对白，无则空串","camera":"镜头语言(如:中景缓推/特写/全景)","dur":8}],"characters":[{"name":"角色名","role":"主人公/配角/反派","profile":"中文档案，每行一个字段「字段名：值」，全角冒号，字段顺序 姓名/身份/性别/年龄段/身形体态/脸型骨架/发型发饰/胡须/服装/配饰道具/主色调/神态/依据","prompt":"中文生图提示词","negative":"中文负向提示词"}],"scenes":[{"name":"场景名","profile":"中文档案，每行一个字段「字段名：值」，字段顺序 场景名/内外/时段/空间结构/主要陈设/材质细节/光线与色温/天气氛围/空镜声明","prompt":"中文生图提示词","negative":"中文负向提示词"}]}
硬性约束：shots 至少 1 个且按时间顺序覆盖改编稿全部内容；dur 必须是 4-15 之间的整数秒（含 4 与 15）；shots[].scene 必须写完整场景名，严禁"同上"之类省略写法；scenes[].name 与 shots[].scene 逐字一致；characters[].name 与 shots[].chars 中出现的角色逐字一致；每个角色/场景都必须给 profile（不得留空、不得写"未知"），prompt 必须与其 profile 一致（不得写入 profile 里没有任何线索的关键设定）。`

// 内置兜底：项目提示词文件（shots.md 等）整体丢失且无法补齐时才用到
const FALLBACK = IDENTITY + '\n' + CONTRACT + `
补充规则：一个连续动作单元一镜；对白保留原句；时长由内容决定（对白按 字数÷4.5 字/秒 估算），宁短勿长；每 1000 字改编稿约 8-15 个镜头；角色档案先穷举点名（有台词/被称呼/有独立动作），再从台词的自称与他称反推身份，最后做差异化设计（任意两人至少 3 个维度不同、含 1 个剪影级差异、各有 1 个识别锚点）。`

// ---- H3 提示词（原阶段5）----
// 🔴 提示词格式（三段式/六段式）全部由规范文件承载：h3.md（基础模式 T2VA/I2VA/FL2VA/L2VA）、
//    h3ref.md（参考模式 Ref2VA 六段），代码不硬编码任何官方格式——按镜头素材分流加载。
const P_IDENTITY = 'You are a prompt engineer for the MiniMax H3 video generation model. Task: write the video prompt for ONE comic-drama shot, strictly following the official H3 prompt format for the task type given below.'
// 拼装级契约：只约束「输出什么形态的东西」，不规定段落数与字段名（那是 md 规范的事）
const P_CONTRACT = `Output ONLY the final prompt text for this single shot, in English (dialogue and on-screen text kept in their original language).
No explanation, no numbering, no Markdown code block, no extra shots. The section/field structure is defined by the style spec above — follow it exactly.`
const P_FALLBACK = P_IDENTITY + '\n' + P_CONTRACT + `
The style spec file is unavailable; follow the official MiniMax H3 prompt structure for the given task type exactly.`

const MAX_REF_IMG = 9
const MAX_REF_VID = 3
// 整段 mp4 的 base64 很占内存（字符串约是文件体积的 2.7 倍），多镜头累积会拖垮渲染进程，
// 因此只保留最近这几个的缓存（在生成/换集等非渲染时机清理）。
// 每行视频区最多同时显示 2 个版本 → 4 个镜头最多 8 个，留 8 个缓存避免来回重读。
const B64_KEEP = 8
// 参考视频（第 5 块里选的素材）同样按 base64 预览，另用一份小缓存（生成/换集时一起清理）
const REFV_KEEP = 6

export default {
  name: 'StageShots',
  data() {
    return {
      shots: [], busy: false,
      // H3 提示词（原 StagePrompts）
      prompts: [], pBusy: false, _autoEp: null, _ref64: {}, _refv: {},
      // 视频生成（原 StageVideos）
      vstate: {}, vBusy: false, _b64: {},
      // 批量任务（块 3 标题行的两个按钮）：batch*=队列在跑；*Stop=已点停止等当前子任务收尾；
      // askBatch=范围选择弹窗 { kind: 'prompts' | 'videos' }
      // batch*N/Total=按钮上的进度（正在生成第 N 个 / 共 Total 个），跑完/停止归零
      batchP: false, batchPStop: false, batchV: false, batchVStop: false, askBatch: null,
      batchPN: 0, batchPTotal: 0, batchVN: 0, batchVTotal: 0,
      // 🔴 Teleport 延迟挂载开关：块 3 的 <section :key> 切集时整棵重建，Vue 在脱离文档的子树里
      // 挂载本组件时 document.querySelector('#shots-batch') 拿不到目标 → 内容被静默丢弃。
      // 必须 mounted + nextTick（DOM 已插入文档）后再渲染 Teleport
      tpReady: false,
      // 有生成在跑时 = 该次生成所属的集 id；切集时改置 'SWITCHED'（收尾写库守卫据此丢弃，防旧集数据写进新集）
      _busyEpId: null,
      // 当前点选高亮的镜头行（点击行内任意空白处高亮，点其他行切换）
      sel: -1
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    adapted() { return this.st.current ? this.st.current.adapted : '' },
    chars() { return this.st.current ? this.st.current.chars : [] },
    scenes() { return (this.st.current && this.st.current.scenes) || [] },
    epProjectId() { return this.st.current ? this.st.current.projectId : null },
    /** 依赖每秒自增的 tick，让「生成中 已用 X」实时刷新 */
    live() { return this.pl.tick },
    allPromptsFilled() { return this.prompts.length > 0 && this.prompts.every(p => p.text.trim()) },
    /** 参考素材上限（模板里显示「最多 N 张/个」用；method 里放常量不会挂到实例上，必须走 computed） */
    maxRefImg() { return MAX_REF_IMG },
    maxRefVid() { return MAX_REF_VID },
    allConfirmed() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.vstate[i] && this.vstate[i].confirmed)
    }
  },
  watch: {
    'st.current'(ep) {
      // 生成在跑时切了集：自动请求停止（当前子任务跑完即停，剩余丢弃）；
      // 并把 _busyEpId 置哨兵，让在途子任务的收尾写库被守卫丢弃——否则旧集数据会写进新集
      if (this.batchP || this.batchV || this.pBusy || this.vBusy) {
        this.batchPStop = this.batchVStop = true
        this._busyEpId = 'SWITCHED'
        this.$root.toast('已切换剧集：当前镜头完成后批量停止，剩余任务丢弃')
      }
      if (ep) this.initAll(ep)
    },
    // 别块（角色&场景的「一键填充」）写过 prompts 工件 → 用最新工件重建本块表单，
    // 否则本块的本地副本会在下次保存时把那次填充覆盖回去（同引用，watch('st.current') 不触发）
    'st.current.promptsSyncAt'() { if (this.st.current && !this.pBusy) this.initPrompts(this.st.current) },
    'shots.length'() { /* 分镜数量变化时同步提示词/视频槽位（保持每行三区对齐） */ this.syncSlots() },
    // 第 2 块点「生成分镜」进来 → 不需要任何操作直接开始生成
    'pl.autoShots'(v) { if (v) { this.pl.autoShots = false; this.tryAutoShots() } },
    'pl.active'(v) {
      // 进入提示词阶段：自动开始生成（只补空的镜头，不覆盖已有内容）
      if (v === 4 && !this.pl.done[4]) {
        const ep = this.st.current
        if (!ep) return
        // 先按最新分镜重建表单：各阶段组件在打开剧集时就全挂载了，那时分镜还不存在，
        // 不重建会拿空列表去生成（下游索引越界）
        this.initPrompts(ep)
        if (!this.shots.length || this._autoEp === ep.id) return
        this._autoEp = ep.id
        this.$root.toast('已自动开始生成提示词（逐镜头进行，可随时在标题行点「停止批量」）')
        this.runBatchP(false)
      }
      // 进入视频阶段：按最新分镜重建每镜头的状态槽
      if (v === 5 && !this.vBusy && this.st.current) this.initVideos(this.st.current)
    }
  },
  created() {
    if (this.st.current) this.initAll(this.st.current)
    // 组件可能晚于标记置位才挂载（换集重挂载）：挂载时兜底检查一次
    if (this.pl.autoShots) { this.pl.autoShots = false; this.tryAutoShots() }
  },
  /** 🔴 批量按钮的 Teleport 延迟挂载：mounted 后 DOM 才真正插入文档，#shots-batch 此时才可被 querySelector 命中 */
  mounted() {
    this.$nextTick(() => { this.tpReady = true })
  },
  /** 卸载时立刻释放视频 base64，避免常驻内存（视频是重内存块） */
  beforeUnmount() { this._b64 = {}; this._refv = {} },
  methods: {
    clampDur,   // 模板里 @change 夹取用
    resLabel,
    /* ================= 初始化 ================= */
    initAll(ep) {
      this.initShots(ep)
      this.initPrompts(ep)
      this.initVideos(ep)
    },
    initShots(ep) {
      this.shots = JSON.parse(JSON.stringify(ep.shots || []))
      // 2026-09-23：本块不再展示档案产出条数提示行，
      // 故不再在本地保存一份档案副本（明细只在「角色 & 场景」块维护）
    },
    /** 分镜数量变化时，同步提示词与视频槽位（补齐/裁掉，保证每行三区都有内容） */
    syncSlots() {
      const ep = this.st.current
      if (!ep) return
      while (this.prompts.length < this.shots.length) this.prompts.push({ text: '', refs: emptyRefs() })
      if (this.prompts.length > this.shots.length) this.prompts.length = this.shots.length
      ep.shots.forEach((_, i) => {
        if (!this.vstate[i]) this.vstate[i] = { files: [], cur: -1, confirmed: false, res: (ep.res && ep.res.vid) || '864x480' }
      })
    },
    /* ================= 分镜（原阶段3） ================= */
    /** 自动生成分镜入口：改编稿非空才触发（守卫防误跑） */
    tryAutoShots() {
      if (this.busy || !this.adapted.trim()) return
      this.generate()
    },
    addRow() {
      this.shots.push({ scene: '', chars: '', action: '', dialogue: '', camera: '中景', dur: 8 })
    },
    /** 项目里已存在的角色/场景名（项目级资产目录 + 本集档案），让 LLM 跨集沿用同名同设定 */
    async knownNames() {
      const chars = new Set(), scenes = new Set()
      const ep = this.st.current || {}
      for (const c of ep.chars || []) if (c && c.name) chars.add(c.name)
      for (const s of ep.scenes || []) if (s && s.name) scenes.add(s.name)
      try {
        const r = await window.studio.projectAssets(this.st.workspace, ep.projectId)
        for (const g of (r && r.characters) || []) if (g && g.name) chars.add(g.name)
        for (const g of (r && r.scenes) || []) if (g && g.name) scenes.add(g.name)
      } catch (_) { /* 拿不到资产目录就用本集档案 */ }
      return { chars: [...chars], scenes: [...scenes] }
    },
    async generate() {
      this.busy = true
      const t0 = Date.now()
      this.pl.beginGen(2)
      const L = stepLog('阶段3 分镜脚本')
      L.start('正在生成分镜：LLM 按改编稿拆分镜头并产出角色/场景档案（改编稿 ' + this.adapted.length + ' 字）')
      try {
        const system = await composeSystem({
          identity: IDENTITY, specs: ['shots.md', 'profile.md', 'chars.md', 'scenes.md'], contract: CONTRACT, fallback: FALLBACK
        })
        // 「整个漫剧的综合信息」：除本集改编稿外，带上项目里已存在的角色/场景名（跨集共享，要求沿用）
        const known = await this.knownNames()
        const knownLines = []
        if (known.chars.length) knownLines.push('本项目已存在的角色（剧情中再次出现时请沿用同一名字与设定，不要改名）：' + known.chars.join('、'))
        if (known.scenes.length) knownLines.push('本项目已存在的场景（同一地点请沿用同一场景名）：' + known.scenes.join('、'))
        const user = '改编稿：\n\n' + this.adapted +
          (knownLines.length ? '\n\n【项目已有设定】\n' + knownLines.join('\n') : '')
        dbgPrompt('阶段3 分镜脚本', '文字模型', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.5, maxTokens: 8192, json: true, label: '阶段3 分镜脚本' })
        const parsed = JSON.parse(require_json(text))
        const used = new Set()
        const shots = pickArr(parsed, ['shots', '镜头', '镜头列表'], used)
        if (!shots || !shots.length) throw new Error('LLM 未返回镜头数组')
        const chars = pickArr(parsed, ['characters', 'chars', '角色档案', '角色'], used) || []
        const scenes = pickArr(parsed, ['scenes', '场景档案', '场景'], used) || []

        // 镜头：场景名兜底（模型仍写"同上"就替换为上一镜头的场景名），时长夹取
        let prev = ''
        this.shots = shots.map(s => {
          const scene = fixSceneName(s.scene, prev)
          prev = scene
          return {
            scene, chars: s.chars || '', action: s.action || '',
            dialogue: s.dialogue || '', camera: s.camera || '', dur: clampDur(s.dur)
          }
        })

        // 角色 / 场景档案：与已有档案合并（出过图、锁定过的绝不丢）
        const chars2 = mergeArchive(normArchive(chars, 'character'), this.st.current.chars)
        const scenes2 = mergeArchive(normArchive(scenes, 'scene'), this.st.current.scenes)

        await this.st.saveArtifact('shots', this.shots)
        await this.st.saveArtifact('chars', chars2)
        await this.st.saveArtifact('scenes', scenes2)
        // 记录「本次分镜/档案基于哪个改编稿版本」→ 改编稿再改就触发模块级脏标记
        await touchRevs(this.st, r => { r.shotsAdapted = r.adapted || 0 })
        this.syncSlots()
        this.pl.markGen(2, Date.now() - t0)
        L.done('分镜生成完成：' + this.shots.length + ' 个镜头 · 角色档案 ' + chars2.length +
          ' 个 · 场景档案 ' + scenes2.length + ' 个', Date.now() - t0)
        this.$root.toast('已生成 ' + this.shots.length + ' 个镜头、' + chars2.length + ' 个角色、' + scenes2.length + ' 个场景，请检查编辑后确认')
      } catch (e) {
        L.fail('分镜生成失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false; this.pl.endGen(2) }
    },
    async confirmShots() {
      // 确认前再兜底夹取一次（4~15s 含边界），确保下游视频生成的秒数永远合法
      this.shots.forEach(s => { s.dur = clampDur(s.dur) })
      await this.st.saveArtifact('shots', this.shots)
      this.pl.confirm(2, this.st.current.id)
      this.$root.toast('分镜已确认，共 ' + this.shots.length + ' 镜')
    },
    /* ---- 分镜编辑（脏标记数据源） ---- */
    /** 落库守卫：生成在跑时切了集（_busyEpId = 'SWITCHED'）→ 在途子任务的收尾写库直接丢弃，
     *  防止旧集的 shots/prompts/videoState 被写进新切换的集（st.saveArtifact 写的是 this.current.id） */
    canSave() {
      return !(this._busyEpId && this.st.current && this._busyEpId !== this.st.current.id)
    },
    async saveShots() {
      if (!this.canSave()) return
      await this.st.saveArtifact('shots', JSON.parse(JSON.stringify(this.shots)))
    },
    /** 分镜字段被编辑：镜头版本 +1（本行提示词的脏标记依据）并立即落库 */
    async touchShot(s) {
      s._rev = (s._rev || 1) + 1
      await this.saveShots()
    },
    askDelShot(i) {
      if (!window.confirm('删除镜头 ' + (i + 1) + '？该镜头的分镜、提示词与视频记录将一并移除（已生成的视频文件仍在磁盘）。')) return
      this.delShot(i)
    },
    async delShot(i) {
      this.shots.splice(i, 1)
      this.prompts.splice(i, 1)
      // vstate 以镜头下标为 key：删除后整体前移补位
      const vs = {}
      Object.keys(this.vstate).map(Number).sort((a, b) => a - b).forEach(k => {
        if (k === i) return
        vs[k > i ? k - 1 : k] = this.vstate[k]
      })
      this.vstate = vs
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      this.$root.toast('已删除镜头，后续镜头已前移')
    },
    /* ================= H3 提示词（原阶段5） ================= */
    initPrompts(ep) {
      const shots = ep.shots || []
      let changed = false
      if (ep.prompts && ep.prompts.length) {
        this.prompts = JSON.parse(JSON.stringify(ep.prompts))
      } else {
        this.prompts = shots.map(() => ({ text: '', refs: emptyRefs() }))
        changed = true
      }
      // 分镜数量变了（重新生成分镜）：补齐/裁掉多余，保证每个镜头都有提示词槽
      while (this.prompts.length < shots.length) { this.prompts.push({ text: '', refs: emptyRefs() }); changed = true }
      if (this.prompts.length > shots.length) { this.prompts.length = shots.length; changed = true }
      // 老数据没有 refs 字段要补；_gen/_genAt 是运行时字段，绝不能从库里读回来（否则永远转圈）
      this.prompts.forEach(p => {
        if (!p.refs) { p.refs = emptyRefs(); changed = true }
        if (p._gen || p._genAt) { delete p._gen; delete p._genAt; changed = true }
      })
      if (changed) this.savePrompts()
    },
    /** 卡片上的耗时文案：生成中实时计时 / 完成后显示本次耗时 */
    genTextP(i) {
      void this.live
      const p = this.prompts[i]
      if (!p) return ''
      if (p._genAt) return '生成中 已用 ' + fmtMs(Date.now() - p._genAt)
      return p.genMs ? '耗时 ' + fmtMs(p.genMs) : ''
    },
    /** 角色 + 场景档案（阶段3 产出的设定，作为提示词的固定外观依据） */
    charProfiles() {
      return this.chars.map(c => c.name + ': ' + c.prompt).join('\n')
    },
    sceneProfiles() {
      return this.scenes.map(s => s.name + ': ' + s.prompt).join('\n')
    },
    async savePrompts() {
      if (!this.canSave()) return
      // _gen / _genAt 是纯 UI 状态（生成中），绝不能落库，否则重开就是「永远转圈」
      const clean = this.prompts.map(p => {
        const o = { ...p, refs: { ...(p.refs || emptyRefs()) } }
        delete o._gen; delete o._genAt
        return o
      })
      await this.st.saveArtifact('prompts', clean)
    },
    /* ---- 提示词 / 视频的脏标记（上游=分镜行 + 引用的素材图） ---- */
    /** 素材绝对路径 → 图片版本号（来自角色&场景档案的 _imgRev；纯读取，不改任何状态） */
    assetRevMap() {
      const m = {}
      const ep = this.st.current
      if (!ep || !ep.assetsDir) return m
      const add = (list, kind) => {
        for (const c of list || []) {
          const rev = c._imgRev || 1
          for (const f of c.candidates || []) {
            m[joinPath(joinPath(joinPath(ep.assetsDir, kind), seg(c.name)), f)] = rev
          }
        }
      }
      add(this.chars, 'characters')
      add(this.scenes, 'scenes')
      return m
    },
    /** 本行当前引用的素材的版本签名 */
    sigAssets(refs) {
      const map = this.assetRevMap()
      const out = {}
      for (const p of [...(refs.images || []), ...(refs.videos || []), refs.first, refs.last]) {
        if (p && map[p] != null) out[p] = map[p]
      }
      return out
    },
    /** 提示词「应该」匹配的上游签名（分镜版本 + 素材版本 + 素材构成） */
    curPromptSig(i) {
      const refs = (this.prompts[i] && this.prompts[i].refs) || {}
      return {
        shotRev: (this.shots[i] && this.shots[i]._rev) || 1,
        assets: this.sigAssets(refs),
        // 素材构成（数量/有无）决定官方任务类型与规范文件 → 变了提示词就过期
        refs: { img: (refs.images || []).length, vid: (refs.videos || []).length, first: refs.first ? 1 : 0, last: refs.last ? 1 : 0 }
      }
    },
    /** 提示词是否过期：生成后分镜/素材变过，且用户没有点掉提示 */
    promptStale(i) {
      const p = this.prompts[i]
      if (!p || !p._sig || !p.text || !p.text.trim()) return false
      const cur = this.curPromptSig(i)
      if (sigEq(p._sig, cur)) return false
      return !p._ack || !sigEq(p._ack, cur)
    },
    async ackPrompt(i) {
      const p = this.prompts[i]
      p._ack = this.curPromptSig(i)
      await this.savePrompts()
      this.$root.toast('提示已消除')
    },
    /** 手动编辑提示词：版本 +1（已生成的视频随之过期） */
    async touchPrompt(i) {
      const p = this.prompts[i]
      p._rev = (p._rev || 1) + 1
      await this.savePrompts()
    },
    /** 视频「应该」匹配的上游签名（提示词版本 + 分镜版本 + 素材版本） */
    curVideoSig(i) {
      const p = this.prompts[i] || {}
      return {
        promptRev: p._rev || 1,
        shotRev: (this.shots[i] && this.shots[i]._rev) || 1,
        assets: this.sigAssets(p.refs || {})
      }
    },
    videoStale(i) {
      const v = this.vstate[i]
      if (!v || !v._sig || !v.files.length) return false
      const cur = this.curVideoSig(i)
      if (sigEq(v._sig, cur)) return false
      return !v._ack || !sigEq(v._ack, cur)
    },
    async ackVideo(i) {
      const v = this.vstate[i]
      v._ack = this.curVideoSig(i)
      await this.saveVideos()
      this.$root.toast('提示已消除')
    },
    /** 模块级脏标记（改编稿在分镜生成之后又被改过）统一显示在模块标题行，见 App.vue 的 stage-head */
    /* ---- 参考素材（都可不选；选什么用什么） ---- */
    /** 本镜头参考素材 → 官方任务类型（提示词规范分流与 UI 路线标签共用同一判定） */
    h3ModeOf(r) {
      const refs = r || {}
      if ((refs.images || []).length || (refs.videos || []).length) return 'Ref2VA'
      if (refs.first && refs.last) return 'FL2VA'
      if (refs.first) return 'I2VA'
      if (refs.last) return 'L2VA'
      return 'T2VA'
    },
    /** 参考素材绝对路径 → 所属档案名（提示词里标注 <Picture N> 的来源，帮助模型定义 Subject） */
    refOwner(abs) {
      const ep = this.st.current
      if (!ep || !ep.assetsDir || !abs) return ''
      const box = [[this.chars, 'characters', 'character sheet'], [this.scenes, 'scenes', 'scene sheet']]
      for (const [list, kind, label] of box) {
        for (const c of list || []) {
          const dir = joinPath(joinPath(ep.assetsDir, kind), seg(c.name))
          if (abs.indexOf(dir) === 0) return ' (' + label + ': ' + c.name + ')'
        }
      }
      return ''
    },
    /** 分镜 dialogue → 逐条「说话人 + 台词」，随任务一起发给模型钉死说话人（换行分隔，兼容全角冒号与「名（备注）」） */
    dialogueLines(s) {
      const raw = String((s && s.dialogue) || '').trim()
      if (!raw) return []
      const out = []
      for (const ln of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        const m = ln.match(/^([^：:]{1,24})[：:]\s*([\s\S]+)$/)
        if (!m) { out.push({ name: '', note: '', text: ln }); continue }
        let name = m[1].trim(), note = ''
        const pm = name.match(/^(.*?)[（(]([^）)]*)[）)]$/)
        if (pm) { name = pm[1].trim(); note = pm[2].trim() }
        out.push({ name: name, note: note, text: m[2].trim() })
      }
      return out
    },
    /** 本镜头当前选择的素材 → 将走哪条生成路线（始终显示） */
    modeOf(p) {
      const r = p.refs || {}
      const nImg = (r.images || []).length
      const nVid = (r.videos || []).length
      const mode = this.h3ModeOf(r)
      if (mode === 'Ref2VA') {
        const parts = []
        if (nImg) parts.push('参考图×' + nImg)
        if (nVid) parts.push('参考视频×' + nVid)
        return { cls: 'ref', tag: 'Ref2VA',
          text: '已选 ' + parts.join(' + ') + ' → 参考模式 ref2va（官方六段提示词，规范文件 h3ref.md）' }
      }
      if (mode === 'FL2VA') {
        return { cls: 'flf', tag: 'FL2VA', text: '首帧 + 尾帧 → 官方首尾帧模式（三段提示词 · fl2va）' }
      }
      if (mode === 'I2VA') {
        return { cls: 'flf', tag: 'I2VA', text: '仅首帧 → 官方首帧模式（三段提示词 · fl2va）' }
      }
      if (mode === 'L2VA') {
        return { cls: 'flf', tag: 'L2VA', text: '仅尾帧 → 官方尾帧模式（三段提示词 · fl2va）' }
      }
      return { cls: 't2v', tag: 'T2VA',
        text: '未选素材 → 纯文字生成（官方三段提示词 · fl2va）' }
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
    /** 参考视频（第 5 块素材）：与镜头视频一样带播放控件预览，同样走 base64（含小缓存上限） */
    refVidSrc(abs) {
      if (!abs) return ''
      if (this._refv[abs] !== undefined) return this._refv[abs]
      this._refv[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) this._refv[abs] = 'data:video/mp4;base64,' + b64
        else delete this._refv[abs]
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
      await this.savePrompts()
      if (added < files.length) this.$root.toast('已达上限，本次只加入 ' + added + ' 个')
    },
    async delRef(i, kind, k) {
      this.prompts[i].refs[kind].splice(k, 1)
      await this.savePrompts()
    },
    async pickFrame(i, which) {
      const files = await window.studio.pickFiles('image')
      if (!files || !files.length) return
      this.prompts[i].refs[which] = files[0]
      await this.savePrompts()
    },
    async clearFrame(i, which) {
      this.prompts[i].refs[which] = null
      await this.savePrompts()
    },
    /* ---- 生成提示词 ---- */
    async genP(i, ctx) {
      const s = this.shots[i]
      if (!s) return false
      const p = this.prompts[i]
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.pBusy = true
      p._gen = true
      p._genAt = Date.now()   // 「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(4)
      const L = stepLog('阶段5 H3提示词')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在生成第' + (i + 1) + '个镜头的提示词' + prog)
      try {
        const refs = p.refs || {}
        // 官方任务类型由素材构成决定（与引擎路由一致：参考图/视频→ref2va，其余→fl2va）
        const mode = this.h3ModeOf(refs)
        // 规范文件按模式分流：基础模式 h3.md（三段式）/ 参考模式 h3ref.md（六段式）——格式细节全在 md 里
        const system = await composeSystem({
          identity: P_IDENTITY,
          specs: mode === 'Ref2VA' ? ['h3ref.md'] : ['h3.md'],
          contract: P_CONTRACT, fallback: P_FALLBACK
        })
        let user = 'Character sheets (use as-is):\n' + (this.charProfiles() || '(none)') +
          '\n\nScene sheets (use as-is):\n' + (this.sceneProfiles() || '(none)') +
          '\n\nShot ' + (i + 1) + ' (duration ' + s.dur + ' seconds):\n' + JSON.stringify(s, null, 2) +
          '\n\nOfficial task type for this shot: ' + mode + '. Follow the matching branch of the style spec exactly.\n'
        // 对白锁人：把「谁说哪句」逐条列清随任务下发，模型不必猜（说话人漂移是本模块最大回归源）
        const dlg = this.dialogueLines(s)
        if (dlg.length) {
          const who = (n) => {
            if (!n) return '(speaker name missing in the shot text)'
            const hit = (this.chars || []).find(c => c.name === n) || (this.scenes || []).find(c => c.name === n)
            let pic = ''
            if (hit && mode === 'Ref2VA') {
              const k = (refs.images || []).findIndex(f => this.refOwner(f).indexOf(n) >= 0)
              if (k >= 0) pic = ' → <Picture ' + (k + 1) + '>'
            }
            return n + pic
          }
          user += '\nDialogue lines of this shot. The speaker is FIXED by the name before the colon — the line must be spoken by exactly that person, ' +
            'never reassigned to whoever the camera focuses on or reacts. Bracketed notes follow the off-screen / voiceover rules of the spec:\n' +
            dlg.map((l, k) => (k + 1) + '. ' + who(l.name) + (l.note ? ' [' + l.note + ']' : '') + ' says: ' + l.text).join('\n') + '\n'
        }
        if (mode === 'Ref2VA') {
          // 参考模式：把实际附给模型的资产按顺序编号（与 ref_images/ref_videos 注入顺序一致），
          // 模型据此写 <Subject N> 定义；首尾帧在参考模式下不参与生成，不提
          const inv = []
          refs.images.forEach((f, k) => inv.push('<Picture ' + (k + 1) + '> = ' + this.baseName(f) + this.refOwner(f)))
          refs.videos.forEach((f, k) => inv.push('<Video ' + (k + 1) + '> = ' + this.baseName(f)))
          user += '\nThe reference assets below are attached to the model in exactly this order. ' +
            'Define each reusable subject as <Subject N> sourced from these <Picture N>/<Video N> labels, per the spec:\n' + inv.join('\n')
        } else {
          // 基础模式：首/尾帧是真实帧锚点，按官方对齐句标签告知
          const att = []
          if (refs.first) att.push('<Picture 1> = the first frame image attached to the model')
          if (refs.last) att.push('<Picture 2> = the last frame image attached to the model')
          if (att.length) user += '\nFrame images attached to the model (use these labels in the alignment line and the body):\n' + att.join('\n')
        }
        dbgPrompt('阶段5 H3提示词', '文字模型 · 第' + (i + 1) + '镜 · ' + mode, [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 2048, label: '阶段5 H3提示词' })
        p.text = text.trim()
        const ms = Date.now() - t0
        p.genMs = ms                  // 逐条耗时（持久化在 prompts.json，显示在该镜头行上）
        p._rev = (p._rev || 1) + 1    // 内容变了：已生成的视频随之标 ⚠
        p._sig = this.curPromptSig(i) // 记录生成时的上游签名（分镜版本 + 素材版本）
        delete p._genAt
        await this.savePrompts()
        this.pl.markGen(4, ms)
        L.done('第' + (i + 1) + '个镜头的提示词生成完成：' + text.trim().length + ' 字', ms)
        return true
      } catch (e) {
        L.fail('第' + (i + 1) + '个镜头的提示词生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { delete p._genAt; p._gen = false; this.pBusy = false; this.pl.endGen(4); if (!this.vBusy) this._busyEpId = null }
    },
    /* ================= 批量任务（块 3 标题行的两个按钮） ================= */
    /** 「批量生成提示词」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围 */
    batchPrompts() {
      if (this.batchP) { this.batchPStop = true; this.$root.toast('停止中：当前镜头完成后停止，剩余镜头不再执行'); return }
      if (this.batchV) { this.$root.toast('视频批量进行中，请先等它结束或停止'); return }
      if (!this.shots.length) { this.$root.toast('还没有镜头，先点「生成分镜」'); return }
      this.askBatch = { kind: 'prompts' }
    },
    /** 「批量生成视频」：跑动中点击 = 请求停止；空闲先校验提示词齐全（缺哪个全列出）再弹框 */
    batchVideos() {
      if (this.batchV) { this.batchVStop = true; this.$root.toast('停止中：当前镜头完成后停止，剩余镜头不再执行'); return }
      if (this.batchP) { this.$root.toast('提示词批量进行中，请先等它结束或停止'); return }
      if (!this.shots.length) { this.$root.toast('还没有镜头，先点「生成分镜」'); return }
      const missing = []
      for (let i = 0; i < this.shots.length; i++) if (!(this.prompts[i] && this.prompts[i].text.trim())) missing.push(i + 1)
      if (missing.length) { this.$root.toast('镜头 ' + missing.join('、') + ' 没有提示词，请先生成提示词'); return }
      this.askBatch = { kind: 'videos' }
    },
    askBatchAll() {
      const k = this.askBatch && this.askBatch.kind
      this.askBatch = null
      if (k === 'prompts') this.runBatchP(true)
      else if (k === 'videos') this.runBatchV(true)
    },
    askBatchMissing() {
      const k = this.askBatch && this.askBatch.kind
      this.askBatch = null
      if (k === 'prompts') this.runBatchP(false)
      else if (k === 'videos') this.runBatchV(false)
    },
    /** 批量生成提示词：all=true 全部重生成并覆盖；false 只补没有提示词的镜头。
     *  逐个顺序执行，batchPStop 置位后当前子任务跑完即停（剩余丢弃），结束统一统计 */
    async runBatchP(all) {
      const L = stepLog('阶段5 H3提示词')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (all || !(this.prompts[i] && this.prompts[i].text.trim())) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成的镜头'); return }
      this.batchP = true; this.batchPStop = false; this.pBusy = true
      this.batchPN = 0; this.batchPTotal = idx.length
      L.start('开始批量生成提示词（' + (all ? '全部重生成，覆盖已有' : '只补缺失') + '）：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头）；可随时点「停止批量」，当前镜头跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchPStop) { stopped = true; break }
          this.batchPN = k + 1
          const okFlag = await this.genP(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成提示词已停止' : '批量生成提示词结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
        if (!badN) this.$root.toast(stopped ? '批量已停止（已完成部分保留）' : '全部提示词已生成')
      } finally {
        this.batchP = false; this.batchPStop = false; this.pBusy = false
        this.batchPN = 0; this.batchPTotal = 0
        if (!this.vBusy) this._busyEpId = null
      }
    },
    async confirmPrompts() {
      await this.savePrompts()
      this.pl.confirm(4, this.st.current.id)
      this.$root.toast('提示词已确认，可在本行生成视频')
    },
    /* ================= 视频生成（原阶段6） ================= */
    initVideos(ep) {
      this._b64 = {}   // 换集必须清缓存，否则会命中上一集的同名镜头视频
      const s = ep.videoState && Object.keys(ep.videoState).length ? JSON.parse(JSON.stringify(ep.videoState)) : {}
      // 迁移：shots 数量变化时补齐；顺手清掉运行时字段
      ep.shots.forEach((_, i) => {
        if (!s[i]) s[i] = { files: [], cur: -1, confirmed: false }
        // 逐条分辨率默认值（未单独设置过 → 取剧集配置）
        if (!s[i].res) s[i].res = (ep.res && ep.res.vid) || '864x480'
      })
      Object.keys(s).forEach(k => { delete s[k]._gen; delete s[k]._genAt })
      // 镜头数变少后，超范围的陈旧键（如 13 镜改 10 镜后的 "10"/"11"/"12"）一并清掉，
      // 否则会永远留在 videos.json 里干扰下游（组装块按镜头下标取，多出的键是脏数据）
      const n = ep.shots.length
      Object.keys(s).forEach(k => { if (!/^\d+$/.test(k) || Number(k) >= n) delete s[k] })
      this.vstate = s
    },
    /** 该镜头当前生效的分辨率（未单独设置过 → 剧集配置） */
    resOf(i) {
      const s = this.vstate[i]
      return (s && s.res) || (this.st.current && this.st.current.res && this.st.current.res.vid) || '864x480'
    },
    /** 档位按当前视频模型过滤；该镜头已保存的值不在档位里时补进去 */
    optsFor(i) { return optsWith((this.st.resOptions || {}).vid, this.resOf(i)) },
    /** 该镜头实际用于生成的秒数（分镜脚本的 dur，夹取 4~15 含边界） */
    durOf(i) { return clampDur(this.shots[i] && this.shots[i].dur) },
    /** 时长软校验（只提示不拦截）：台词/发声表演/复合运镜与 dur 不匹配时返回违规说明 */
    durWarn(i) { return durWarnings(this.shots[i] || {}) },
    genTextV(i) {
      void this.live
      const s = this.vstate[i]
      if (!s) return ''
      if (s._genAt) return '生成中 已用 ' + fmtMs(Date.now() - s._genAt)
      return s.genMs ? '耗时 ' + fmtMs(s.genMs) : ''
    },
    curVideo(i) {
      const s = this.vstate[i]
      return s && s.cur >= 0 ? s.files[s.cur] : null
    },
    /** 当前选中版本的下标（默认 = 最新一版） */
    curIdx(i) { return (this.vstate[i] || {}).cur ?? -1 },
    /** 视频区展示的版本列表：最多显示最新 2 个（带上在 files 里的真实下标） */
    vidList(i) {
      const s = this.vstate[i]
      if (!s || !s.files.length) return []
      return s.files.map((f, k) => ({ f, k })).slice(-2)
    },
    /** 视频区固定 2 个槽位（长度恒为 2）：无视频时第 1 槽 null → 显示「待生成」占位，
        只有 1 个视频时第 2 槽 null → 留空（份高、行高都不跳动） */
    slotList(i) {
      const vs = this.vidList(i)
      return [vs[0] || null, vs[1] || null]
    },
    /** 点击某个视频 → 选为当前版本 = 采用（无独立采用/取消采用按钮，点谁选谁） */
    async setVideo(i, k) {
      const s = this.vstate[i]
      if (!s || s.cur === k) return
      s.cur = k
      s.confirmed = true
      await this.saveVideos()
    },
    /** 路径 → 文件名（Windows / 通用分隔符都兼容） */
    baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() },
    /** 视频卡片上的素材一行字：用了什么、什么模式 */
    refsText(ru) {
      const bits = []
      if ((ru.images || []).length) bits.push('参考图×' + ru.images.length + '：' + ru.images.map(f => this.baseName(f)).join('、'))
      if ((ru.videos || []).length) bits.push('参考视频×' + ru.videos.length + '：' + ru.videos.map(f => this.baseName(f)).join('、'))
      if (ru.first) bits.push('首帧：' + this.baseName(ru.first))
      if (ru.last) bits.push('尾帧：' + this.baseName(ru.last))
      return (bits.length ? bits.join(' ｜ ') : '无参考素材') + '（' + (ru.mode || '?') + '）'
    },
    /** hover 提示：完整路径，逐行一个 */
    refsTitle(ru) {
      return [...(ru.images || []), ...(ru.videos || []), ru.first, ru.last].filter(Boolean).join('\n')
    },
    videoSrc(file) {
      // key 用绝对路径（含项目/集数目录），不同集之间的 shot_1.mp4 不会互相串
      const abs = joinPath(this.st.current ? this.st.current.shotDir : '', file)
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        this._b64[abs] = b64 ? 'data:video/mp4;base64,' + b64 : ''
      })
      return ''
    },
    /**
     * 只保留最近 B64_KEEP 个视频缓存（其余释放掉，下次预览再读盘）+ 参考视频同理。
     * 🔴 只能在「非渲染路径」调用（生成完成 / 换集）：`videoSrc` 是模板里的函数，
     * 若在那里改动响应式数据会触发「渲染 → 改数据 → 再渲染」的死循环（曾表现为点击后整屏卡住）。
     * 对象 key 天然保插入顺序，直接用 key 顺序当 LRU。
     */
    pruneB64() {
      try {
        for (const [box, keep] of [[this._b64, B64_KEEP], [this._refv, REFV_KEEP]]) {
          const keys = Object.keys(box)
          while (keys.length > keep) delete box[keys.shift()]
        }
      } catch (_) { /* 清理失败不影响主流程 */ }
    },
    async saveVideos() {
      if (!this.canSave()) return
      // _gen / _genAt 是纯 UI 状态，不落库
      const clean = {}
      Object.keys(this.vstate).forEach(k => {
        const v = { ...this.vstate[k] }
        delete v._gen; delete v._genAt
        clean[k] = v
      })
      await this.st.saveArtifact('videoState', clean)
    },
    async genV(i, ctx) {
      const s = this.shots[i]
      const pr = ((this.st.current.prompts || [])[i] || {})
      const prompt = pr.text
      if (!prompt) { this.st.fail(new Error('镜头 ' + (i + 1) + ' 缺少 H3 提示词，请先生成本镜头的提示词')); return false }
      // 参考素材全部来自本行该镜头的设置（可不选）
      const refs = pr.refs || {}
      const refImages = refs.images || []
      const refVideos = refs.videos || []
      const firstFrame = refs.first || null
      const lastFrame = refs.last || null
      const hasRef = refImages.length > 0 || refVideos.length > 0
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.vBusy = true
      if (!this.vstate[i]) this.vstate[i] = { files: [], cur: -1, confirmed: false }
      this.vstate[i]._gen = true
      this.vstate[i]._genAt = Date.now()   // 「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(5)
      const L = stepLog('阶段6 H3视频')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      const mode = hasRef ? '参考模式' : (firstFrame || lastFrame ? '首尾帧模式' : '纯文字模式')
      const inputs = []
      if (firstFrame) inputs.push('首帧')
      if (lastFrame) inputs.push('尾帧')
      if (refImages.length) inputs.push('参考图×' + refImages.length)
      if (refVideos.length) inputs.push('参考视频×' + refVideos.length)
      const dur = this.durOf(i)
      const resStr = this.resOf(i)
      const [rw, rh] = parseRes(resStr)
      L.start('正在生成视频：镜头 ' + (i + 1) + prog + '（' + dur + 's · ' + rw + 'x' + rh +
        ' · ' + resLabel(this.optsFor(i), resStr) +
        ' · ' + mode +
        (inputs.length ? ' · ' + inputs.join('+') : '') + ' · H3 推理，每镜头数分钟）')
      try {
        const dir = this.st.current.shotDir   // <项目>/分镜/<集>/
        // ⚠️ 必须转纯对象再送 IPC：refs 里的数组来自响应式 store（Vue Proxy），
        // Proxy 无法结构化克隆，直接传会抛「An object could not be cloned.」
        const params = JSON.parse(JSON.stringify({
          prompt, firstFrame, lastFrame, refImages, refVideos,
          width: rw, height: rh,
          seconds: dur   // 秒数按分镜脚本该镜头的 dur（主进程对齐到 17k+5 帧网格）
        }))
        dbgPrompt('阶段6 H3视频', '视频模型 · 镜头' + (i + 1), [
          ['prompt', prompt],
          ['time/size', dur + 's · ' + rw + 'x' + rh + '（' + resLabel(this.optsFor(i), resStr) + '）· ' + mode],
          ['refs', inputs.length ? inputs.join(' + ') : '无（纯文字生成）'],
          ['firstFrame', firstFrame || ''],
          ['lastFrame', lastFrame || ''],
          ['refImages', refImages.join('\n')],
          ['refVideos', refVideos.join('\n')]
        ])
        const r = await window.studio.comfyGenerate({
          templateKey: 'video', dir, baseName: 'shot_' + (i + 1),
          params,
          label: '阶段6 H3视频'
        })
        this.vstate[i].files = [...this.vstate[i].files, ...r.files]
        while (this.vstate[i].files.length > 4) this.vstate[i].files.shift()
        this.vstate[i].cur = this.vstate[i].files.length - 1
        this.vstate[i].confirmed = true   // 最新生成默认「采用」（点选其它版本即切换选中，无独立采用按钮）
        const ms = Date.now() - t0
        this.vstate[i].genMs = ms             // 逐条耗时（持久化在 videos.json，显示在该镜头行上）
        // 素材快照：把「这一版视频实际用了哪些参考素材」记下来，行上直接可见
        this.vstate[i].refsUsed = { mode, images: refImages.slice(), videos: refVideos.slice(), first: firstFrame, last: lastFrame }
        this.vstate[i]._sig = this.curVideoSig(i)   // 记录生成时的上游签名（提示词/分镜/素材版本）
        this.vstate[i]._ack = null                  // 重新生成即视为已处理
        delete this.vstate[i]._genAt
        this.pruneB64()                      // 只在非渲染时机清缓存（防渲染死循环）
        await this.saveVideos()
        this.pl.markGen(5, ms)
        this.st.invalidateMedia(this.epProjectId, 'shots')   // 左侧树「分镜」下次展开刷新
        L.done('镜头 ' + (i + 1) + ' 视频生成完成：' + r.files.join('、'), ms)
        this.$root.toast('镜头 ' + (i + 1) + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail('镜头 ' + (i + 1) + ' 视频生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { delete this.vstate[i]._genAt; delete this.vstate[i]._gen; this.vBusy = false; this.pl.endGen(5); if (!this.pBusy) this._busyEpId = null }
    },
    /** 批量生成视频：all=true 全部重生成（新版本追加，旧版保留可切换）；false 只补没有任何视频文件的镜头。
     *  入口 batchVideos() 已保证全部镜头都有提示词；此处再逐个保险校验 */
    async runBatchV(all) {
      const L = stepLog('阶段6 H3视频')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (!(this.prompts[i] && this.prompts[i].text.trim())) continue   // 保险：缺提示词的跳过
        const s = this.vstate[i]
        if (all || !(s && s.files.length)) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成的镜头'); return }
      this.batchV = true; this.batchVStop = false; this.vBusy = true
      this.batchVN = 0; this.batchVTotal = idx.length
      L.start('开始批量生成视频（' + (all ? '全部重生成，新版本追加' : '只补没有视频的镜头') + '）：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头）；预计总耗时较长，可随时点「停止批量」，当前镜头跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchVStop) { stopped = true; break }
          this.batchVN = k + 1
          const okFlag = await this.genV(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成视频已停止' : '批量生成视频结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchV = false; this.batchVStop = false; this.vBusy = false
        this.batchVN = 0; this.batchVTotal = 0
        if (!this.pBusy) this._busyEpId = null
      }
    },
    async confirmOne(i) {
      if (!this.vstate[i] || this.vstate[i].cur < 0) return
      this.vstate[i].confirmed = true
      await this.saveVideos()
      this.$root.toast('镜头 ' + (i + 1) + ' 已采用')
    },
    async unconfirm(i) {
      this.vstate[i].confirmed = false
      await this.saveVideos()
    },
    async confirmVideos() {
      await this.saveVideos()
      this.pl.confirm(5, this.st.current.id)
      this.$root.toast('视频全部采用，进入组装')
    }
  }
}

function emptyRefs() { return { images: [], videos: [], first: null, last: null } }

function require_json(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : text
  const start = raw.search(/[[{]/)
  if (start < 0) throw new Error('LLM 输出中未找到 JSON')
  // 切到最后一次闭合括号，容忍 JSON 后面的多余文字
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
  return raw.slice(start, end > start ? end + 1 : undefined)
}
/** 兼容两种返回：裸数组，或（JSON 对象模式下的）按 key 解析；used 记录已取用的键避免误取 */
function pickArr(v, keys, used) {
  if (Array.isArray(v)) return v
  if (!v || typeof v !== 'object') return null
  for (const k of keys) if (Array.isArray(v[k])) { used.add(k); return v[k] }
  const rest = Object.keys(v).filter(k => Array.isArray(v[k]) && !used.has(k))
  if (rest.length === 1) { used.add(rest[0]); return v[rest[0]] }
  return null
}
/** 场景名兜底：空 或 "同上/相同/一致…" → 用上一个镜头的场景名 */
function fixSceneName(v, prev) {
  const s = String(v == null ? '' : v).trim()
  if (!s || /同上|如上|一样|相同|同上场景/.test(s) || s === '一致') return prev || '未命名场景'
  return s
}
/** 档案归一化：字符串/对象都能吃，统一成 {kind,name,role,profile,prompt,negative,candidates,cur,res,_imgRev} */
function normArchive(list, kind) {
  const out = []
  for (const raw of list || []) {
    const o = (typeof raw === 'string') ? { name: raw } : (raw || {})
    const name = String(o.name || o.title || '').trim()
    if (!name) continue
    out.push({
      kind,
      name,
      role: kind === 'scene' ? (o.role || '场景') : (o.role || '配角'),
      // 档案：模型给的对象/数组统一成「字段名：值」行文本（卡片上直接可编辑）
      profile: normalizeProfile(o.profile || o.档案 || ''),
      _profRev: o._profRev || 0,
      _profRevAt: o._profRevAt || 0,
      prompt: String(o.prompt || o.promptEn || o.desc || '').trim(),
      negative: o.negative || '',
      candidates: Array.isArray(o.candidates) ? o.candidates.slice() : [],
      cur: typeof o.cur === 'number' ? o.cur : -1,
      res: o.res || '',
      genMs: o.genMs || 0,
      _imgRev: o._imgRev || 1
    })
  }
  return out
}
/**
 * 与已有档案合并（2026-09-22 改：提示词与档案以最新生成为准，图与素材不动）：
 *  - 档案 / 正向 / 负向：本次模型有输出 → 无条件覆盖旧值（含手改过的）；模型漏输出 → 保留旧值
 *  - 已生成的图（candidates / cur / res / genMs / _imgRev）一律保留，不随档案变化
 *  - 档案被覆盖（内容变了）→ 档案版本 +1，卡片上会出现「档案已改 · 提示词待更新」提示
 *  - 模型这次没提到、但旧档案里有的名字保留（避免丢已生成的图）
 */
function mergeArchive(list, olds) {
  const pool = new Map((olds || []).filter(o => o && o.name).map(o => [o.name, o]))
  const out = []
  for (const it of list) {
    const old = pool.get(it.name)
    if (!old) { out.push(it); continue }
    pool.delete(it.name)
    const prevProf = normalizeProfile(old.profile)
    const prof = it.profile || prevProf
    const changed = !!it.profile && it.profile !== prevProf
    out.push({
      ...it,
      role: it.role || old.role,
      profile: prof,
      // 档案内容真的变了 → 版本 +1（提示词落后于档案，等用户点「生成提示词」重算）
      _profRev: changed ? (old._profRev || 0) + 1 : (old._profRev || 0),
      _profRevAt: old._profRevAt || 0,
      prompt: it.prompt || old.prompt,
      negative: it.negative || old.negative,
      candidates: Array.isArray(old.candidates) ? old.candidates.slice() : [],
      cur: typeof old.cur === 'number' ? old.cur : -1,
      res: old.res || it.res,
      genMs: old.genMs || it.genMs,
      _imgRev: old._imgRev || it._imgRev || 1
    })
  }
  const fallbackKind = (list[0] && list[0].kind) || 'character'
  for (const left of pool.values()) out.push({ kind: fallbackKind, ...left })
  return out
}
</script>
