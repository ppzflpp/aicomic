<template>
  <div class="pv">
    <!-- 标题行：项目 + 当前风格（三个轴各一句），右侧重读 -->
    <div class="pv-head">
      <span class="pv-title">提示词配置中心</span>
      <span class="pv-sub">{{ projName }}<template v-if="styleDesc"> · {{ styleDesc }}</template></span>
      <span style="flex:1"></span>
      <span class="pv-msg" v-if="msg">{{ msg }}</span>
      <button class="btn ghost sm" :disabled="busy" @click="reloadAll">重新读取</button>
    </div>

    <div class="pv-body">
      <!-- 左轨：四个分区 -->
      <nav class="pv-rail">
        <button v-for="g in groups" :key="g.id" class="pv-tab" :class="{ on: tab === g.id }"
                :title="g.tip" @click="tab = g.id">
          <b>{{ g.title }}</b>
          <i>{{ g.sub }}</i>
        </button>
      </nav>

      <section class="pv-pane">
        <!-- ============ ① 成品提示词 ============ -->
        <div class="pv-grid" v-if="tab === 'task'">
          <div class="pv-list">
            <div class="pv-list-h">用途（{{ tasks.length }}）</div>
            <div v-for="t in tasks" :key="t.id" class="pv-item" :class="{ on: taskId === t.id }"
                 @click="openTask(t.id)">
              <div class="pv-item-t">
                <span>{{ t.label }}</span>
                <span class="pv-badge warn" v-if="finals[t.id]">我的覆写</span>
              </div>
              <div class="pv-item-d">{{ t.desc }}</div>
            </div>
          </div>

          <div class="pv-main">
            <div class="pv-bar">
              <b>{{ curTask ? curTask.label : '' }}</b>
              <span class="pv-chain" v-if="pv">{{ pv.specs.join(' + ') }}</span>
              <span class="pv-badge ok" v-if="pv && !pv.overridden">自动合成</span>
              <span class="pv-badge warn" v-if="pv && pv.overridden">我的覆写</span>
              <span style="flex:1"></span>
              <button class="btn ghost sm" :disabled="busy" @click="openTask(taskId)">刷新</button>
              <button class="btn ghost sm" :disabled="!pvText" @click="copyText">复制</button>
              <button class="btn sm" v-if="pvEdit === null" :disabled="!pvText" @click="startEdit">编辑我的版本</button>
              <button class="btn sm" v-if="pvEdit !== null" :disabled="busy" @click="saveEdit">保存</button>
              <button class="btn ghost sm" v-if="pvEdit !== null" @click="pvEdit = null">取消</button>
              <button class="btn ghost sm" v-if="pvEdit === null && pv && pv.overridden"
                      :disabled="busy" @click="resetOverride">恢复默认</button>
            </div>

            <p class="pv-warn" v-if="pv && pv.overridden">
              ⚠ 这篇是<b>你手写的覆写</b>：它不再随「画风 / 世界 / 体裁」与模型方案变化。
              想让它跟着变，请点「恢复默认」回到自动合成，或改下面三个分区里的零件。
            </p>
            <p class="pv-warn" v-if="pv && pv.overridden && pv.forId && pv.forId !== videoProfileId">
              ⚠ 这份覆写是为「{{ pv.forId }}」写的，当前视频方案是「{{ videoProfileId || '（未知）' }}」——
              写法可能不匹配。
            </p>
            <p class="pv-warn" v-if="pv && pv.missing && pv.missing.length">
              ⚠ 缺少输出契约：{{ pv.missing.join(' / ') }} —— 这些字段名是程序解析返回值用的，缺了会生成失败。
            </p>
            <p class="pv-warn" v-if="pvEdit !== null">
              ⓘ 编辑中：这段文字将作为该用途的<b>完整提示词</b>原样下发（不再替换风格占位符、不再追加模型专属与风格说明）。
              里面若还有 <code>{{ ph }}</code> 形式的占位符，保存时会被提示。
            </p>
            <p class="pv-err" v-if="pv && pv.error">✕ {{ pv.error }}</p>

            <textarea class="pv-ta" v-if="pv" v-model="pvShown" :readonly="pvEdit === null"
                      spellcheck="false" :class="{ editing: pvEdit !== null }"></textarea>
            <div class="pv-empty" v-else-if="busy"><i class="spin"></i> 正在合成…</div>
          </div>
        </div>

        <!-- ============ ② 通用规范 ============ -->
        <div class="pv-grid" v-if="tab === 'spec'">
          <div class="pv-list">
            <div class="pv-list-h">通用规范（{{ specs.length }}）</div>
            <div v-for="f in specs" :key="f.name" class="pv-item" :class="{ on: specName === f.name }"
                 @click="openSpec(f)">
              <div class="pv-item-t"><span>{{ f.title || f.name }}</span></div>
              <div class="pv-item-d">{{ f.name }}</div>
            </div>
            <p class="pv-list-note">每份规范的正文就是发给大模型的那一段提示词。改完保存，下次生成即生效。</p>
          </div>

          <div class="pv-main">
            <div class="pv-bar">
              <b>{{ specTitle }}</b>
              <span class="pv-chain">{{ specName }}</span>
              <span style="flex:1"></span>
              <button class="btn ghost sm" :disabled="specBusy" @click="openSpec({ name: specName })">重读</button>
              <button class="btn sm" :disabled="specBusy || !specName" @click="saveSpec">保存</button>
              <button class="btn ghost sm" :disabled="specBusy || !specName" @click="resetSpec">恢复内置版</button>
            </div>
            <p class="pv-note">
              这一层是「零件」：它会被合成进上面 ① 的成品里。风格相关的词写成 <code>{{ ph }}</code>，
              会自动替换成当前项目风格对应的说法。
            </p>
            <textarea class="pv-ta" v-model="specText" :disabled="specBusy" spellcheck="false"></textarea>
          </div>
        </div>

        <!-- ============ ③ 模型专属规范 ============ -->
        <div class="pv-grid" v-if="tab === 'model'">
          <div class="pv-list">
            <div class="pv-list-h">模型专属规范（{{ models.length }}）</div>
            <div v-for="m in models" :key="m.name" class="pv-item" :class="{ on: modelName === m.name }"
                 @click="openModel(m)">
              <div class="pv-item-t">
                <span>{{ m.name }}</span>
                <span class="pv-badge warn" v-if="m.user">已改</span>
              </div>
              <div class="pv-item-d">{{ modelUsedBy(m.name) || '未被当前模型方案引用' }}</div>
            </div>
            <p class="pv-list-note">
              不同模型的提示词写法不一样（Z-Image 要中文逗号短语、SDXL 要英文标签…）。
              这些文件由「模型方案」声明追加到通用规范后面 —— 换生图模型，写法自动跟着换。
              你的修改存在本项目，只对当前项目生效。
            </p>
          </div>

          <div class="pv-main">
            <div class="pv-bar">
              <b>{{ modelName || '（未选择）' }}</b>
              <span class="pv-badge warn" v-if="isModelUser">你的覆盖</span>
              <span class="pv-badge ok" v-else-if="modelName">内置版</span>
              <span style="flex:1"></span>
              <button class="btn sm" :disabled="modelBusy || !modelName" @click="saveModel">保存</button>
              <button class="btn ghost sm" :disabled="modelBusy || !isModelUser" @click="clearModel">恢复内置版</button>
            </div>
            <p class="pv-note">保存 / 恢复后会自动让缓存作废，下次生成即生效。</p>
            <textarea class="pv-ta" v-model="modelText" :disabled="modelBusy" spellcheck="false"></textarea>
          </div>
        </div>

        <!-- ============ ④ 风格轴 ============ -->
        <div class="pv-grid" v-if="tab === 'style'">
          <div class="pv-list">
            <template v-for="g in styleGroups" :key="g.id">
              <div class="pv-list-h" v-if="g.items.length">{{ g.title }}</div>
              <div v-for="f in g.items" :key="f.rel" class="pv-item" :class="{ on: styleRel === f.rel }"
                   @click="openStyle(f)">
                <div class="pv-item-t">
                  <span>{{ f.label }}</span>
                  <span class="pv-badge warn" v-if="f.user">已改</span>
                </div>
                <div class="pv-item-d">{{ f.rel }}</div>
              </div>
            </template>
          </div>

          <div class="pv-main">
            <div class="pv-bar">
              <b>{{ styleRel || '（未选择）' }}</b>
              <span style="flex:1"></span>
              <button class="btn sm" :disabled="styleBusy || !styleRel" @click="saveStyle">保存</button>
              <button class="btn ghost sm" :disabled="styleBusy || !isStyleUser" @click="clearStyleFile">恢复内置版</button>
            </div>
            <p class="pv-note" v-if="styleMsg">{{ styleMsg }}</p>
            <p class="pv-note" v-else>
              这里管的是「词汇与调性」：世界（古装 / 现代…）给时代事实，画风（真人 / 二次元…）给画质感，
              体裁（剧集 / 广告）给结构要求，制作调性（电影感 / 商业广告大片 / 纪实…）给光影、调色与构图守则。
              改完保存，覆盖存在本项目里，只对当前项目生效。
            </p>
            <textarea class="pv-ta mono" v-model="styleText" :disabled="styleBusy" spellcheck="false"></textarea>

            <div class="pv-calc">
              <span class="pv-list-h">组合试算</span>
              <select v-model="styleTri.render"><option v-for="o in st.axisOptions('render')" :key="o.id" :value="o.id">{{ o.label }}</option></select>
              <select v-model="styleTri.world"><option v-for="o in st.axisOptions('world')" :key="o.id" :value="o.id">{{ o.label }}</option></select>
              <select v-model="styleTri.genre"><option v-for="o in st.axisOptions('genre')" :key="o.id" :value="o.id">{{ o.label }}</option></select>
              <select v-model="styleTri.tone"><option v-for="o in st.axisOptions('tone')" :key="o.id" :value="o.id">{{ o.label }}</option></select>
              <button class="btn ghost sm" @click="calcStyle">试算</button>
            </div>
            <pre class="pv-calc-out" v-if="stylePreview">{{ stylePreview }}</pre>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script>
