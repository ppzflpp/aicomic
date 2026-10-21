import { defineStore } from 'pinia'
import { usePipeline } from './pipeline.js'
import { unfoldProfileLine, mergeOutfitList } from '../promptlib.js'

/** 打开某一集时把档案里「模型偷懒写成的一整行」拆回多行（2026-10-12）：
 *  磁盘上的旧数据（V9X-4 等）profile 是 0 换行的一坨，重生成才会修好 ——
 *  但用户不重新生成也该看得懂，所以在**加载时**兜一次。
 *  只用 unfoldProfileLine（只拆「字段串」单行），不用 normalizeProfile ——
 *  后者会 trim / 删空行，不该在「用户没编辑」时改写他的数据。 */
function unfoldLongProfiles(list) {
  for (const o of list || []) {
    if (o && typeof o.profile === 'string') o.profile = unfoldProfileLine(o.profile)
  }
}

export const useProject = defineStore('project', {
  state: () => ({
    workspace: null,
    tree: [],
    models: { ready: false, items: [] },
    health: null,          // 推理服务健康 { llm, comfyui, ffmpeg, endpoints }
    current: null,        // 当前集数对象（全量工件）
    view: 'dash',         // dash | settings | lib | prompts | imggen | vidgen
    expanded: new Set(),  // 树展开的项目/文件夹 id（含侧栏导航开关：workbench / imggen / vidgen）
    ask: null,            // 输入弹窗 {title, cb}
    askValue: '',         // 弹窗输入值
    confirmDel: null,     // 删除确认 {type:'project'|'folder'|'episode', id, name}
    resOptions: null,     // 分辨率档位 {img:[{value,label}],vid:[...],out:[...]}，按当前模型过滤
    /** 当前生图 / 视频方案的能力声明 { image:{i2i}, video:{firstFrame,lastFrame,refImage,refVideo,audio} }
     *  不支持的入口在界面上直接禁用/隐藏 —— 而不是等用户点了生成才发现。
     *  拿不到时是空对象 → 各项按「未声明 = 不禁用」处理（宁可放过，不可误禁）。 */
    caps: { image: {}, video: {} },
    /** 当前方案声明的提示词规范文件 { image:{逻辑名:文件名}, video:{base,ref,…} }
     *  视频链路的提示词按它分流：H3 声明 {base:'h3.md', ref:'h3ref.md'}、
     *  LTX-2.5 声明 {base:'ltx.md'} —— 换视频模型连「用哪份提示词规范」也变成只改配置。
     *  拿不到时是空对象 → 生成链路回落到内置的 h3.md / h3ref.md。 */
    promptFiles: { image: {}, video: {} },
    /** 当前方案声明的「模型专属规范」引用关系 { image:{通用规范名:[文件名]}, video:{…} }
     *  提示词配置中心用它标注「这份 model-*.md 被哪个方案用着」。 */
    promptExtraFiles: { image: {}, video: {} },
    /** 视频生成档位清单（主进程给，UI 只认档位名，不含任何模型信息）
     *  [{key:'fast'|'balanced'|'hq', label:'速度优先', desc:'…', default:true}] */
    tierOptions: [],
    /** 视频比例选项（2026-10-15）。1:1 已按 Dragon 要求去掉，只留横竖两版 ——
     *  成片分辨率清单里本来就没有 1:1 档，留着比例选项就会选到没有对应成片档的值。 */
    aspectOptions: [
      { id: '16:9', label: '横版 16:9', desc: 'B站 / 电视 / 传统横屏' },
      { id: '9:16', label: '竖版 9:16', desc: '抖音 / 快手 / 竖屏短剧' }
    ],
    /** 风格体系四轴清单（主进程给）：{ render:[], world:[], genre:[], tone:[], presets:[], default, defaultTriple, labels }。
     *  新建项目与项目配置里是**四组点选网格**（画面风格 / 世界设定 / 内容体裁 / 制作调性），
     *  存库的值是拼出来的 `render:world:genre:tone`；presets 只是给四元组起过名字的组合（向后兼容老值）。 */
    styleAxes: { render: [], world: [], genre: [], tone: [], presets: [], default: {}, defaultTriple: '', labels: {} },
    /** 风格体系的结构性问题 {errors:[], warnings:[]}（主进程给）—— 界面黄条用。
     *  🔴 以前 styles.errors() 是死代码：用户自建包写残了会被静默丢弃、项目悄悄变成古风，
     *     而没有任何地方会告诉他。现在必须在界面上显示出来。 */
    styleIssues: { errors: [], warnings: [] },
    /** 左侧树的项目媒体（按需懒加载）：{ [projectId]: {assets,shots,films,scripts,loading...} } */
    media: {},
    /** 项目角色场景库（跨集共享的角色/场景条目）：{ [projectId]: {rev, entries, busy} } */
    library: {},
    /** 项目级装扮清单（跨集继承）：{ [projectId]: {rev, items, busy} }。
     *  items 形如 `{ 苏锦瑟: [{name, desc, kw, base}] }`（基础名分组，见 electron/outfits.cjs）。
     *  用途：识别装扮时把已知名字下发给模型（让它沿用，不另起名字），识别完把结果并回去。 */
    outfitBook: {},
    /**
     * 「生成分镜后一条龙」的请求票据（2026-10-16，Dragon：「我要的所有的自动化」）。
     *
     * 为什么用 store 中转而不是组件直调：分镜环节在 `StageShots.vue`、角色环节在 `StageChars.vue`，
     * 两个组件互不认识。两端都常驻挂载（App.vue 的 dash 视图里 4 个卡片一起渲染），所以
     * 「分镜生成完 → 置票 → StageChars 的 watcher 收到 → 自己跑完建卡链」是**不改架构**的做法。
     *
     * 形状 `{ epId, at }`：`at` 让「同一集再点一次生成分镜」也能触发（对象引用每次都换新）。
     * 只置票、不在这里执行 —— 执行要动 cards / busy / 出图，那些都是组件的事。
     */
    autoReq: null,
    /** 库编辑区当前打开的目标（不属于任何一集）：{projectId, id} | null */
    libTarget: null,
    /** 提示词配置中心当前打开的项目：{ projectId } | null（同样不属于任何一集）。
     *  🔴 提示词页没有 st.current 可用 —— 读规范、取该项目风格、读写成品覆写都靠它定位项目。 */
    promptTarget: null,
    /** 库引用快照（一次扫全库）：{ projectId, map: { [entryId]: usage[] } }——库视图整页铺卡共用 */
    libUsage: { projectId: '', map: {} },
    error: null,          // 最近一次 IPC 错误（App 监听后 toast）
    /**
     * 首屏是否已经完成（工作区 + 左树 + 恢复上次打开的集）。
     * 2026-10-19 新增：各模块用它区分「还在启动」和「真的没有内容」——
     * 启动期显示「正在加载…」，启动完才显示各自的空态文案（否则用户会以为要自己操作）。
     */
    booted: false
  }),
  actions: {
    fail(e) { this.error = (e && e.message) || String(e) },
    async boot() {
      try {
        this.workspace = await window.studio.getWorkspace()
        if (!this.workspace) this.workspace = await window.studio.chooseWorkspace()
        await this.refresh()
        // 🔴 2026-10-19（Dragon：「打开软件时角色&场景空白一会才显示」）：
        //    环境类信息（模型检测 / 健康探测 / 方案能力 / 分辨率档位）原来**串在启动链上**，
        //    把「恢复上次打开的集数」往后推了 4 个 await —— 首屏挂载本来就有一段主线程长任务，
        //    这些 await 全排在它后面，实测让角色卡晚出来 ~1s 以上（卡片要靠 current 集才能生成）。
        //    这些信息不参与「有哪些卡」的渲染（拿不到时各 UI 按「未声明 = 不禁用」兜底），
        //    改为后台补齐；refreshEnv 内部已逐个兜底，失败只是信息不全，不影响启动。
        this.refreshEnv().catch(() => { /* 环境信息失败不影响启动 */ })
      } catch (e) { this.fail(e) }
    },
    async refresh() {
      try {
        this.tree = await window.studio.getTree(this.workspace)
      } catch (e) { this.fail(e) }
    },
    async refreshEnv() {
      this.models = await window.studio.checkModels()
      this.health = await window.studio.inferHealth()
      await this.refreshCaps()
      // 换模型方案后，分辨率档位与视频档位清单都要重取（它们由方案声明）
      await this.loadResOptions()
    },
    /** 当前生图 / 视频方案声明了哪些能力 + 用哪份提示词规范（换方案后 UI 与提示词一起跟着走） */
    async refreshCaps() {
      try {
        const [a, b] = await Promise.all([
          window.studio.profileList('image'),
          window.studio.profileList('video')
        ])
        const ai = ((a && a.items) || []).find(o => o.active) || {}
        const vi = ((b && b.items) || []).find(o => o.active) || {}
        this.caps = { image: ai.capabilities || {}, video: vi.capabilities || {} }
        this.promptFiles = { image: ai.promptFiles || {}, video: vi.promptFiles || {} }
        this.promptExtraFiles = { image: ai.promptAppend || {}, video: vi.promptAppend || {} }
      } catch (_) { /* 拿不到就不动 —— 保持「未声明 = 不禁用」 */ }
    },
    /** 轻量健康轮询（每 5s）：真实探测 llama/ComfyUI 端口，标题栏胶囊不再依赖手动刷新 */
    async refreshHealth() {
      try { this.health = await window.studio.inferHealth() } catch (_) { /* 探测失败保持原状 */ }
    },
    async openEpisode(id) {
      try {
        const ep = await window.studio.getEpisode(this.workspace, id)
        if (!ep) return
        unfoldLongProfiles(ep.chars)
        unfoldLongProfiles(ep.scenes)
        this.libTarget = null   // 打开某一集 → 右侧回到 5 块工作区（离开库编辑区）
        this.current = ep
        this.view = 'dash'
        usePipeline().load(ep.done, ep.activeStage, ep.stageMeta, ep.id)
        // 装扮清单是**项目级**的（跨集继承）：打开集数就连带拉一次。
        // 识别装扮时要拿它当「已知名字」下发（见 StageChars.runOutfits），点按钮才拉就太晚了。
        await this.loadOutfitBook(ep.projectId)
      } catch (e) { this.fail(e) }
    },
    /** 打开库条目编辑区（第 6 块；不属于任何一集，右侧不再要求 st.current） */
    openLibEntry(projectId, id) {
      this.view = 'dash'
      this.libTarget = { projectId, id }
    },
    /** 打开提示词配置中心（整页视图，不属于任何一集） */
    openPrompts(projectId) {
      this.view = 'prompts'
      this.promptTarget = { projectId }
    },
    /** 在项目树里按 id 找集数（含任意层级子文件夹）；找不到返回 null（例如已被删除） */
    findEpisode(id) {
      const want = Number(id)
      if (!want) return null
      let hit = null
      const scan = (list) => { for (const e of list || []) { if (e.id === want) hit = e } }
      const walkFolder = (folders) => {
        for (const f of folders || []) {
          if (hit) return
          scan(f.episodes)
          walkFolder(f.folders)
        }
      }
      for (const p of this.tree || []) {
        if (hit) break
        scan(p.episodes)
        walkFolder(p.folders)
      }
      return hit
    },
    askText(title, def, cb) {
      this.askValue = def || ''
      this.ask = { title, cb }
    },
    async confirmAsk() {
      const cb = this.ask && this.ask.cb
      const name = (this.askValue || '').trim()
      this.ask = null
      if (cb && name) await cb(name)
    },
    /* ---- 删除 ---- */
    askDelete(type, id, name) { this.confirmDel = { type, id, name } },
    async doDelete() {
      const d = this.confirmDel
      this.confirmDel = null
      if (!d) return
      try {
        if (d.type === 'project') await window.studio.deleteProject(this.workspace, d.id)
        else if (d.type === 'folder') await window.studio.deleteFolder(this.workspace, d.id)
        else if (d.type === 'episode') {
          await window.studio.deleteEpisode(this.workspace, d.id)
          if (this.current && this.current.id === d.id) {
            this.current = null
            const pl = usePipeline()
            pl.done = [false, false, false, false, false, false, false]
            pl.active = 0
          }
        }
        await this.refresh()
      } catch (e) { this.fail(e) }
    },
    async createProject(name, res) {
      try {
        const r = await window.studio.createProject(this.workspace, name, res)
        await this.refresh()
        // 新建后自动展开并打开第一集
        this.expanded.add('p' + r.id)
        const p = this.tree.find(x => x.id === r.id)
        if (p && p.episodes.length) await this.openEpisode(p.episodes[0].id)
      } catch (e) { this.fail(e) }
    },
    async addFolder(projectId, parentId, name) {
      try {
        const r = await window.studio.addFolder(this.workspace, projectId, parentId, name)
        if (parentId) this.expanded.add('f' + parentId)
        await this.refresh()
        return r
      } catch (e) { this.fail(e) }
    },
    async addEpisode(projectId, folderId, name) {
      try {
        const r = await window.studio.addEpisode(this.workspace, projectId, folderId, name)
        if (folderId) this.expanded.add('f' + folderId); else this.expanded.add('p' + projectId)
        await this.refresh()
        // 新建后直接切到这一集：空内容 + pipeline 归零，避免看着上一集的残留内容
        if (r && r.id) await this.openEpisode(r.id)
        return r
      } catch (e) { this.fail(e) }
    },
    async saveChapter(text) {
      if (!this.current) return
      try {
        // 主进程保存章节时会自增 revs.chapter（脏标记依据），把最新计数器同步回来
        const revs = await window.studio.saveChapter(this.workspace, this.current.id, text)
        this.current.chapter = text   // 同步到当前集对象，下游阶段（改编）才能读到
        if (revs) this.current.revs = revs
        // 左侧树「剧本」节点跟着工件走（章节原文文件已落盘 → 计数/叶子同步）
        this.invalidateMedia(this.current.projectId, 'scripts')
      } catch (e) { this.fail(e) }
    },
    /** 保存阶段工件（adapted/shots/chars/prompts/videoState/revs）并同步到 current */
    async saveArtifact(kind, data) {
      if (!this.current) return
      try {
        // Vue 响应式 Proxy 无法结构化克隆过 IPC，必须先转纯对象
        const plain = kind === 'adapted' ? String(data) : JSON.parse(JSON.stringify(data))
        const r = await window.studio.saveArtifact(this.workspace, this.current.id, kind, plain)
        this.current[kind === 'adapted' ? 'adapted' : kind] = plain
        // 保存改编稿时主进程会自增 revs.adapted（下游脏标记依据），同步最新计数器
        if (kind === 'adapted' && r) this.current.revs = r
        // 左侧树「剧本」节点跟着工件走（改编稿/分镜/档案落盘后叶子与计数立即刷新）；
        // 故意不 await：工件保存是主流程，树刷新只是附带（失败也不影响保存）。
        // 只在**会新增/改动剧本文件**的工件上刷新，prompts/videos 等纯机器状态不触发（避免批量生成时空转）
        if (kind === 'adapted' || kind === 'shots' || kind === 'chars' || kind === 'scenes') {
          this.invalidateMedia(this.current.projectId, 'scripts')
        }
      } catch (e) { this.fail(e); throw e }
    },
  toggleExpand(id) {
    this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id)
  },
  /* ---- 项目媒体（左侧树：assets 角色图 / 分镜视频 / 成片视频） ---- */
  /** 取（或建）某项目的媒体缓存槽 */
  mediaSlot(projectId) {
    if (!this.media[projectId]) {
      this.media[projectId] = { characters: null, scenes: null, shots: null, films: null, scripts: null, busy: {} }
    }
    return this.media[projectId]
  },
  /** 拉取项目角色图/场景图（展开 assets 节点时调用，一次即可） */
  async loadAssets(projectId, force) {
    const slot = this.mediaSlot(projectId)
    if (!force && slot.characters) return slot
    if (slot.busy.assets) return slot
    slot.busy.assets = true
    try {
      const r = await window.studio.projectAssets(this.workspace, projectId)
      slot.characters = (r && r.characters) || []
      slot.scenes = (r && r.scenes) || []
    } catch (e) { this.fail(e) } finally { delete slot.busy.assets }
    return slot
  },
  /** 拉取镜头视频 / 成片（展开对应节点时调用；force=true 用于生成后刷新） */
  async loadShots(projectId, force) {
    const slot = this.mediaSlot(projectId)
    if (!force && slot.shots) return slot
    if (slot.busy.shots) return slot
    slot.busy.shots = true
    try { slot.shots = (await window.studio.projectShots(this.workspace, projectId)) || [] }
    catch (e) { this.fail(e) } finally { delete slot.busy.shots }
    return slot
  },
  async loadFilms(projectId, force) {
    const slot = this.mediaSlot(projectId)
    if (!force && slot.films) return slot
    if (slot.busy.films) return slot
    slot.busy.films = true
    try { slot.films = (await window.studio.projectFilms(this.workspace, projectId)) || [] }
    catch (e) { this.fail(e) } finally { delete slot.busy.films }
    return slot
  },
  /** 拉取剧本工件（章节原文/改编稿/分镜脚本/角色·场景档案；展开「剧本」节点时调用） */
  async loadScripts(projectId, force) {
    const slot = this.mediaSlot(projectId)
    if (!force && slot.scripts) return slot
    if (slot.busy.scripts) return slot
    slot.busy.scripts = true
    try { slot.scripts = (await window.studio.projectScripts(this.workspace, projectId)) || [] }
    catch (e) { this.fail(e) } finally { delete slot.busy.scripts }
    return slot
  },
  /* ---- 项目角色场景库（跨集共享；左侧「📚 角色场景库」节点 + 右侧第 6 块编辑区） ---- */
  /**
   * 拉取库列表（首次访问主进程会自动迁移老项目：把 assets 下已有图片目录补成库条目）。
   * 返回 {rev, entries:[{id,kind,name,role,profile,prompt,negative,res,images,cur,libRev,from,dir}]}
   */
  async loadLibrary(projectId, force) {
    if (!projectId) return null
    const cur = this.library[projectId]
    if (!force && cur && !cur.busy) return cur
    if (cur && cur.busy) return cur
    this.library[projectId] = { rev: cur ? cur.rev : 1, entries: cur ? cur.entries : [], busy: true }
    try {
      const r = await window.studio.libraryList(this.workspace, projectId)
      const entries = (r && r.entries) || []
      unfoldLongProfiles(entries)   // 库里同样显示档案 textarea → 与打开集数同一套兜底
      this.library[projectId] = { rev: (r && r.rev) || 1, entries, busy: false }
    } catch (e) {
      this.fail(e)
      if (this.library[projectId]) this.library[projectId].busy = false
    }
    return this.library[projectId]
  },
  /** 库条目（同步读取，供左侧树与命中判定用） */
  libEntries(projectId) {
    const s = projectId != null ? this.library[projectId] : null
    return (s && s.entries) || []
  },
  /* ---- 项目级装扮清单（跨集继承）----
     与 library 的区别：库是**用户主动入库**的产物，装扮清单是**识别时自动累积**的副产物；
     所以这里没有 add/remove/rename，只有「拉到本地」与「整份写回」两个动作。 */
  /**
   * 拉项目装扮清单。文件还没生成（本项目从未识别过装扮）→ 主进程回空清单，不抛。
   * 打开某一集时自动加载；识别装扮前会 force 重拉一次（可能刚在别的集里识别过）。
   */
  async loadOutfitBook(projectId, force) {
    if (!projectId) return null
    const cur = this.outfitBook[projectId]
    if (!force && cur && !cur.busy) return cur
    if (cur && cur.busy) return cur
    this.outfitBook[projectId] = { rev: cur ? cur.rev : 1, items: (cur && cur.items) || {}, busy: true }
    try {
      const r = await window.studio.outfitsRead(this.workspace, projectId)
      this.outfitBook[projectId] = { rev: (r && r.rev) || 1, items: (r && r.items) || {}, busy: false }
    } catch (e) {
      this.fail(e)
      if (this.outfitBook[projectId]) this.outfitBook[projectId].busy = false
    }
    return this.outfitBook[projectId]
  },
  /** 某主体在项目清单里已有的装扮（同步读取；空数组 = 还没识别过 / 本项目新装扮） */
  outfitsOf(projectId, base) {
    const s = projectId != null ? this.outfitBook[projectId] : null
    const items = (s && s.items) || {}
    return Array.isArray(items[base]) ? items[base] : []
  },
  /**
   * 整份写回项目装扮清单（rev 由主进程 +1）。
   * 🔴 **不做「读-改-写」的乐观合并**：清单是低频写入（每次识别一次），
   *    重拉一次的成本远低于并发写互相覆盖的代价 —— 写完直接用返回值刷新本地缓存。
   */
  async putOutfits(projectId, items) {
    if (!projectId) return null
    const r = await window.studio.outfitsPut(this.workspace, projectId, { rev: 1, items: items || {} })
    if (r) this.outfitBook[projectId] = { rev: r.rev || 1, items: r.items || {}, busy: false }
    return r
  },
  /**
   * 把一次识别结果记进项目装扮清单（读-改-写在这里一次做完）。
   * 🔴 **必须先 force 重拉**：写盘是**整份覆盖**的，若本地缓存是空的（打开集数那次读取失败过、
   *    或刚换了工作区），拿缓存当底稿就会把**别的角色**的装扮名整片抹掉。
   *    读失败时 loadOutfitBook 会保留上一次的 items（不清空），所以退一步也不会误删。
   * @param {string} base 主体名（基础名）
   * @param {Array} list 本次识别结果（parseOutfitList 的产物）
   */
  async recordOutfits(projectId, base, list) {
    if (!projectId || !base) return null
    const book = await this.loadOutfitBook(projectId, true)
    const items = Object.assign({}, (book && book.items) || {})
    items[base] = mergeOutfitList(items[base], list)
    return this.putOutfits(projectId, items)
  },
  /**
   * 置一张「自动建卡」票据：分镜生成完之后由 StageShots 调，StageChars 收到后自己跑
   * 「按档案生成图片提示词 → 识别装扮 → 建派生卡」（出图与填镜头仍是用户手点的两个按钮）。
   *
   * 🔴 只置票、不执行（执行要动 cards / busy，都是组件的事）。
   * 🔴 `at` 每次都换新值：用户对**同一集**再点一次「生成分镜」，对象引用必须变，
   *    否则 watcher 不会触发，第二次就不跑了。
   */
  requestAuto(epId) {
    if (!epId) return
    this.autoReq = { epId, at: Date.now() }
  },
  /** 入库：payload 带 updateId 则覆盖更新，不带则新建（撞名自动加「 (2)」，返回值里 renamed 标记会告诉前端） */
  async saveLibrary(projectId, payload) {
    const r = await window.studio.librarySave(this.workspace, projectId, payload)
    await this.loadLibrary(projectId, true)
    return r
  },
  /** 手动新增空条目（不靠 LLM 提取） */
  async addLibrary(projectId, kind, name) {
    const r = await window.studio.libraryAdd(this.workspace, projectId, kind, name)
    await this.loadLibrary(projectId, true)
    return r
  },
  /** 库条目改名：重命名图片目录 + 扫各集替换引用（卡片名 / 分镜 chars·scene / 对白人名） */
  async renameLibrary(projectId, id, newName) {
    const r = await window.studio.libraryRename(this.workspace, projectId, id, newName)
    await this.loadLibrary(projectId, true)
    return r
  },
  /**
   * 删除库条目。deleteFiles=false → 仅移出库（图片目录保留）；true → 连同图片目录一起删（不可恢复）。
   * 返回 { id, name, kind, filesDeleted, delErr, images, usage }（usage = 删除前的引用快照）。
   */
  async removeLibrary(projectId, id, deleteFiles) {
    const r = await window.studio.libraryRemove(this.workspace, projectId, id, { deleteFiles: !!deleteFiles })
    await this.loadLibrary(projectId, true)
    return r
  },
  /** 某库条目被哪些集/哪些镜引用（现扫，不做索引） */
  async libraryUsage(projectId, id) {
    try { return (await window.studio.libraryUsage(this.workspace, projectId, id)) || [] }
    catch (e) { this.fail(e); return [] }
  },
  /**
   * 全库引用快照（一次扫全库，库视图整页铺卡共用）：
   * 逐条调 libraryUsage 会是「条目数 × 集数」次读盘，这里一次拿全部。
   */
  async loadLibUsage(projectId) {
    if (!projectId) { this.libUsage = { projectId: '', map: {} }; return {} }
    try {
      const m = (await window.studio.libraryUsageAll(this.workspace, projectId)) || {}
      this.libUsage = { projectId, map: m }
      return m
    } catch (e) { this.libUsage = { projectId, map: {} }; return {} }
  },
  /**
   * 逐字段保存库条目（**不重拉整库**）：保存后服务端 libRev +1，
   * 这里只把本地那条的 libRev/updatedAt 同步过来 —— 重拉会把本地还没提交的其它字段覆盖回服务端旧值。
   */
  async patchLibrary(projectId, payload) {
    const r = await window.studio.librarySave(this.workspace, projectId, payload)
    const s = this.library[projectId]
    const e = s && (s.entries || []).find(x => x.id === (payload && payload.updateId))
    if (e && r && r.entry) { e.libRev = r.entry.libRev; e.updatedAt = r.entry.updatedAt }
    return r
  },
  /** 生成/导出后让左侧树对应节点失效，并**立即重拉**（不管节点是否展开）：
   *  展开着的时候用户马上能看到新产物；收起时也保证「N 个」的计数是新的 */
  async invalidateMedia(projectId, kind) {
    if (!projectId || !kind) return
    if (kind === 'library') { try { await this.loadLibrary(projectId, true) } catch (_) {} ; return }
    const slot = this.media[projectId]
    if (slot) {
      if (kind === 'characters') { slot.characters = null; slot.scenes = null }
      else slot[kind] = null
    }
    try {
      if (kind === 'characters') await this.loadAssets(projectId, true)
      else if (kind === 'shots') await this.loadShots(projectId, true)
      else if (kind === 'films') await this.loadFilms(projectId, true)
      else if (kind === 'scripts') await this.loadScripts(projectId, true)
    } catch (_) { /* 树刷新失败不影响主流程 */ }
  },
  /* ---- 分辨率配置 + 视频档位 ---- */
  async loadResOptions() {
    try { this.resOptions = await window.studio.resOptions() } catch (e) { this.fail(e) }
    // 档位清单跟随主进程注册表：新增档位 / 换模型库都不需要改前端
    try { this.tierOptions = (await window.studio.resTiers()) || [] } catch (_) { this.tierOptions = [] }
    // 风格四轴与问题清单按**当前项目**取：风格覆盖已下沉到项目（同一个工作区下，
    // 每个项目可以有自己的轴文件，也可能只有某个项目的包是坏的）。
    // 🔴 promptTarget 优先于 current：提示词配置中心/项目配置弹窗是「用户此刻明确在看的那个项目」，
    //    而 current（当前集）可能还停在别的项目上 —— 两者取错就会「改了 A 的轴，B 的界面在报错」。
    // 两个都没有（纯新建弹窗场景）→ pid='' 只用内置。
    const pid = (this.promptTarget && this.promptTarget.projectId) ||
      (this.current && this.current.projectId) || ''
    try { this.styleAxes = (await window.studio.styleAxes(this.workspace, pid)) || this.styleAxes } catch (_) { /* 保留上一次 */ }
    // 风格体系的结构性问题（含「你选的这个组合已经不存在了」）—— 界面黄条
    try { this.styleIssues = (await window.studio.styleErrors(this.workspace, pid)) || this.styleIssues } catch (_) { /* 保留上一次 */ }
  },
  /** 风格四轴默认值（新建项目时四组网格的预选值） */
  defaultAxes() {
    const d = this.styleAxes && this.styleAxes.default;
    return (d && d.render)
      ? { tone: 'cinematic', ...d }
      : { render: 'live-action', world: 'guofeng', genre: 'story', tone: 'cinematic' };
  },
  /** 默认风格的字符串形式（`render:world:genre:tone`）—— 新建项目预选它 */
  defaultStyle() {
    return (this.styleAxes && this.styleAxes.defaultTriple) || 'live-action:guofeng:story:cinematic';
  },
  /** 某一轴的选项清单（render / world / genre / tone） */
  axisOptions(axis) {
    return (this.styleAxes && this.styleAxes[axis]) || [];
  },
  /** 某一轴的显示名（点选网格的标题用） */
  axisLabel(axis) {
    const L = (this.styleAxes && this.styleAxes.labels) || {};
    return L[axis] || axis;
  },
  /** 四轴拼成存库用的 id（tone 为空时按 3 段拼，老值格式原样保留） */
  tripleId(tri) {
    if (!tri) return '';
    const v = (x) => (x == null ? '' : String(x));
    if (!v(tri.tone)) return [tri.render, tri.world, tri.genre].map(v).join(':');
    return [tri.render, tri.world, tri.genre, tri.tone].map(v).join(':');
  },
  /** 把存库的风格值拆回四个值。支持三种写法：
   *  `render:world:genre:tone`（新）、`render:world:genre`（tone 取默认，老项目不用迁移）
   *  与预置名（老的 `guofeng-real` / `modern-real` —— 去 presets 里查它的四轴）。
   *  🔴 认不出预置名就返回默认四轴是**危险**的（老项目存的 modern-real 会被读成古风），
   *     所以这里必须查 presets 清单，不能只按 ":" 拆。 */
  parseTriple(id) {
    const key = String(id || '')
    const parts = key.split(':').map(x => x.trim())
    const def = this.defaultAxes()
    if (parts.length === 4 && parts.every(Boolean)) {
      return { render: parts[0], world: parts[1], genre: parts[2], tone: parts[3] }
    }
    if (parts.length === 3 && parts.every(Boolean)) {
      return { render: parts[0], world: parts[1], genre: parts[2], tone: def.tone }
    }
    const hit = ((this.styleAxes && this.styleAxes.presets) || []).find(p => p.id === key)
    if (hit && hit.render) {
      return { render: hit.render, world: hit.world, genre: hit.genre, tone: hit.tone || def.tone }
    }
    return def
  },
  /** 这组四轴对应的预置名字（没有对应预置就返回 ''）—— 弹窗里显示「= 预置：…」 */
  presetNameOf(tri) {
    const id = this.tripleId(tri);
    const ps = (this.styleAxes && this.styleAxes.presets) || [];
    const hit = ps.find(p => this.tripleId(p) === id);
    return (hit && hit.name) || '';
  },
  /** 这组四轴里哪些值在当前清单中不存在（= 项目存的风格已失效）—— 弹窗据此报警 */
  missingAxes(tri) {
    const out = [];
    for (const ax of ['render', 'world', 'genre', 'tone']) {
      if (!this.axisOptions(ax).some(x => x.id === tri[ax])) out.push(this.axisLabel(ax) + '「' + tri[ax] + '」');
    }
    return out;
  },
  /** 档位默认值（新建项目时预选「平衡」） */
  defaultTier() {
    const d = (this.tierOptions || []).find(t => t.default);
    return (d && d.key) || (this.tierOptions[0] || {}).key || 'balanced';
  },

  /* ---------------- 视频比例 + 分辨率推荐（2026-10-15）----------------
   * 「视频质量档位」与「视频比例」是两个上游输入，共同决定图片 / 视频 / 成片三个分辨率的推荐值。
   * 🔴 推荐画布**不在前端硬编码** —— 它随档位表由主进程 tierCanvas 段一起下发（videoTiers.list() 的
   *    canvas 字段）。硬编码的话改档位时两处必然漂，而这里错了会静默配出「加速模型 + 不匹配画布」
   *    的组合 —— 2026-10-15 实测：那会让镜头构图直接漂到全景（见 2026-10-15.md §21）。
   *    本地实测通过：864×480(79%) / 960×544(100%) / 1344×768(100%) 三档分别配三档 LoRA，画面均正常。 */

  /** 该档位在该比例下的推荐画布；档位或比例没声明 → null */
  recCanvas(tier, aspect) {
    const t = (this.tierOptions || []).find(x => x.key === tier);
    return (t && t.canvas && t.canvas[aspect]) || null;
  },

  /**
   * 该档位**可接受**的画布清单（主进程 tierCanvas[档].accept）。
   * 🔴 别拿「是否等于推荐值」当判据：同档位的两个候选画布像素量只差 26%（960×544 vs 864×480），
   *    而该档挂的加速模型是 544p 训练的 —— 实测**两者都正常**。只有落到清单外才是真不匹配。
   * @returns {string[]|null} null = 方案没声明 → 调用方当「不拦」处理
   */
  canvasAccept(tier) {
    const t = (this.tierOptions || []).find(x => x.key === tier);
    return (t && t.canvas && Array.isArray(t.canvas.accept)) ? t.canvas.accept : null;
  },

  /**
   * 三个分辨率的推荐值。
   *   图片 = 视频分辨率（Dragon 要求「图片分辨率与视频分辨率一致」；且图片档位已补齐 544p / 768p 两族）
   *   成片 = **auto**（2026-10-19 起默认「跟第一个镜头」，不再推荐 1920x1080 ——
   *          固定交付档会让导出对每个镜头多一次 bicubic 放大，反而更糊）
   * @returns {{img,vid,out}|null} 推荐画布取不到时返回 null（调用方回退到「不联动」）
   */
  recRes(tier, aspect) {
    const vid = this.recCanvas(tier, aspect);
    if (!vid) return null;
    return { img: vid, vid, out: 'auto' };
  },

  /**
   * 当前剧集「锁定」后的图片/视频分辨率（2026-10-21）。
   * 🔴 切换视频质量档位后，图片分辨率与视频分辨率**锁定 = 档位推荐画布**，用户不可手改。
   *    档位 tier / 比例 aspect 是项目级、随剧集对象下发（getEpisodeFull 补进 res.tier / res.aspect）。
   *    取不到（老库 / 未加载）→ 退回剧集自带的 res.img / res.vid（行为与改造前一致，不锁）。
   * @returns {{img,vid}|null}
   */
  lockedRes() {
    const r = this.current && this.current.res;
    if (!r || !r.tier) return null;
    const rec = this.recRes(r.tier, r.aspect || this.aspectOfRes(r.vid));
    if (!rec) return null;
    // 档位推荐值取不到时退回剧集自身快照，避免把分辨率清空
    return { img: rec.img || r.img, vid: rec.vid || r.vid };
  },

  /** 下拉选项按比例过滤：只留与该比例同向的档位（w>h = 横版）。取不到比例时原样返回。 */
  resOptsFor(kind, aspect) {
    const list = (this.resOptions || {})[kind] || [];
    if (!aspect) return list;
    return list.filter(o => {
      const m = /^(\d+)x(\d+)$/.exec(String(o && o.value || ''));
      if (!m) return true;
      return aspect === '9:16' ? (+m[2]) > (+m[1]) : (+m[1]) > (+m[2]);
    });
  },

  /** 比例从分辨率宽高推断（新建项目弹窗的默认值；老项目后端已推断好，这里只兜底） */
  aspectOfRes(res) {
    const m = /^(\d+)x(\d+)$/.exec(String(res || ''));
    if (!m) return '16:9';
    return (+m[1]) > (+m[2]) ? '16:9' : '9:16';
  },
  /** 改项目分辨率：只影响之后新建的剧集（主进程不回写已有剧集） */
  async setProjectRes(projectId, res) {
    const r = await window.studio.setProjectRes(projectId, res)
    // 🔴 换风格后必须**就地**刷新风格 id 的两处来源：树 + 当前集。
    //    styleIdOf() 优先读 st.current.style（打开集时快照下来的），树是它的后备 ——
    //    不刷新的话，这一轮会话里后面读到的仍会是旧风格：用户明明把体裁切成了「广告」，
    //    改编环节却还在用小说规范，而且**一点报错都没有**（实测踩到，是端到端测试抓出来的）。
    try {
      await this.refresh()
      const p = (this.tree || []).find(x => x.id === Number(projectId))
      const s = p && p.res && p.res.style
      if (s && this.current && Number(this.current.projectId) === Number(projectId)) this.current.style = s
      // 🔴 2026-10-21：档位 / 比例锁定分辨率 —— 改档位后必须就地刷新当前集的 tier/aspect/img/vid，
      //    否则 StageShots/StageChars 的锁定分辨率（st.lockedRes()）会停在旧档位。
      if (p && p.res && this.current && Number(this.current.projectId) === Number(projectId)) {
        const nr = this.current.res || {}
        if (p.res.tier) nr.tier = p.res.tier
        if (p.res.aspect) nr.aspect = p.res.aspect
        if (p.res.img) nr.img = p.res.img
        if (p.res.vid) nr.vid = p.res.vid
        this.current.res = nr
      }
    } catch (_) { /* 刷新失败不影响「已保存」这个事实 */ }
    return r
  },
  /**
   * 只改「单集目标时长」（项目级，秒）—— 双轨配时的输入（见 promptlib 的 pacingPlan：
   * 镜数 N 由「目标时长 T × 画面单元数 B」推，而不是由字数推）。0 = 未设置，整层惰性。
   * 🔴 刻意**不走 setProjectRes**：那条路会 refresh() 整棵树 + 作废风格缓存，
   *    对一个数字输入来说太重，而且整树刷新可能扰动当前集正在编辑的分镜。
   *    这里复用同一条 IPC（project:res:set），只就地把树上的值改掉。
   */
  async setProjectTargetSec(projectId, sec) {
    try {
      const r = await window.studio.setProjectRes(projectId, { targetSec: sec })
      const p = (this.tree || []).find(x => x.id === Number(projectId))
      if (p && p.res) p.res.targetSec = (r && r.targetSec) || 0
      return r
    } catch (e) { this.fail(e) }
  },
  /** 改当前集某一类分辨率（kind: img|vid|out），本集后续生成立即生效 */
  async setEpisodeRes(kind, value) {
    if (!this.current) return
    try {
      const r = await window.studio.setEpisodeRes(this.current.id, kind, value)
      if (r) this.current.res = r
    } catch (e) { this.fail(e) }
  }
  }
})
