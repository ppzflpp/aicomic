<template>
<div class="shell">
  <!-- 顶部标题栏（无边框窗口拖拽区） -->
  <header class="titlebar">
    <div class="tb-brand">
      <span class="tb-logo"></span>
      <span class="tb-name">飞鱼AI漫剧</span>
    </div>
    <span class="tb-sep"></span>
    <div class="tb-crumb">
      <span>{{ workspaceName }}</span>
      <template v-if="st.current && st.view==='dash'">
        <span class="tb-slash">/</span><b>{{ st.current.name }}</b>
      </template>
      <template v-if="st.view==='settings'">
        <span class="tb-slash">/</span><b>设置与环境检测</b>
      </template>
    </div>
    <span style="flex:1"></span>

    <!-- 实时系统监控：GPU / CPU / 内存（大小 + 使用率） -->
    <div class="tb-sys" :class="{narrow}">
      <span class="tb-metric" :class="gpuView.cls" :title="gpuView.title">
        <b>GPU</b>
        <i class="mm-bar"><em :style="{width: gpuView.pct + '%'}"></em></i>
        <span class="mm-txt">{{ gpuView.text }}</span>
        <span class="mm-sub">{{ gpuView.sub }}</span>
      </span>
      <span class="tb-metric" :class="cpuView.cls" :title="cpuView.title">
        <b>CPU</b>
        <i class="mm-bar"><em :style="{width: cpuView.pct + '%'}"></em></i>
        <span class="mm-txt">{{ cpuView.text }}</span>
        <span class="mm-sub">{{ cpuView.sub }}</span>
      </span>
      <span class="tb-metric" :class="memView.cls" :title="memView.title">
        <b>内存</b>
        <i class="mm-bar"><em :style="{width: memView.pct + '%'}"></em></i>
        <span class="mm-txt">{{ memView.text }}</span>
        <span class="mm-sub">{{ memView.sub }}</span>
      </span>
    </div>

    <span class="tb-sep"></span>
    <div class="tb-chips">
      <span class="tb-chip" :class="st.health && st.health.llm ? 'on' : 'off'"><i></i>LLM</span>
      <span class="tb-chip" :class="st.health && st.health.comfyui ? 'on' : 'off'"><i></i>ComfyUI</span>
      <span class="tb-chip" :class="st.health && st.health.ffmpeg ? 'on' : 'off'"><i></i>ffmpeg</span>
    </div>
  </header>

  <div class="app-body">
  <!-- 左侧菜单栏 -->
  <aside class="sidebar">
    <div class="side-actions">
      <button class="btn-new" @click="newProject">＋ 新建项目</button>
    </div>
    <div class="side-scroll">
      <div class="side-h">项目</div>
      <template v-for="p in st.tree" :key="p.id">
        <div class="tree-node">
          <div class="tree-row" @click="st.toggleExpand('p'+p.id)">
            <span class="caret">{{ st.expanded.has('p'+p.id) ? '▾' : '▸' }}</span>
            <span>{{ p.name }}</span>
            <span class="ops">
              <button title="新建子文件夹" @click.stop="newFolder(p.id, null)">＋夹</button>
              <button title="新建集数" @click.stop="newEpisode(p.id, null)">＋集</button>
              <button class="op-del" title="删除项目" @click.stop="st.askDelete('project', p.id, p.name)">✕</button>
            </span>
          </div>
          <template v-if="st.expanded.has('p'+p.id)">
            <folder-node v-for="f in p.folders" :key="f.id" :node="f" :depth="1" />
            <div v-for="e in p.episodes" :key="e.id" class="tree-row ep-row"
                 :class="{active: st.current && st.current.id===e.id}" @click="st.openEpisode(e.id)">
              📄 {{ e.name }}
              <span class="ops">
                <button class="op-del" title="删除集数" @click.stop="st.askDelete('episode', e.id, e.name)">✕</button>
              </span>
            </div>
          </template>
        </div>
      </template>
      <div class="side-sep"></div>
      <div class="side-h">角色资源库</div>
      <div class="tree-row" style="cursor:default">🗂 {{ workspaceName }}/library</div>
    </div>
    <!-- 模型与工作区信息统一放在最底状态栏，这里只留入口 -->
    <div class="side-foot">
      <button class="btn-new" style="margin:0" @click="st.view='settings'">⚙ 设置</button>
    </div>
  </aside>

  <!-- 主区域 -->
  <div class="main">
    <div class="pathbar">
      <button class="btn ghost" style="padding:3px 10px; font-size:12px" v-if="st.view==='settings'" @click="st.view='dash'">← 返回</button>
      <span class="crumb">工作区 <b>{{ workspaceName }}</b></span>
      <template v-if="st.view==='dash' && st.current">
        <span class="crumb">/ <b>{{ st.current.name }}</b></span>
      </template>
      <template v-if="st.view==='settings'">
        <span class="crumb">/ <b>设置与环境检测</b></span>
      </template>
      <span style="flex:1"></span>
      <button class="btn ghost" style="padding:4px 12px; font-size:12px" @click="chooseWs">更改工作区</button>
    </div>

    <!-- 设置视图 -->
    <div class="content" v-if="st.view==='settings'">
      <settings-panel />
    </div>

    <!-- 仪表盘视图 -->
    <div class="content" v-else>
      <div v-if="!st.current" class="placeholder" style="margin-top:60px">
        左侧选择或新建一个集数开始
      </div>
      <div v-else class="grid">
        <!-- key 带上集数 id：换集时强制重挂载，避免上一集的内容（角色库/视频等）残留 -->
        <section v-for="(s,i) in stages" :key="stageKey(i)" class="stage"
                 :class="{done: pl.done[i], running: isRunning(i), locked: isLockedStage(i)}">
          <div class="stage-head">
            <span class="s-num">{{ i+1 }}</span>
            <span class="s-title">{{ s.title }}</span>
            <span class="s-time" v-if="pl.timeText(i)">{{ pl.timeText(i) }}</span>
            <span class="s-sum">{{ sums[i] }}</span>
            <span class="s-status" :class="statusCls(i)">{{ statusText(i) }}</span>
            <button v-if="pl.done[i]" class="u-btn" @click="askUnlock(i)">解锁重做</button>
          </div>
          <!-- 锁定阶段不加蒙版：用 inert 真正禁用内部控件（不可点 / 不可聚焦 / 不进 Tab）。
               例外：标了 playable 的块（视频生成）不加 inert —— 已生成的视频在任何状态下都要能播放；
               它改用 locked prop 把内部「操作按钮」全部 disabled，防误触效果一致。 -->
          <div class="stage-body" :inert="pl.isLocked(i) && !s.playable">
            <stage-adapt v-if="i===1" />
            <stage-shots v-else-if="i===2" />
            <stage-chars v-else-if="i===3" />
            <stage-prompts v-else-if="i===4" />
            <stage-videos v-else-if="i===5" :locked="pl.isLocked(5)" />
            <stage-export v-else-if="i===6" />
            <!-- 1 章节输入 -->
            <template v-else>
              <textarea v-model="chapter" rows="8" placeholder="粘贴小说章节原文…" @change="st.saveChapter(chapter)"></textarea>
              <div class="ops-bar">
                <span class="hint">{{ chapter.trim().length }} 字</span>
                <span style="flex:1"></span>
                <button class="btn" :disabled="chapter.trim().length<50" @click="pl.confirm(0, st.current.id)">下一步</button>
              </div>
            </template>
          </div>
        </section>
      </div>
    </div>

    <!-- 运行日志（底部可折叠抽屉） -->
    <log-panel />

    <div class="statusbar">
      <span>阶段：{{ st.view==='settings' ? '—' : (pl.active+1) + '/7' }}</span>
      <span class="sb-sep"></span>
      <!-- 推理服务 -->
      <span class="sbc" :class="st.health && st.health.llm ? 'on' : 'off'" title="LLM 推理服务（llama-server）">LLM</span>
      <span class="sbc" :class="st.health && st.health.comfyui ? 'on' : 'off'" title="ComfyUI（角色出图 / H3 视频）">ComfyUI</span>
      <span class="sbc" :class="st.health && st.health.ffmpeg ? 'on' : 'off'" title="ffmpeg（合成成片与字幕）">ffmpeg</span>
      <span class="sb-sep"></span>
      <!-- 模型就位情况（底模 / H3 等，悬停看文件名与缺失原因） -->
      <span v-for="m in st.models.items" :key="m.key" class="sbc" :class="m.ok ? 'on' : 'off'" :title="modelTip(m)">
        {{ m.short || m.key }}<b v-if="m.ok">{{ m.count }}</b>
      </span>
      <span v-if="pl.totalMs">累计耗时：{{ fmtMs(pl.totalMs) }}</span>
      <span style="flex:1"></span>
      <span class="sb-path" :title="'工作区：' + (st.workspace || '')">{{ st.workspace }}</span>
      <span class="sb-log" :class="{on: logs.open}" @click="logs.toggle()">
        运行日志<b v-if="logs.unreadErr" class="sb-badge">{{ logs.unreadErr > 99 ? '99+' : logs.unreadErr }}</b>
      </span>
      <span>v0.3.0-m5</span>
    </div>
  </div>
  </div>
