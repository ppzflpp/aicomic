<template>
  <div class="tree-node">
    <div class="tree-row" :style="{paddingLeft: (10 + depth*16) + 'px'}" @click="st.toggleExpand('f'+node.id)">
      <span class="caret">{{ st.expanded.has('f'+node.id) ? '▼' : '▶' }}</span>
      <span class="tree-title">📁 {{ node.name }}</span>
      <span class="ops">
        <button title="新建子文件夹" @click.stop="newFolder">＋夹</button>
        <button title="新建集数" @click.stop="newEpisode">＋集</button>
        <button class="op-del" title="删除文件夹" @click.stop="askDel">✕</button>
      </span>
    </div>
    <template v-if="st.expanded.has('f'+node.id)">
      <folder-node v-for="f in node.folders" :key="f.id" :node="f" :depth="depth+1" />
      <div v-for="e in node.episodes" :key="e.id" class="tree-row ep-row"
           :class="{active: st.current && st.current.id===e.id}"
           :style="{paddingLeft: (26 + depth*16) + 'px'}"
           @click="st.openEpisode(e.id)">
        <span class="tree-title">📄 {{ e.name }}</span>
        <i v-if="episodeHasVideoTask(e.id)" class="nav-dot" title="该集有视频任务在跑（切菜单/切集不中断）"></i>
        <span class="ops">
          <button class="op-del" title="删除集数" @click.stop="st.askDelete('episode', e.id, e.name)">✕</button>
        </span>
      </div>
    </template>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { state as taskCenterState } from './taskCenter.js'

export default {
  name: 'FolderNode',
  props: { node: { type: Object, required: true }, depth: { type: Number, default: 1 } },
  computed: {
    st() { return useProjectStore() },
    /** 活跃任务按集聚合（读 reactive 的 current/queue，建立响应式依赖，避免提交任务后漏渲染） */
    activeByEp() {
      const map = {}
      const tasks = []
      if (taskCenterState.current) tasks.push(taskCenterState.current)
      for (const t of taskCenterState.queue) tasks.push(t)
      for (const t of tasks) {
        if (t.episodeId == null) continue
        const k = String(t.episodeId)
        ;(map[k] = map[k] || []).push(t)
      }
      return map
    }
  },
  methods: {
    episodeHasVideoTask(id) {
      const list = this.activeByEp[String(id)]
      return !!(list && list.some(t => t.type === 'video'))
    },
    newFolder() {
      // 找到所属项目 id
      const pid = this.findProjectId(this.st.tree, this.node.id)
      this.st.askText('子文件夹名称', '', name =>
        this.st.addFolder(pid, this.node.id, name).then(() => this.st.toggleExpand('f' + this.node.id)))
    },
    newEpisode() {
      const pid = this.findProjectId(this.st.tree, this.node.id)
      this.st.askText('集数名称', '', name =>
        this.st.addEpisode(pid, this.node.id, name).then(() => this.st.toggleExpand('f' + this.node.id)))
    },
    askDel() {
      this.st.askDelete('folder', this.node.id, this.node.name)
    },
    findProjectId(nodes, folderId) {
      for (const p of nodes) {
        const walk = (folders) => {
          for (const f of folders) {
            if (f.id === folderId) return true
            if (walk(f.folders)) return true
          }
          return false
        }
        if (walk(p.folders)) return p.id
      }
      return null
    }
  }
}
</script>
