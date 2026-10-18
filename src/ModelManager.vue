<template>
  <div class="set-card mm-card">
    <div class="mm-head">
      <h3>模型管家</h3>
      <button class="mm-q" :class="{ on: help }" title="怎么选？" @click="help = !help">?</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" :disabled="!!progress || picking" @click="chooseComfyDir">{{ picking ? '识别中…' : '选择 ComfyUI 安装目录…' }}</button>
    </div>

    <!-- 说明：默认收起，只有点「?」才展开 -->
    <div v-if="help" class="mm-help">
      <div>选 <b>ComfyUI 装在哪</b>那一层就行，软件自己找它下面的 models：</div>
      <div class="mm-help-i">Desktop 版：<span class="mono">…\Comfy Desktop</span>（有 Comfy Desktop.exe 的目录）</div>
      <div class="mm-help-i">便携版：<span class="mono">…\ComfyUI_windows_portable</span> 或其中的 <span class="mono">ComfyUI</span> 目录</div>
      <div class="mm-help-w">不用选到 models 那一层，也不要选工作区目录。</div>
    </div>

    <!-- ① 模型目录：一行 -->
    <div class="mm-line">
      <span class="mm-line-k">模型目录</span>
      <template v-if="state.root">
        <span class="mm-line-v mono" :title="state.root">{{ state.root }}</span>
        <span v-if="state.freeText" class="mm-dim">剩余 {{ state.freeText }}</span>
      </template>
      <span v-else class="mm-line-hint">请选择 ComfyUI 安装目录</span>
    </div>

    <!-- ② 只在这个目录不对时才出现的一行 -->
    <div v-if="rootBad" class="mm-msg bad">{{ rootBad }}</div>

    <!-- ③ ComfyUI 版本：选完目录自动检测 -->
    <div class="mm-line">
      <span class="mm-line-k">ComfyUI</span>
      <span class="mm-ver" :class="ver.cls" :title="ver.title || ''">{{ ver.text }}</span>
      <span v-if="comfy && comfy.running && ver.cls !== 'dim'" class="mm-dim">运行中</span>
      <button v-if="ver.cls === 'bad'" class="btn ghost sm" @click="openDownload">去下载</button>
      <!-- 配套节点徽标：只有运行中的 ComfyUI 真加载了才算「已就绪」 -->
      <span v-if="nodeBadge" class="mm-node" :class="nodeBadge.cls" :title="nodeBadge.title || ''">
        {{ nodeBadge.text }}<template v-if="nodeBadge.retry && !provisioning">
          <button class="mm-node-retry" @click="retryProvision">重试</button>
        </template>
      </span>
      <span style="flex:1"></span>
      <button class="mm-fold" @click="detail = !detail">
        {{ detail ? '详情 ▴' : '详情 ▾' }}<b v-if="hasIssue" class="mm-fold-dot"></b>
      </button>
    </div>

    <!-- ③b 节点安装失败：按原因给动作（权限 / 占用 / 路径错），常驻不消失 -->
    <div v-if="provError" class="mm-msg bad mm-msg-act">
      <span>{{ provError }}</span>
      <button class="btn ghost sm" :disabled="provisioning" @click="retryProvision">{{ provisioning ? '安装中…' : '重试' }}</button>
    </div>

    <!-- ④ 详情：默认收起，排查用 -->
    <div v-if="detail" class="mm-detail">
      <div class="mm-d-row">
        <span class="mm-d-k">安装位置</span>
        <span v-if="!comfy" class="mm-dim">正在读取…</span>
        <span v-else-if="comfy.error" class="mm-bad">读取失败：{{ comfy.error }}</span>
        <span v-else-if="!comfy.installDir" class="mm-dim">没找到 ComfyUI 安装目录</span>
        <template v-else>
          <span class="mm-d-v mono" :title="comfy.installDir">{{ comfy.installDir }}</span>
          <span v-if="comfy.installLabel" class="mm-d-tag">{{ comfy.installLabel }}</span>
        </template>
      </div>

      <div v-if="comfy && !comfy.error && comfy.desktopHasApp" class="mm-d-row">
        <span class="mm-d-k">实例</span>
        <span v-if="comfy.instanceCount" class="mm-d-v">{{ comfy.instanceCount }} 个<template v-if="comfy.instanceNames.length"> · {{ comfy.instanceNames.join('、') }}</template></span>
        <span v-else class="mm-bad">一个都没有（要先去 ComfyUI Desktop 里创建）</span>
      </div>

      <div v-if="comfy && !comfy.error && comfy.installDir && comfy.nodes && comfy.nodes.available" class="mm-d-row">
        <span class="mm-d-k">配套节点</span>
        <span v-if="comfy.nodes.upToDate" class="model-ok">已是最新</span>
        <span v-else class="mm-bad">{{ comfy.nodes.installed ? '待更新' : '未安装' }}</span>
        <span v-if="comfy.nodes.dirs && comfy.nodes.dirs.length" class="mm-d-v mono" :title="comfy.nodes.dirs.join('\n')">
          {{ comfy.nodes.dirs.length }} 处 · {{ comfy.nodes.dirs[0] }}
        </span>
      </div>

      <div v-if="comfy && comfy.running" class="mm-d-row">
        <span class="mm-d-k">已识别</span>
        <span class="mm-dim">
          主模型 {{ n(comfy.visible && comfy.visible.diffusion_models) }} ·
          文本编码器 {{ n(comfy.visible && comfy.visible.text_encoders) }} ·
          VAE {{ n(comfy.visible && comfy.visible.vae) }} ·
          LoRA {{ n(comfy.visible && comfy.visible.loras) }} ·
          底模 {{ n(comfy.visible && comfy.visible.checkpoints) }}
        </span>
      </div>

      <div class="mm-d-row">
        <span class="mm-d-k"></span>
        <span class="mm-dim">
          {{ comfy && comfy.running ? '上面的数量是 ComfyUI 启动时扫到的，删了文件要重启才会变。' : 'ComfyUI 没运行，只比对了目录。' }}
        </span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" :disabled="cfLoading" @click="loadComfy">{{ cfLoading ? '读取中…' : '刷新' }}</button>
      </div>
    </div>

    <!-- 槽位清单：软件需要哪些模型、缺不缺、该放进哪个子目录 -->
    <div class="mm-row" v-for="s in state.slots" :key="s.key">
      <span class="mm-dot" :class="s.ok ? 'on' : 'off'"></span>
      <span class="mm-name" :title="s.why">{{ s.label }}</span>
      <span class="mm-stat" :class="s.ok ? 'model-ok' : 'model-no'">{{ s.ok ? ('已就位 ' + s.count) : '缺失' }}</span>
      <span class="hint mm-sub mono" :title="s.dir">{{ state.root ? s.sub + '\\' : '（未定）' }}</span>
      <span class="hint mm-need" :title="s.need">{{ s.need }}</span>
    </div>

    <!-- 批量导入 -->
    <div class="mm-ops">
      <span style="flex:1"></span>
      <button class="btn sm" :disabled="!!progress || !state.root" @click="batchPick">批量导入文件夹…</button>
    </div>

    <!-- 待确认清单：扫描结果（含手选用途） -->
    <div v-if="pending.length" class="mm-pending">
      <div class="mm-pending-head">
        <b>待导入 {{ pending.length }} 个文件</b>
        <span class="hint">合计 {{ human(totalPendingBytes) }}{{ unknownCount ? ('　其中 ' + unknownCount + ' 个需要你选用途') : '' }}</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="pending = []">取消</button>
        <button class="btn sm" :disabled="!runnable" @click="startImport">开始导入</button>
      </div>
      <div class="mm-p-row" v-for="(p, i) in pending" :key="p.src">
        <span class="mm-p-name mono" :title="p.src">{{ p.name }}</span>
        <span class="hint mm-p-size">{{ human(p.size) }}</span>
        <select v-if="!p.sub" v-model="p.key" class="mm-p-sel" @change="assign(i)">
          <option value="">— 选择用途 —</option>
          <option v-for="s in state.slots" :key="s.key" :value="s.key">{{ s.label }} → {{ s.sub }}\</option>
        </select>
        <span v-else class="hint mm-p-dst mono">{{ p.sub }}\</span>
        <button class="btn ghost sm" title="从待导入列表移除" @click="pending.splice(i, 1)">✕</button>
      </div>
    </div>

    <!-- 拷贝进度 -->
    <div v-if="progress" class="mm-prog">
      <div class="mm-prog-head">
        <span class="mm-prog-file mono" :title="progress.file">{{ progress.file || '准备中…' }}</span>
        <span class="hint">{{ Math.round((progress.percent || 0) * 100) }}%（{{ progress.index + 1 }}/{{ progress.total }}）</span>
      </div>
      <div class="progress mm-bar"><div class="bar" :style="{ width: Math.round((progress.percent || 0) * 100) + '%' }"></div></div>
      <div class="mm-prog-foot">
        <span class="hint">
          {{ human(progress.done) }} / {{ human(progress.totalBytes) }}
          <span v-if="progress.speed">· {{ human(progress.speed) }}/s</span>
          <span v-if="etaText">· 剩余约 {{ etaText }}</span>
        </span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="cancel">取消拷贝</button>
      </div>
    </div>

    <!-- 上次结果 -->
    <div v-else-if="result" class="mm-result">
      <span :class="result.failed && result.failed.length ? 'model-no' : 'model-ok'">
        {{ result.cancelled ? '已取消：' : '导入结束：' }}
        成功 {{ result.copied.length }} · 跳过 {{ result.skipped.length }} ·
        冲突 {{ result.conflicts.length }} · 失败 {{ result.failed.length }} ·
        共 {{ human(result.bytes) }}
      </span>
      <span style="flex:1"></span>
      <button class="btn ghost sm" @click="result = null">知道了</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'ModelManager',
  data() {
    return {
      state: { root: '', rootOk: false, slots: [], freeText: '' },
      help: false,          // 「?」说明（默认收起 —— 主界面不摆说明书）
      detail: false,        // 详情面板（默认收起）
      picking: false,       // 正在选 ComfyUI 安装目录 + 推导 models
      pickError: '',        // 推导失败的原因（只在推导失败时占一行）
      noInstTip: '',        // 「装了 Desktop 但没建实例」的引导（和目录错误分开，互不覆盖）
      rootCheck: null,      // 当前模型目录的校验结果（{level:'ok'|'warn'|'bad', message, hints}）
      comfy: null,          // ComfyUI 体检结果（安装位置 / 版本 / 它认得哪些文件）
      cfLoading: false,
      provisioning: false,  // 正在把配套节点写进 custom_nodes
      provError: '',        // 节点安装失败的原因（按错误类型给动作，常驻一行）
      pending: [],          // [{ src, name, size, key, sub }]  sub 空 = 待用户选用途
      progress: null,       // 拷贝进度（来自主进程推送）
      result: null,         // 上次拷贝结果
      _off: null,
      _verTimer: null,      // 未启动 ComfyUI 时的版本轮询
      _autoProv: false      // 自动补装只试一次，避免轮询里反复写盘
    }
  },
  computed: {
    /** 版本行：只给结论，不给解释 */
    ver() {
      const c = this.comfy
      if (!c) return { text: '检测中…', cls: 'dim' }
      if (c.error) return { text: '检测失败', cls: 'dim' }
      // 「装了 Desktop 但没建实例」必须排在「未找到 ComfyUI」前面：
      // 这时 installDir 往往是空的，但用户已经装了程序，只是没建实例。
      if (c.noInstance) return { text: '请先创建 ComfyUI 实例', cls: 'warn' }
      if (!c.installDir) return { text: '未找到 ComfyUI', cls: 'dim' }
      // 版本只在 ComfyUI 运行时才准（磁盘上的版本文件分不清用户会用哪个实例）
      if (!c.running) {
        // 「没建实例」和「没启动」是两回事：前者要去 Desktop 新建，后者只需启动
        if (c.noInstance) return { text: '请先创建 ComfyUI 实例', cls: 'warn' }
        return { text: '请先启动 ComfyUI 实例', cls: 'dim' }
      }
      const v = c.version || {}
      const min = v.min || '0.37.0'
      if (v.ok === true) return { text: (v.text || '版本已达标') + ' ✔', cls: 'ok' }
      // 版本不够 → 直接说后果（用户确认的文案：运行软件会出错）
      if (v.ok === false) {
        return { text: (v.text ? v.text + ' ' : '') + '版本太低（需要 v' + min + ' 以上），运行软件会出错', cls: 'bad' }
      }
      return { text: '版本未知（ComfyUI 未上报版本）', cls: 'dim' }
    },
    /**
     * 配套节点徽标。四种状态，判据是「磁盘事实 + 运行实证」：
     *   ready   = 运行中的 ComfyUI 真的加载了 EmptyQwenImage21LatentImage（唯一可信的"已就绪"）
     *   standby = 文件已就位，但 ComfyUI 没运行 → 启动时才加载
     *   restart = 文件已就位且 ComfyUI 在跑，但当前实例没加载 → 必须重启
     *   missing = 磁盘上没有 / 不是最新 → 点重试
     */
    nodeBadge() {
      const c = this.comfy
      if (!c || c.error) return null
      // 没建实例时：版本行已经说「请先创建 ComfyUI 实例」，下面还有一行动作引导，
      // 徽标就不再重复第三遍。
      if (c.noInstance) return null
      if (!c.installDir) return null
      if (this.provisioning) return { cls: 'dim', text: '正在置备节点…' }
      const st = c.nodeState || ''
      if (st === 'ready') return { cls: 'ok', text: '节点已就绪' }
      if (st === 'standby') {
        return {
          cls: 'dim', text: '节点已置备 · 启动后生效',
          title: '节点文件已在 custom_nodes 里，ComfyUI 启动时会自动加载。'
        }
      }
      if (st === 'restart') {
        return {
          cls: 'warn', text: '已装好 · 需重启 ComfyUI',
          title: '当前运行的 ComfyUI 是在装节点之前启动的，不会热加载。关掉 ComfyUI 再打开一次即可。'
        }
      }
      if (st === 'missing') {
        return { cls: 'bad', text: '节点未安装', retry: true, title: '把配套节点装进 ComfyUI 的 custom_nodes 目录。' }
      }
      if (st === 'unknown') return { cls: 'dim', text: '节点状态未知' }
      return null
    },
    /** 目录不对时才有值（正常状态界面一行都不多） */
    rootBad() {
      if (this.pickError) return this.pickError
      if (this.noInstTip) return this.noInstTip
      const r = this.rootCheck
      if (!r || !this.state.root || r.level === 'ok') return ''
      const h = (r.hints && r.hints[0]) || ''
      return r.message + (h ? ' ' + h : '')
    },
    hasIssue() {
      const c = this.comfy
      if (this.provError) return true
      if (!c) return false
      if (c.version && c.version.ok === false) return true
      if (c.nodeState === 'missing' || c.nodeState === 'restart') return true
      if (c.installDir && this.state.root && !c.sameDir) return true
      return !!this.rootBad
    },
    unknownCount() { return this.pending.filter(p => !p.sub).length },
    runnable() { return this.pending.length > 0 && this.pending.every(p => !!p.sub) },
    totalPendingBytes() { return this.pending.reduce((a, p) => a + (Number(p.size) || 0), 0) },
    etaText() {
      const p = this.progress
      if (!p || !p.speed || !p.totalBytes) return ''
      const left = Math.max(0, p.totalBytes - p.done)
      const s = left / p.speed
      if (!isFinite(s) || s <= 0) return ''
      return s >= 60 ? (Math.round(s / 60) + ' 分钟') : (Math.round(s) + ' 秒')
    }
  },
  mounted() {
    this.refresh().then(() => this.validateRoot())
    this.loadComfy().then(() => this.watchVer())
    // 进度是主进程推的（拷贝几十 GB，主进程全程知道字节数）
    this._off = window.studio.onModelImportProgress(o => this.onProgress(o))
  },
  beforeUnmount() {
    try { this._off && this._off() } catch (_) {}
    if (this._verTimer) clearTimeout(this._verTimer)
  },
  methods: {
    human(n) {
      if (!n) return '0 B'
      const u = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0, v = Number(n)
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
      return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
    },
    async refresh() {
      try { this.state = await window.studio.modelSlots() } catch (_) { /* 环境接口不可用时静默 */ }
    },
    /** ComfyUI 体检：它装在哪、版本多少、它现在认得哪些文件（全只读） */
    async loadComfy() {
      if (!window.studio.comfyDiagnose) return
      this.cfLoading = true
      try {
        this.comfy = await window.studio.comfyDiagnose()
      } catch (e) {
        this.comfy = { error: (e && e.message) || String(e) }
      } finally {
        this.cfLoading = false
      }
      this.syncInstanceTip()
      await this.maybeAutoProvision()
    },
    /** 「未创建实例」的引导：只在确实没有实例时占一行，建好后自动消失 */
    syncInstanceTip() {
      const c = this.comfy
      this.noInstTip = c && c.noInstance
        ? 'ComfyUI Desktop 还没有创建实例：打开它新建并启动一个实例，再回来点「选择 ComfyUI 安装目录…」。'
        : ''
    },
    /**
     * 自动补装：ComfyUI 正在跑、但当前实例没加载配套节点（典型场景：用户自己双击启动的）
     * → 补写一次 custom_nodes，徽标随后变「需重启 ComfyUI」，用户重启即生效。
     * 🔴 每会话只试一次：避免轮询里反复写盘。远程 endpoint（找不到本地启动器）不碰。
     */
    async maybeAutoProvision() {
      const c = this.comfy
      if (this._autoProv || this.provisioning) return
      if (!c || c.error || !c.running || c.noInstance) return
      if (c.installKind === 'unknown') return
      if (c.nodeState !== 'missing') return
      if (!c.nodes || !c.nodes.available) return
      this._autoProv = true
      await this.provisionNodes()
      await this.loadComfy()
    },
    n(a) { return Array.isArray(a) ? a.length : 0 },
    /**
     * 未启动 ComfyUI 时每 6 秒探一次：用户去点开 ComfyUI 后，
     * 版本行会自己变成真实版本，不用手动刷新。
     * 一旦检测到在运行就停止（关掉 ComfyUI 后重开设置页会重新开始）。
     */
    watchVer() {
      if (this._verTimer) { clearTimeout(this._verTimer); this._verTimer = null }
      if (this.comfy && this.comfy.running) return
      this._verTimer = setTimeout(async () => {
        this._verTimer = null
        if (document.hidden) { this.watchVer(); return }
        await this.loadComfy()
        this.watchVer()
      }, 6000)
    },
    /**
     * 用户唯一的动作：选 ComfyUI 安装目录。
     * 选完自动推它下面的 models；推不出来直接报错（不猜、不写一个勉强的路径）。
     */
    async chooseComfyDir() {
      if (!window.studio.chooseEngineDir) return
      this.picking = true
      try {
        const info = await window.studio.chooseEngineDir('comfyui')
        if (!info) return                                   // 用户取消
        const dir = (info && info.installDir) || ''
        if (!dir) { this.pickError = '没识别到 ComfyUI 安装目录，请重新选择。'; return }
        const r = await window.studio.resolveComfyModels(dir)
        if (!r || !r.ok) {
          await this.loadComfy()
          // 没建实例的用户，选哪个目录都推不出 models —— 这时说"重选目录"是错的方向
          if (this.comfy && this.comfy.noInstance) {
            this.pickError = '还没创建 ComfyUI 实例：打开 ComfyUI Desktop 新建并启动一个实例，再回来选一次目录。'
          } else {
            this.pickError = (r && r.reason) || '这个目录里没找到 models。'
          }
          this.$root.toast(this.pickError)
          return
        }
        await window.studio.setModelsRoot(r.modelsRoot)
        this.pickError = ''
        // 路径对了就顺手把配套节点装进去：这样用户之后自己双击 ComfyUI 启动也能命中，
        // 不必记住"必须由软件来拉起 ComfyUI"。
        await this.provisionNodes()
        await this.afterRootChange()
        this.$root.toast('已识别模型目录：' + r.modelsRoot)
      } catch (e) {
        this.$root.toast('设置失败：' + ((e && e.message) || e))
      } finally {
        this.picking = false
      }
    },
    /** 置备配套节点（幂等：内容一致就跳过，不重复写盘） */
    async provisionNodes() {
      if (!window.studio.provisionComfyNodes) return
      this.provisioning = true
      this.provError = ''
      try {
        const r = await window.studio.provisionComfyNodes()
        if (!r || !r.ok) {
          const t = (r && r.reason && r.reason.text) || (r && r.message) || '节点安装失败。'
          this.provError = t
          this.$root.toast(t)
          return
        }
        if (r.changed) {
          this.$root.toast('配套节点已装进 custom_nodes'
            + (this.comfy && this.comfy.running ? '，重启 ComfyUI 后生效' : '，启动 ComfyUI 时会自动加载'))
        }
      } catch (e) {
        this.provError = '节点安装失败：' + ((e && e.message) || e)
      } finally {
        this.provisioning = false
      }
    },
    /** 失败行上的重试：重装 + 重新体检（徽标跟着变） */
    async retryProvision() {
      await this.provisionNodes()
      await this.loadComfy()
    },
    /** 换完目录：重算槽位 + 校验 + 刷新体检 */
    async afterRootChange() {
      await this.refresh()
      await this.validateRoot()
      await this.loadComfy()
    },
    /** 校验当前模型目录：是不是 ComfyUI 真正读取的那个 models */
    async validateRoot() {
      if (!window.studio.validateModelsRoot) return
      try { this.rootCheck = await window.studio.validateModelsRoot(this.state.root || '') }
      catch (_) { this.rootCheck = null }
    },
    /** 版本太低时的「去下载」 */
    async openDownload() {
      try { await window.studio.openUrl('https://www.comfy.org/download') }
      catch (_) { /* 打不开就算了，不影响主流程 */ }
    },
    /** 批量导入：选一个文件夹递归扫描，程序自动分类，认不出的留在列表里等用户选 */
    async batchPick() {
      const paths = await window.studio.modelImportPick()
      if (!paths || !paths.length) return
      const scan = await window.studio.modelImportScan(paths)
      const add = [
        ...scan.items.map(f => ({ src: f.src, name: f.name, size: f.size, key: f.key, sub: f.sub })),
        ...scan.unknown.map(f => ({ src: f.src, name: f.name, size: f.size, key: '', sub: '' }))
      ]
      if (!add.length) { this.$root.toast('没扫到模型文件（.safetensors / .ckpt / .gguf）'); return }
      this.pending = [...this.pending, ...add]
      this.autoStartIfSure()
    },
    /** 全部认得出用途 → 不必多点一次「开始导入」 */
    autoStartIfSure() {
      if (this.runnable && !this.progress) this.startImport()
    },
    assign(i) {
      const p = this.pending[i]
      const s = (this.state.slots || []).find(x => x.key === p.key)
      p.sub = s ? s.sub : ''
    },
    async startImport() {
      if (!this.runnable) return
      const tasks = this.pending.map(p => ({ src: p.src, name: p.name, sub: p.sub, size: p.size }))
      this.pending = []
      this.result = null
      this.progress = { file: '', index: 0, total: tasks.length, done: 0, totalBytes: 0, percent: 0, speed: 0 }
      try {
        this.result = await window.studio.modelImportRun({ root: this.state.root, tasks })
      } catch (e) {
        this.$root.toast('导入失败：' + ((e && e.message) || e))
        this.result = null
      } finally {
        this.progress = null
        await this.refresh()
      }
    },
    cancel() { window.studio.modelImportCancel() },
    onProgress(o) {
      if (!o) return
      if (o.phase === 'start') {
        this.progress = { file: '', index: 0, total: o.total, done: 0, totalBytes: o.totalBytes || 0, percent: 0, speed: 0 }
        return
      }
      if (o.phase === 'done') { this.progress = null; return }
      if (!this.progress) return
      this.progress = {
        ...this.progress,
        file: o.file || this.progress.file,
        index: typeof o.index === 'number' ? o.index : this.progress.index,
        done: typeof o.done === 'number' ? o.done : this.progress.done,
        totalBytes: o.totalBytes || this.progress.totalBytes,
        speed: o.speed || this.progress.speed,
        percent: typeof o.percent === 'number' ? o.percent : this.progress.percent
      }
    }
  }
}
</script>
