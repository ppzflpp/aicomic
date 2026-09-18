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
    async createProject(name) {
      try {
        const r = await window.studio.createProject(this.workspace, name)
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
        await window.studio.saveChapter(this.workspace, this.current.id, text)
        this.current.chapter = text   // 同步到当前集对象，下游阶段（改编）才能读到
      } catch (e) { this.fail(e) }
    },
    /** 保存阶段工件（adapted/shots/chars/prompts/videoState）并同步到 current */
    async saveArtifact(kind, data) {
      if (!this.current) return
      try {
        // Vue 响应式 Proxy 无法结构化克隆过 IPC，必须先转纯对象
        const plain = kind === 'adapted' ? String(data) : JSON.parse(JSON.stringify(data))
        await window.studio.saveArtifact(this.workspace, this.current.id, kind, plain)
        this.current[kind === 'adapted' ? 'adapted' : kind] = plain
      } catch (e) { this.fail(e); throw e }
    },
    toggleExpand(id) {
      this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id)
    }
  }
})