</div>

  <!-- 输入弹窗 -->
  <div class="mask" :class="{hidden: !st.ask}">
    <div class="dialog">
      <h3>{{ st.ask?.title }}</h3>
      <input type="text" v-model="st.askValue" @keyup.enter="st.confirmAsk()" />
      <div class="row">
        <button class="btn ghost" @click="st.ask = null">取消</button>
        <button class="btn" @click="st.confirmAsk()">确定</button>
      </div>
    </div>
  </div>

  <!-- 危险确认弹窗（删除 / 解锁重做） -->
  <div class="mask" :class="{hidden: confirmBox === null}">
    <div class="dialog danger">
      <h3>解锁重做</h3>
      <p class="hint">解锁后该块及其后续所有已完成步骤的结果将全部作废，需要逐步重新确认。确定继续吗？</p>
      <div class="row">
        <button class="btn ghost" @click="confirmBox=null">取消</button>
        <button class="btn" style="background:var(--danger)" @click="doUnlock">确定解锁</button>
      </div>
    </div>
  </div>
  <div class="mask" :class="{hidden: !st.confirmDel}">
    <div class="dialog danger">
      <h3>删除{{ delLabel }}</h3>
      <p class="hint">将删除「{{ st.confirmDel?.name }}」{{ delScope }}，<b>磁盘文件一并删除且不可恢复</b>。确定继续吗？</p>
      <div class="row">
        <button class="btn ghost" @click="st.confirmDel=null">取消</button>
        <button class="btn" style="background:var(--danger)" @click="st.doDelete(); toast('已删除')">确认删除</button>
      </div>
    </div>
  </div>

  <div class="toast" :class="{hidden: !toastMsg}">{{ toastMsg }}</div>
