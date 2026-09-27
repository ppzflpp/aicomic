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
    view: 'dash',         // dash | settings
    ask: null,            // 输入弹窗 {title, cb}
    askValue: '',         // 弹窗输入值
    confirmDel: null,     // 删除确认 {type:'project'|'folder'|'episode', id, name}
    resOptions: null,     // 分辨率档位 {img:[{value,label}],vid:[...],out:[...]}，按当前模型过滤
    /** 视频生成档位清单（主进程给，UI 只认档位名，不含任何模型信息）
     *  [{key:'fast'|'balanced'|'hq', label:'速度优先', desc:'…', default:true}] */
    tierOptions: [],
    /** 左侧树的项目媒体（按需懒加载）：{ [projectId]: {assets,shots,films,scripts,loading...} } */
    media: {},
    /** 项目角色场景库（跨集共享的角色/场景条目）：{ [projectId]: {rev, entries, busy} } */
    library: {},
    /** 库编辑区当前打开的目标（不属于任何一集）：{projectId, id} | null */
    libTarget: null,
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
  /** 某库条目被哪些集/哪些镜引用（现扫，不做索引） */
  async libraryUsage(projectId, id) {
    try { return (await window.studio.libraryUsage(this.workspace, projectId, id)) || [] }
    catch (e) { this.fail(e); return [] }
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
  },
  /** 档位默认值（新建项目时预选「平衡」） */
  defaultTier() {
    const d = (this.tierOptions || []).find(t => t.default);
    return (d && d.key) || (this.tierOptions[0] || {}).key || 'balanced';
  },
  /** 改项目分辨率：只影响之后新建的剧集（主进程不回写已有剧集） */
  async setProjectRes(projectId, res) {
    return window.studio.setProjectRes(projectId, res)
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
