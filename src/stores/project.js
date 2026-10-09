import { defineStore } from 'pinia'
import { usePipeline } from './pipeline.js'

export const useProject = defineStore('project', {
  state: () => ({
    workspace: null,
    tree: [],
    models: { ready: false, items: [] },
    health: null,          // 推理服务健康 { llm, comfyui, ffmpeg, endpoints }
    current: null,        // 当前集数对象（全量工件）
    expanded: new Set(),  // 树展开的项目/文件夹 id
    view: 'dash',         // dash | settings | lib | prompts
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
    /** 库编辑区当前打开的目标（不属于任何一集）：{projectId, id} | null */
    libTarget: null,
    /** 提示词配置中心当前打开的项目：{ projectId } | null（同样不属于任何一集）。
     *  🔴 提示词页没有 st.current 可用 —— 读规范、取该项目风格、读写成品覆写都靠它定位项目。 */
    promptTarget: null,
    /** 库引用快照（一次扫全库）：{ projectId, map: { [entryId]: usage[] } }——库视图整页铺卡共用 */
    libUsage: { projectId: '', map: {} },
    error: null           // 最近一次 IPC 错误（App 监听后 toast）
  }),
  actions: {
    fail(e) { this.error = (e && e.message) || String(e) },
    async boot() {
      try {
        this.workspace = await window.studio.getWorkspace()
        if (!this.workspace) this.workspace = await window.studio.chooseWorkspace()
        await this.refresh()
        this.models = await window.studio.checkModels()
        this.health = await window.studio.inferHealth()
        await this.refreshCaps()
        // 分辨率档位 / 视频档位清单也随模型方案走（方案声明自己的分辨率与档位表）
        await this.loadResOptions()
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
        this.libTarget = null   // 打开某一集 → 右侧回到 5 块工作区（离开库编辑区）
        this.current = ep
        this.view = 'dash'
        usePipeline().load(ep.done, ep.activeStage, ep.stageMeta, ep.id)
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
      this.library[projectId] = { rev: (r && r.rev) || 1, entries: (r && r.entries) || [], busy: false }
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
    } catch (_) { /* 刷新失败不影响「已保存」这个事实 */ }
    return r
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