</template>

<script>
import FolderNode from './FolderNode.vue'
import SettingsPanel from './SettingsPanel.vue'
import StageAdapt from './StageAdapt.vue'
import StageShots from './StageShots.vue'
import StageChars from './StageChars.vue'
import StagePrompts from './StagePrompts.vue'
import StageVideos from './StageVideos.vue'
import StageExport from './StageExport.vue'
import LogPanel from './LogPanel.vue'

export default {
  components: { FolderNode, SettingsPanel, StageAdapt, StageShots, StageChars, StagePrompts, StageVideos, StageExport, LogPanel },
  data() {
    return {
      stages: [
        { title: '章节输入' },
        { title: '漫剧化改编' },
        { title: '分镜脚本' },
        { title: '角色库' },
        { title: 'H3 提示词' },
        // playable：该块即使在「已完成/未解锁」状态下，也要允许播放已生成的产物（视频）
        { title: '视频生成', playable: true },
        { title: '组装成片' }
      ],
      chapter: '',
      confirmBox: null,
      toastMsg: null,
      m: null,          // 系统指标快照 { cpu, mem, gpu }
      narrow: false,    // 窗口窄时折叠指标文字
      _offMet: null,
      _offResize: null,
      _tickTimer: null
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    logs() { return useLogs() },
    workspaceName() { return (this.st.workspace || '').split(/[\\/]/).pop() },
    delLabel() {
      return { project: '项目', folder: '文件夹', episode: '集数' }[this.st.confirmDel?.type] || ''
    },
    delScope() {
      return this.st.confirmDel?.type === 'episode' ? '（含已生成的全部文件）' : '及其全部子文件夹、集数与文件'
    },
    gpuView() {
      const g = this.m && this.m.gpu
      if (!g || !g.ok) {
        return { text: '—', sub: '', pct: 0, cls: 'off', title: '未检测到 NVIDIA 显卡（或 nvidia-smi 不可用）' }
      }
      const util = g.util == null ? 0 : g.util
      const used = (g.usedMiB / 1024).toFixed(1)
      const total = (g.totalMiB / 1024).toFixed(1)
      const memPct = g.memPercent == null ? '—' : g.memPercent
      const procs = (g.procs || []).filter(p => p.memMiB > 800)
        .map(p => p.name + ' ' + (p.memMiB / 1024).toFixed(1) + 'G').join('、')
      return {
        text: util + '% · 显存 ' + memPct + '%',
        sub: g.tempC != null ? g.tempC + '℃' : '',
        pct: (g.memPercent || 0),
        cls: (g.memPercent || 0) >= 92 ? 'hi' : (util >= 90 ? 'hot' : ''),
        title: g.name + '｜GPU 算力占用 ' + util + '%｜显存 ' + used + ' / ' + total + ' GB（' + memPct + '%）'
          + (procs ? '｜显存占用：' + procs : '｜当前无进程占用显存')
      }
    },
    cpuView() {
      const c = this.m && this.m.cpu
      if (!c) return { text: '—', sub: '', pct: 0, cls: 'off', title: 'CPU 采样中…' }
      return {
        text: c.load + '%',
        sub: c.cores + ' 核',
        pct: c.load,
        cls: c.load >= 90 ? 'hi' : '',
        title: (c.model || 'CPU') + '｜' + c.cores + ' 逻辑核心'
      }
    },
    memView() {
      const mm = this.m && this.m.mem
      if (!mm) return { text: '—', sub: '', pct: 0, cls: 'off', title: '内存采样中…' }
      const used = (mm.used / 1024 / 1024 / 1024).toFixed(1)
      const total = (mm.total / 1024 / 1024 / 1024).toFixed(1)
      return {
        text: mm.percent + '% · ' + used + '/' + total + 'G',
        sub: '',
        pct: mm.percent,
        cls: mm.percent >= 92 ? 'hi' : '',
        title: '物理内存 ' + used + ' / ' + total + ' GB'
      }
    },
    sums() {
      const ep = this.st.current
      const ch = this.chapter.trim().length
      return [
        ch ? ch + ' 字' : '粘贴原文或载入',
        this.pl.done[1] ? '改编稿已确认' : (ep && ep.adapted ? '改编稿已生成，待确认' : '等待改编'),
        this.pl.done[2] ? (ep ? ep.shots.length + ' 个分镜已确认' : '分镜已确认') : '等待分镜',
        this.pl.done[3] ? '角色已锁定' : '等待角色',
        this.pl.done[4] ? '提示词已确认' : '等待提示词',
        this.pl.done[5] ? '视频已生成' : '等待视频',
        this.pl.done[6] ? '成片已导出' : '等待组装'
      ]
    }
  },
  mounted() {
    this.bootUp()
    this.logs.init()
    // 实时系统指标
    this._offMet = window.studio.onMetrics(s => { this.m = s })
    window.studio.metricsOnce().then(s => { if (s) this.m = s }).catch(() => {})
    // 每秒推进一次，驱动「进行中」阶段的实时计时
    this._tickTimer = setInterval(() => this.pl.tickLive(), 1000)
    // 每 5s 轮询一次 llama / ComfyUI 真实健康状态（标题栏胶囊实时准确）
    this._healthTimer = setInterval(() => this.st.refreshHealth(), 5000)
    // 窄窗口折叠指标文字
    this._offResize = () => { this.narrow = window.innerWidth < 1400 }
    this._offResize()
    window.addEventListener('resize', this._offResize)
  },
  beforeUnmount() {
    if (this._offMet) this._offMet()
    if (this._tickTimer) clearInterval(this._tickTimer)
    if (this._healthTimer) clearInterval(this._healthTimer)
    if (this._offResize) window.removeEventListener('resize', this._offResize)
  },
  watch: {
    'st.error'(msg) {
      if (msg) { this.toast('出错：' + msg); this.st.error = null }
    },
    'st.current': {
      handler(ep) {
        this.chapter = ep ? (ep.chapter || '') : ''
        this.syncEngine()
      },
      immediate: true
    },
    // 进入新阶段 → 自动把该阶段的引擎准备好、把上一阶段的让出去
    'pl.active'() { this.syncEngine() },
    // 从设置页返回工作区时也补一次编排（此时集数没变，靠 current 的 watch 不会触发）
    'st.view'(v) { if (v === 'dash') this.syncEngine() }
  },
  methods: {
    fmtMs,
    /**
     * 启动顺序很重要：先加载工作区与项目树 → 再恢复上次的页面（现场）→ 最后才装上自动保存。
     * 反过来的话，默认状态（首页/无集数）会先把现场覆盖掉。
     */
    async bootUp() {
      await this.st.boot()
      try {
        if (await restoreSession()) this.toast('已恢复上次的页面')
      } catch (_) { /* 现场损坏不阻塞启动 */ }
      installSessionAutoSave()
    },
    /** 阶段引擎编排：进哪个阶段就启哪个（第 1 块不需要引擎，避免闲置时误杀服务） */
    syncEngine() {
      if (this.st.view !== 'dash' || !this.st.current) return
      const i = this.pl.active
      if (i <= 0) return
      window.studio.ensureEngine(i).catch(() => { /* 失败原因已写进运行日志 */ })
    },
    statusText(i) {
      if (this.pl.done[i]) return '已完成'
      if (i === this.pl.active) return '进行中'
      return i < this.pl.active ? '已锁定' : '未解锁'
    },
    /** 阶段组件的 key：换集时变化 → 强制重挂载，清空上一集残留（角色库/视频/提示词…） */
    stageKey(i) {
      return (this.st.current ? this.st.current.id : 0) + ':' + i
    },
    /** 进行中的阶段（绿色边框） */
    isRunning(i) {
      return i === this.pl.active && !this.pl.done[i]
    },
    /** 未解锁的阶段（灰色虚线边框）；已完成的锁定块由 .done 类走红色边框 */
    isLockedStage(i) {
      return !this.pl.done[i] && i > this.pl.active
    },
    /** 状态栏模型胶囊的悬停提示：文件名 / 缺失原因 + 目录 */
    modelTip(m) {
      const name = m.short || m.key
      if (m.ok) {
        const files = (m.sample && m.sample.length) ? m.sample.join('、') : (m.count + ' 个文件')
        return name + '：' + files + (m.path ? '\n' + m.path : '')
      }
      return name + '：缺失' + (m.hint ? '（' + m.hint + '）' : '') + (m.path ? '\n' + m.path : '')
    },
    statusCls(i) {
      if (this.pl.done[i]) return 'st-done'
      if (i === this.pl.active) return 'st-run'
      return i < this.pl.active ? 'st-idle' : 'st-wait'
    },
    newProject() {
      this.st.askText('项目名称', '新项目', name => this.st.createProject(name).then(() => this.toast('已新建项目：' + name)))
    },
    newFolder(pid, parentId) {
      this.st.askText('子文件夹名称', '', name => this.st.addFolder(pid, parentId, name).then(() => this.toast('已新建文件夹')))
    },
    newEpisode(pid, folderId) {
      const p = this.st.tree.find(x => x.id === pid)
      const n = p ? p.episodes.length + 1 : 1
      this.st.askText('集数名称', '第 ' + n + ' 集',
        name => this.st.addEpisode(pid, folderId, name).then(() => this.toast('已新建集数')))
    },
    async chooseWs() {
      const ws = await window.studio.chooseWorkspace()
      if (ws) { this.st.workspace = ws; await this.st.refresh(); await this.st.refreshEnv() }
    },
    askUnlock(i) { this.confirmBox = i },
    doUnlock() {
      const i = this.confirmBox
      this.confirmBox = null
      this.pl.unlockFrom(i, this.st.current.id)
      this.toast('已解锁第 ' + (i+1) + ' 块，后续结果作废')
    },
    toast(msg) {
      this.toastMsg = msg
      clearTimeout(this._t)
      this._t = setTimeout(() => this.toastMsg = null, 2600)
    }
  }
}

import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { useLogs } from './stores/logs.js'
import { restoreSession, installSessionAutoSave } from './session.js'
import { defineStore } from 'pinia'
</script>
