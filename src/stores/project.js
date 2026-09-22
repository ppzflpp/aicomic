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
    /** 左侧树的项目媒体（按需懒加载）：{ [projectId]: {assets,shots,films,loading...} } */
    media: {},
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
        this.current = ep
        this.view = 'dash'
        usePipeline().load(ep.done, ep.activeStage, ep.stageMeta, ep.id)
      } catch (e) { this.fail(e) }
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
      } catch (e) { this.fail(e); throw e }
    },
  toggleExpand(id) {
    this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id)
  },
  /* ---- 项目媒体（左侧树：assets 角色图 / 分镜视频 / 成片视频） ---- */
  /** 取（或建）某项目的媒体缓存槽 */
  mediaSlot(projectId) {
    if (!this.media[projectId]) {
      this.media[projectId] = { characters: null, scenes: null, shots: null, films: null, busy: {} }
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
  /** 生成/导出后让左侧树对应节点失效；若该节点此刻正展开，立刻重新拉取（用户能马上看到新产物） */
  async invalidateMedia(projectId, kind) {
    const key = { characters: 'a', shots: 's', films: 'f' }[kind]
    const slot = this.media[projectId]
    if (slot) {
      if (kind === 'characters') { slot.characters = null; slot.scenes = null }
      else if (kind) slot[kind] = null
    }
    if (!key || !projectId || !this.expanded.has(key + projectId)) return
    try {
      if (kind === 'characters') await this.loadAssets(projectId, true)
      else if (kind === 'shots') await this.loadShots(projectId, true)
      else if (kind === 'films') await this.loadFilms(projectId, true)
    } catch (_) { /* 树刷新失败不影响主流程 */ }
  },
  /* ---- 分辨率配置 ---- */
  async loadResOptions() {
    try { this.resOptions = await window.studio.resOptions() } catch (e) { this.fail(e) }
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