import { TASKS, previewTask, finalList, saveTaskOverride, clearTaskOverride,
         clearPromptExtras, clearStylePack } from './prompts.js'
import { useProject } from './stores/project.js'

export default {
  name: 'PromptsView',
  data() {
    return {
      tab: 'task',
      busy: false,
      msg: '',
      // 模板里要显示「{{S.键名}}」这个字面量：不能直接写在模板里（Vue 会把内层的 }} 当成插值结束），
      // 所以放成数据字段再插值出来。
      ph: '{{S.键名}}',
      groups: [
        { id: 'task', title: '成品提示词', sub: '看 / 改这一篇', tip: '系统合成出来的完整提示词；也可以整段改成你自己的版本' },
        { id: 'spec', title: '通用规范', sub: '基规范 + 体裁变体', tip: '所有风格共用的规则与格式；带体裁后缀的那几份只在该体裁的项目里出现' },
        { id: 'model', title: '模型专属规范', sub: '按模型写法', tip: '不同图片 / 视频模型的写法差异' },
        { id: 'style', title: '风格轴', sub: '画风·世界·体裁', tip: '题材词汇：世界给事实、画风给质感、体裁给结构' }
      ],
      tasks: TASKS,
      taskId: 'adapt',
      pv: null,
      pvEdit: null,
      finals: {},
      specs: [],
      specName: '',
      specText: '',
      specBusy: false,
      models: [],
      modelName: '',
      modelText: '',
      modelBusy: false,
      styleFiles: [],
      styleRel: '',
      styleText: '',
      styleBusy: false,
      styleMsg: '',
      stylePreview: '',
      styleTri: { render: '', world: '', genre: '', tone: '' }
    }
  },
  computed: {
    st() { return useProject() },
    pid() { const t = this.st.promptTarget; return (t && t.projectId) || null },
    projName() {
      const p = (this.st.tree || []).find(x => x.id === this.pid)
      return p ? p.name : '（未选择项目）'
    },
    /** 当前项目风格的四个轴各一句（标题行小字）+ 等于哪个预置 */
    styleDesc() {
      const p = (this.st.tree || []).find(x => x.id === this.pid)
      const id = (p && p.res && p.res.style) || ''
      if (!id) return ''
      const tri = this.st.parseTriple(id)
      const L = (ax) => {
        const o = this.st.axisOptions(ax).find(x => x.id === tri[ax]) || {}
        return o.label || tri[ax]
      }
      const pre = this.st.presetNameOf(tri)
      return L('render') + ' · ' + L('world') + ' · ' + L('genre') + ' · ' + L('tone') + (pre ? '（= ' + pre + '）' : '')
    },
    curTask() { return TASKS.find(t => t.id === this.taskId) || null },
    pvText() { return (this.pv && this.pv.text) || '' },
    /** 展示/编辑共用同一个 textarea：编辑模式显示编辑缓冲，否则显示合成结果 */
    pvShown: {
      get() { return this.pvEdit !== null ? this.pvEdit : this.pvText },
      set(v) { if (this.pvEdit !== null) this.pvEdit = v }
    },
    specTitle() {
      const f = this.specs.find(x => x.name === this.specName)
      return (f && (f.title || f.name)) || this.specName || '（未选择）'
    },
    isModelUser() {
      const m = this.models.find(x => x.name === this.modelName)
      return !!(m && m.user)
    },
    isStyleUser() {
      const f = this.styleFiles.find(x => x.rel === this.styleRel)
      return !!(f && f.user)
    },
    videoProfileId() {
      const vf = (this.st.promptFiles && this.st.promptFiles.video) || {}
      return vf.base ? String(vf.base).replace(/\.md$/i, '') : ''
    },
    styleGroups() {
      const pick = (g) => this.styleFiles.filter(f => f.group === g)
      return [
        { id: 'base', title: '兜底变量表', items: pick('base') },
        { id: 'render', title: '画面风格', items: pick('render') },
        { id: 'world', title: '世界设定', items: pick('world') },
        { id: 'genre', title: '内容体裁', items: pick('genre') },
        { id: 'tone', title: '制作调性', items: pick('tone') },
        { id: 'preset', title: '预置组合', items: pick('preset') },
        { id: 'legacy', title: '其他（老版风格包）', items: pick('legacy') }
      ]
    }
  },
  watch: {
    tab() { this.ensureTab() }
  },
  async mounted() {
    await this.st.refresh()
    await this.ensureTab()
  },
  methods: {
    flash(t) { this.msg = t; clearTimeout(this._mt); this._mt = setTimeout(() => { this.msg = '' }, 2600) },
    /** 切分区时惰性加载该分区数据（只拉一次；「重新读取」会强制重拉） */
    async ensureTab(force) {
      if (this.tab === 'task') await this.loadTasks(force)
      else if (this.tab === 'spec') await this.loadSpecs(force)
      else if (this.tab === 'model') await this.loadModels(force)
      else if (this.tab === 'style') await this.loadStyleFiles(force)
    },
    async reloadAll() {
      this.busy = true
      try { await this.ensureTab(true); this.flash('已重新读取') }
      finally { this.busy = false }
    },

    /* ---- ① 成品提示词 ---- */
    async loadTasks() {
      this.busy = true
      try {
        this.finals = (await finalList(this.pid)) || {}
        await this.loadOne(this.taskId)
      } finally { this.busy = false }
    },
    async loadOne(id) {
      this.pv = null
      this.pvEdit = null
      this.pv = await previewTask(id, this.pid)
    },
    async openTask(id) {
      this.taskId = id
      this.busy = true
      try { await this.loadOne(id) } finally { this.busy = false }
    },
    startEdit() { this.pvEdit = this.pvText },
    async saveEdit() {
      if (this.pvEdit === null) return
      const txt = String(this.pvEdit)
      const left = (txt.match(/\{\{\s*S\.[A-Za-z0-9_]+\s*\}\}/g) || [])
      if (left.length) {
        const ok = window.confirm('这段文字里还有没被替换的风格占位符：\n' + left.slice(0, 5).join('、') +
          (left.length > 5 ? ' 等 ' + left.length + ' 个' : '') +
          '\n\n覆写是原样下发的，这些占位符不会被替换。确定保存吗？')
        if (!ok) return
      }
      this.busy = true
      try {
        await saveTaskOverride(this.taskId, txt, this.overrideFor(), this.pid)
        this.finals = (await finalList(this.pid)) || {}
        await this.loadOne(this.taskId)
        this.flash('已保存你的版本 —— 该用途之后都用这一篇')
      } catch (e) { this.flash('保存失败：' + ((e && e.message) || e)) }
      finally { this.busy = false }
    },
    /** 覆写要记「为哪个视频方案写的」（视频侧 H3 与 LTX 写法不同，换了方案还在用就串味） */
    overrideFor() {
      if (this.taskId !== 'video-base' && this.taskId !== 'video-ref') return ''
      const vf = (this.st.promptFiles && this.st.promptFiles.video) || {}
      return vf.base ? String(vf.base).replace(/\.md$/i, '') : ''
    },
    async resetOverride() {
      if (!window.confirm('删掉这份覆写、回到自动合成？（画风 / 模型变化会重新影响这一篇）')) return
      this.busy = true
      try {
        await clearTaskOverride(this.taskId, this.pid)
        this.finals = (await finalList(this.pid)) || {}
        await this.loadOne(this.taskId)
        this.flash('已恢复自动合成')
      } catch (e) { this.flash('恢复失败：' + ((e && e.message) || e)) }
      finally { this.busy = false }
    },
    async copyText() {
      try { await navigator.clipboard.writeText(this.pvText); this.flash('已复制到剪贴板') }
      catch (_) { this.flash('复制失败，请手动全选') }
    },

    /* ---- ② 通用规范 ---- */
    async loadSpecs() {
      const ws = this.st.workspace
      try { this.specs = (await window.studio.promptsList(ws, this.pid)) || [] } catch (_) { this.specs = [] }
      if (!this.specName) this.specName = (this.specs[0] || {}).name || ''
      if (this.specName) await this.openSpec({ name: this.specName })
    },
    async openSpec(f) {
      if (!f || !f.name) return
      this.specName = f.name
      this.specBusy = true
      try {
        this.specText = (await window.studio.readPrompt(this.st.workspace, this.pid, f.name)) || ''
      } catch (e) { this.flash('读取失败：' + ((e && e.message) || e)) }
      finally { this.specBusy = false }
    },
    async saveSpec() {
      this.specBusy = true
      try {
        await window.studio.savePrompt(this.st.workspace, this.pid, this.specName, this.specText)
        this.flash('已保存 —— 下次生成即生效')
      } catch (e) { this.flash('保存失败：' + ((e && e.message) || e)) }
      finally { this.specBusy = false }
    },
    async resetSpec() {
      if (!window.confirm('恢复「' + this.specTitle + '」的内置版本？你在这一份上的修改会丢失。')) return
      this.specBusy = true
      try {
        await window.studio.promptReset(this.st.workspace, this.pid, this.specName)
        await this.openSpec({ name: this.specName })
        this.flash('已恢复内置版')
      } catch (e) { this.flash('恢复失败：' + ((e && e.message) || e)) }
      finally { this.specBusy = false }
    },

    /* ---- ③ 模型专属规范 ---- */
    async loadModels() {
      try { this.models = (await window.studio.profilePromptList(this.st.workspace, this.pid)) || [] } catch (_) { this.models = [] }
      if (!this.modelName) this.modelName = (this.models[0] || {}).name || ''
      if (this.modelName) await this.openModel({ name: this.modelName })
    },
    async openModel(m) {
      if (!m || !m.name) return
      this.modelName = m.name
      this.modelBusy = true
      try { this.modelText = (await window.studio.profilePromptRead(m.name, this.st.workspace, this.pid)) || '' }
      catch (e) { this.flash('读取失败：' + ((e && e.message) || e)) }
      finally { this.modelBusy = false }
    },
    async saveModel() {
      this.modelBusy = true
      try {
        await window.studio.profilePromptSave(this.modelName, this.modelText, this.st.workspace, this.pid)
        // 🔴 那份正文是**缓存**着用的（promptExtras），不清就「改了没生效」
        clearPromptExtras()
        this.models = (await window.studio.profilePromptList(this.st.workspace, this.pid)) || []
        this.flash('已保存到本项目 —— 下次生成即生效')
      } catch (e) { this.flash('保存失败：' + ((e && e.message) || e)) }
      finally { this.modelBusy = false }
    },
    async clearModel() {
      if (!window.confirm('恢复内置版？你在本项目里对这份规范做的修改会丢失。')) return
      this.modelBusy = true
      try {
        await window.studio.profilePromptClear(this.modelName, this.st.workspace, this.pid)
        clearPromptExtras()
        this.models = (await window.studio.profilePromptList(this.st.workspace, this.pid)) || []
        await this.openModel({ name: this.modelName })
        this.flash('已恢复内置版')
      } catch (e) { this.flash('恢复失败：' + ((e && e.message) || e)) }
      finally { this.modelBusy = false }
    },
    /** 这份模型规范被哪些方案追加到哪份通用规范后面（一眼看出它是不是死文件） */
    modelUsedBy(name) {
      const base = String(name || '').replace(/\.md$/i, '')
      const map = this.st.promptExtraFiles || {}
      const hits = []
      for (const kind of ['image', 'video']) {
        const vi = map[kind] || {}
        for (const spec of Object.keys(vi)) {
          if ((vi[spec] || []).some(f => String(f).replace(/\.md$/i, '') === base)) {
            hits.push((kind === 'image' ? '生图' : '视频') + ' · 追加在 ' + spec + ' 后')
          }
        }
      }
      return hits.join('；')
    },

    /* ---- ④ 风格轴 ---- */
    async loadStyleFiles() {
      try { this.styleFiles = (await window.studio.styleFiles(this.st.workspace, this.pid)) || [] } catch (_) { this.styleFiles = [] }
      if (!this.styleRel) this.styleRel = (this.styleFiles[0] || {}).rel || ''
      if (this.styleRel) await this.openStyle({ rel: this.styleRel })
      if (!this.styleTri.render) {
        const d = this.st.defaultAxes()
        this.styleTri = { render: d.render, world: d.world, genre: d.genre, tone: d.tone }
      }
    },
    async openStyle(f) {
      if (!f || !f.rel) return
      this.styleRel = f.rel
      this.styleBusy = true
      this.styleMsg = ''
      try { this.styleText = (await window.studio.styleFileRead(f.rel, this.st.workspace, this.pid)) || '' }
      catch (e) { this.flash('读取失败：' + ((e && e.message) || e)) }
      finally { this.styleBusy = false }
    },
    async saveStyle() {
      this.styleBusy = true
      this.styleMsg = ''
      try {
        await window.studio.styleFileSave(this.styleRel, this.styleText, this.st.workspace, this.pid)
        clearStylePack()                       // 渲染层的风格包缓存作废
        await this.st.loadResOptions()         // 四轴清单 / 问题黄条重新拉
        this.styleFiles = (await window.studio.styleFiles(this.st.workspace, this.pid)) || []
        this.styleMsg = '已保存到本项目 —— 已生效（若刚把某个轴值删掉，项目配置里的下拉会立刻反映出来）'
      } catch (e) { this.styleMsg = '保存失败：' + ((e && e.message) || e) }
      finally { this.styleBusy = false }
    },
    async clearStyleFile() {
      if (!window.confirm('恢复内置版？你在本项目里对这份文件的修改会丢失。')) return
      this.styleBusy = true
      this.styleMsg = ''
      try {
        await window.studio.styleFileClear(this.styleRel, this.st.workspace, this.pid)
        clearStylePack()
        await this.st.loadResOptions()
        this.styleFiles = (await window.studio.styleFiles(this.st.workspace, this.pid)) || []
        await this.openStyle({ rel: this.styleRel })
        this.styleMsg = '已恢复内置版'
      } catch (e) { this.styleMsg = '恢复失败：' + ((e && e.message) || e) }
      finally { this.styleBusy = false }
    },
    /** 组合试算：拿当前四轴去合成一次，看几个关键变量落成什么（改轴文件后立刻能验证） */
    async calcStyle() {
      const tri = [this.styleTri.render, this.styleTri.world, this.styleTri.genre, this.styleTri.tone].join(':')
      try {
        const p = await window.studio.styleGet(tri, this.st.workspace, this.pid)
        if (!p) { this.stylePreview = '（取不到这个组合）'; return }
        const v = p.vars || {}
        const warn = [].concat(p.warnings || [])
        this.stylePreview = '组合：' + tri + '\n' +
          '名称：' + (p.name || '') + '\n' +
          '定调：' + (v.styleCore || '') + '\n' +
          '人物起手：' + (v.startChar || '') + '\n' +
          '场景起手：' + (v.startScene || '') + '\n' +
          '空镜句：  ' + (v.keeper || '') + '\n' +
          '光影：  ' + (v.lightAdd || '') + '\n' +
          '调色：  ' + (v.colorGrade || '') + '\n' +
          '器材禁写：' + (v.equipStrip || '') + '\n' +
          '反风格词：' + (v.antiStyleWords || '') +
          (warn.length ? '\n\n⚠ ' + warn.join('\n⚠ ') : '')
      } catch (e) { this.stylePreview = '试算失败：' + ((e && e.message) || e) }
    }
  }
}
</script>
