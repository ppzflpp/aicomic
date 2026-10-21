<template>
  <div class="settings">
    <h2>设置</h2>

    <!-- 工作区 -->
    <div class="set-card">
      <h3>工作区</h3>
      <div class="set-row">
        <input type="text" :value="st.workspace" readonly />
        <button class="btn ghost" @click="chooseWs">更改…</button>
      </div>
    </div>

    <!-- 视频生成质量已移到「新建项目 / 项目配置」弹窗（项目级设置），此处不再重复 -->

    <!-- 模型管家：从别处把模型拷进模型根目录的正确子目录（自动分类 + 进度条）。
         放在最前面——新手第一件事就是把模型放对地方，之后再管引擎与服务。 -->
    <model-manager />

    <!-- 生成模型方案：换生图 / 生视频模型时，只需在工作区 profiles\ 放一份配置 JSON，
         在这里选中即可 —— 工作流模板、要哪些模型文件、节点接线、帧参数、档位表、
         以及模型专属的提示词规范，全部跟着这份配置走，代码一行都不用改。 -->
    <div class="set-card">
      <div class="set-head">
        <h3>生成模型方案</h3>
        <button class="btn ghost sm" @click="reloadProfiles">重新扫描</button>
      </div>

      <div class="env-row">
        <span class="env-name">生图模型</span>
        <select v-model="imgProfile" @change="applyProfile('image')">
          <option v-for="o in imgOptions" :key="o.id" :value="o.id">
            {{ o.label }}{{ o.source === 'user' ? '（自定义）' : '' }}
          </option>
        </select>
      </div>

      <div class="env-row">
        <span class="env-name">视频模型</span>
        <select v-model="vidProfile" @change="applyProfile('video')">
          <option v-for="o in vidOptions" :key="o.id" :value="o.id">
            {{ o.label }}{{ o.source === 'user' ? '（自定义）' : '' }}
          </option>
        </select>
      </div>

      <div v-if="profileErrs.length" style="margin-top:8px; padding:8px 10px; border-radius:6px; background:rgba(200,120,0,.12); border:1px solid rgba(200,120,0,.35); font-size:12px; line-height:1.7">
        <b>⚠ 有 {{ profileErrs.length }} 份自定义方案没读进来，已回退用内置版：</b>
        <div v-for="(e, i) in profileErrs" :key="i">{{ e.id ? e.id + '：' : '' }}{{ e.message }}<span style="opacity:.6">（{{ e.file }}）</span></div>
      </div>

      <div style="margin-top:8px; font-size:12px; opacity:.7; line-height:1.7">
        换模型不用改代码：把 ComfyUI 导出的 API 工作流 JSON 放进 <code>工作区\workflows\</code>，
        再复制 <code>工作区\profiles\</code> 里的一份配置照着改，回来点「重新扫描」即可。
        模型文件按配置里的文件名特征自动找，缺了会在下面「模型管家」里提示。
      </div>
    </div>

    <!-- 引擎与显存：页面上只留「按阶段自动启停」这一件事。
         服务地址 / 健康状态灯 / 引擎启动参数一律走默认值；llama.cpp 与 ffmpeg
         随软件内置（软件目录下的 tools\），用户不需要指定任何路径。 -->
    <div class="set-card">
      <div class="set-head">
        <h3>引擎与显存</h3>
        <button class="btn ghost sm" @click="recheck">重新检测</button>
      </div>

      <div class="env-group">阶段引擎编排</div>
      <div class="env-row">
        <span class="env-name">按阶段自动启停引擎</span>
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; cursor:pointer">
          <input type="checkbox" v-model="autoOrch" @change="saveAutoOrch" />
        </label>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="releaseNow">立即释放显存</button>
      </div>

    </div>

    <!-- 大模型来源（本地 / 云端）：决定每个环节的文字由谁来写。
         默认全部走本地（随软件内置的模型，不联网、不花钱）；想更快更稳就按环节切成云端。
         🔴 这里是**唯一入口**（2026-10-19 起功能区的临时开关已撤）：改了就长期生效。
         切换粒度 = 环节，与 LLM 调用点一一对应（见 electron/llmProvider.cjs）。 -->
    <div class="set-card">
      <div class="set-head">
        <h3>大模型来源</h3>
        <button class="btn ghost sm" :disabled="llmBusy" @click="testCloud">测试云端连接</button>
      </div>

      <div style="font-size:12px; opacity:.72; line-height:1.75; margin-bottom:8px">
        软件里的文字活儿（改编、分镜、角色档案、提示词）默认由随软件内置的本地模型来做：不联网、不额外花钱。
        如果想让某个环节更快、更稳（尤其是长剧本、要求严格格式时），把它单独切成「云端」就行 ——
        云端按量计费，费用在你的账号里结算，需要一个 API Key。
      </div>

      <div class="env-group">云端账号</div>
      <div class="env-row">
        <span class="env-name">服务地址</span>
        <input type="text" v-model="cloudBase" @change="saveCloud" placeholder="https://api.deepseek.com" />
      </div>
      <div class="env-row">
        <span class="env-name">模型名</span>
        <input type="text" v-model="cloudModel" @change="saveCloud" placeholder="deepseek-flash" />
      </div>
      <div class="env-row">
        <span class="env-name">API Key</span>
        <!-- 密钥框（2026-10-15 改版）：锁图标 + 输入 + 「已保存」徽标 + 显示/隐藏 + 清除，都收在一个盒子里。
             ⚠️ 全局表单规则只覆盖 text/number/search 与「没写 type」的 input，password 不在其中 →
             旧版密钥框其实是浏览器默认的**白底**样式。这里自带深色样式（.key-box 见 style.css）。 -->
        <div class="key-box" :class="{ ok: cloudHasKey }">
          <span class="key-lock" title="密钥经系统加密后存在本机，接口不会回显明文">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="10.5" width="16" height="10" rx="2.2" />
              <path d="M8 10.5V7.3a4 4 0 0 1 8 0v3.2" />
            </svg>
          </span>
          <input class="key-in" :type="keyShow ? 'text' : 'password'" v-model="cloudKeyIn"
                 @change="saveCloud" :placeholder="keyPh" autocomplete="off" spellcheck="false" />
          <span v-if="cloudHasKey && !cloudKeyIn" class="key-flag">已保存</span>
          <button type="button" class="key-eye" :title="keyShow ? '隐藏' : '显示'"
                  @click="keyShow = !keyShow">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.2 12S6 5.6 12 5.6 21.8 12 21.8 12 18 18.4 12 18.4 2.2 12 2.2 12z" />
              <circle cx="12" cy="12" r="2.7" />
              <line v-if="keyShow" x1="4" y1="20" x2="20" y2="4" />
            </svg>
          </button>
          <button v-if="cloudHasKey" type="button" class="key-x" title="清除已保存的密钥"
                  @click="clearKey">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                 stroke-width="1.9" stroke-linecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <!-- 密钥读不出来的兜底提示（2026-10-15 实测发现）：safeStorage 的密钥与当前安装绑定，
           换版本 / 重装 / 清过系统数据后旧密文就解不开了 —— 必须让用户知道「重填一次」 -->
      <div v-if="cloudKeyBroken"
           style="margin-top:8px; padding:8px 10px; border-radius:6px; background:rgba(226,75,74,.14); border:1px solid rgba(226,75,74,.4); font-size:12px; line-height:1.7">
        ⚠ 之前保存的 API Key 现在读不出来了（换过安装版本 / 重装过软件 / 清理过系统数据都会这样）。
        请把 Key 重新粘贴一次，填好点「测试云端连接」确认能通。
      </div>
      <div v-if="llmTestMsg" style="margin-top:8px; padding:7px 10px; border-radius:6px; font-size:12px; line-height:1.7"
           :style="llmTestOk
             ? 'background:rgba(34,197,94,.12); border:1px solid rgba(34,197,94,.35)'
             : 'background:rgba(200,120,0,.14); border:1px solid rgba(200,120,0,.4)'">
        {{ llmTestOk ? '✓ ' : '✕ ' }}{{ llmTestMsg }}
      </div>

      <!-- 环节开关（2026-10-19 改版）：勾选框 → 「云端生成」开关（Dragon 要求与功能区那个小开关同一套 UI）。
           打开 = 这个环节走云端；关闭 = 走本地内置模型（默认）。开关态**不做 v-model 回写**，
           每次渲染重新读 llmStages（主进程是真源），这样保存失败回滚也能立刻反映到开关上。 -->
      <div class="env-group">各环节用哪个</div>
      <div style="font-size:12px; opacity:.66; margin:-2px 0 8px; line-height:1.7">
        打开「云端生成」就走上面填的云端账号；<b>关闭的一律走本地内置模型</b>（默认，不联网）。
      </div>
      <div class="env-row" v-for="s in stageMeta" :key="s.id">
        <span class="env-name">{{ s.label }}</span>
        <label class="llm-sw" :class="{ on: llmStages[s.id] === 'cloud', dis: llmBusy }">
          <!-- ⚠️ 元素级 :key 必须跟着「真源的状态」走：用户点一下会先改 DOM，
               若这次落库失败，llmStages 会回滚成原值，而 props 没变化时 Vue 不会 patch
               回 :checked → 开关就停在用户点出来的错误状态了。key 一变即重建元素，
               DOM 强制与主进程的真源对齐。 -->
          <input class="ls-box" type="checkbox" :checked="llmStages[s.id] === 'cloud'" :key="'st:' + (llmStages[s.id] || 'local')" :disabled="llmBusy"
                 @change="setStage(s.id, $event.target.checked ? 'cloud' : 'local')" />
          <span class="sw-txt">云端生成</span>
          <span class="sw-track" aria-hidden="true"><span class="sw-knob"></span></span>
        </label>
        <span class="llm-ck-hint">{{ llmStages[s.id] === 'cloud' ? '用上面的云端账号' : '本地内置模型（不联网）' }}</span>
      </div>

      <div v-if="cloudStages.length && !cloudHasKey"
           style="margin-top:8px; padding:8px 10px; border-radius:6px; background:rgba(200,120,0,.14); border:1px solid rgba(200,120,0,.4); font-size:12px; line-height:1.7">
        ⚠ 「{{ cloudStageNames }}」已经选了云端，但还没填 API Key —— 这些环节在生成时不会偷偷改走本地，
        而是直接停下并提示原因。填好 Key 再点一次「测试云端连接」确认能通。
      </div>

      <div style="margin-top:8px; font-size:12px; opacity:.7; line-height:1.75">
        云端不通时不会自动退回本地（免得「这份稿子到底是哪个模型写的」说不清楚），
        会报错停在原地。各阶段页右上角还有一个临时开关，只对本次打开有效，重启后回到这里的默认。
      </div>
    </div>

  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { clearPromptExtras } from './prompts.js'
import ModelManager from './ModelManager.vue'

export default {
  name: 'SettingsPanel',
  components: { ModelManager },
  data() {
    return {
      autoOrch: true,
      // 生成模型方案（profile）：下拉候选项 + 当前选中 + 读不进来的自定义配置
      imgOptions: [],
      vidOptions: [],
      imgProfile: '',
      vidProfile: '',
      profileErrs: [],
      // 大模型来源（本地 / 云端）：设置页是唯一持久入口
      llmStages: {},        // { adapt|shots|chars|library|prompt|split: 'local'|'cloud' }
      stageMeta: [],        // [{ id, label }] —— 展示顺序来自主进程，与调用点一一对应
      cloudBase: '',        // 云端服务地址（默认 https://api.deepseek.com）
      cloudModel: '',       // 云端模型名（默认 deepseek-flash）
      cloudKeyIn: '',       // 用户**本次输入**的 Key（不回显已存的那个）
      cloudHasKey: false,   // 库里存的 Key **能解开且非空**（解不开不算，见 cloudKeyBroken）
      cloudKeyBroken: false,// 库里有密文但读不出来（换版本 / 重装 / 清过系统数据）→ 提示重填
      keyMask: '',          // 已存 Key 的掩码（前 6 后 4），只用来做 placeholder
      keyShow: false,       // 密钥框「显示/隐藏」开关（纯展示，与落库无关）
      llmBusy: false,
      llmTestMsg: '',
      llmTestOk: false
    }
  },
  computed: {
    st() { return useProjectStore() },
    /** 已选云端的环节 id 列表 */
    cloudStages() { return this.stageMeta.filter(s => this.llmStages[s.id] === 'cloud').map(s => s.id) },
    /** 同上，换成中文名（提示条里用） */
    cloudStageNames() { return this.stageMeta.filter(s => this.llmStages[s.id] === 'cloud').map(s => s.label).join('、') },
    /** 密钥框的 placeholder：已存则只显示掩码（「已保存」由绿色徽标承担，框里不必再啰嗦一遍） */
    keyPh() {
      if (!this.cloudHasKey) return '粘贴你的 API Key'
      return (this.keyMask || '••••••••') + ' · 留空不改'
    }
  },
  async mounted() {
    await this.st.refreshEnv()
    await this.loadProfiles()
    await this.loadLlm()
    try { this.autoOrch = await window.studio.getAutoOrchestrate() } catch (_) {}
  },
  methods: {
    /* ---- 生成模型方案（profile）---- */
    async loadProfiles() {
      try {
        const [a, b] = await Promise.all([
          window.studio.profileList('image'),
          window.studio.profileList('video')
        ])
        this.imgOptions = (a && a.items) || []
        this.vidOptions = (b && b.items) || []
        this.profileErrs = [...((a && a.errors) || []), ...((b && b.errors) || [])]
        const ai = this.imgOptions.find(o => o.active)
        const av = this.vidOptions.find(o => o.active)
        this.imgProfile = ai ? ai.id : (this.imgOptions[0] ? this.imgOptions[0].id : '')
        this.vidProfile = av ? av.id : (this.vidOptions[0] ? this.vidOptions[0].id : '')
      } catch (_) { /* 拿不到就保持空下拉，不影响其它设置项 */ }
    },
    async applyProfile(kind) {
      const id = kind === 'image' ? this.imgProfile : this.vidProfile
      if (!id) return
      try {
        await window.studio.profileSet(kind, id)
        clearPromptExtras()          // 方案变了 → 专属提示词规范要重新取
        await this.st.refreshEnv()
        await this.loadProfiles()
        const label = ((kind === 'image' ? this.imgOptions : this.vidOptions).find(o => o.id === id) || {}).label || id
        this.$root.toast('已切换到：' + label)
      } catch (e) { this.st.fail(e); await this.loadProfiles() }
    },
    async reloadProfiles() {
      try { await window.studio.profileReload() } catch (_) {}
      clearPromptExtras()
      await this.loadProfiles()
      await this.st.refreshEnv()
      this.$root.toast('已重新扫描模型方案')
    },
    /* ---- 阶段引擎编排 ---- */
    async saveAutoOrch() {
      const on = await window.studio.setAutoOrchestrate(this.autoOrch)
      this.autoOrch = !!on
      this.$root.toast(on ? '已开启按阶段自动启停引擎' : '已关闭自动编排（需手动启停引擎）')
    },
    async releaseNow() {
      await window.studio.releaseEngines()
      this.$root.toast('已请求释放显存（停 llama + 卸载 ComfyUI 模型），详情见运行日志')
      await this.st.refreshEnv()
    },
    /* ---- 引擎状态：llama.cpp 与 ffmpeg 都随软件内置（tools\），这里只刷健康状态 ---- */
    async recheck() { await this.st.refreshEnv() },

    /* ---- 大模型来源（本地 / 云端）----
       前端只在「用户主动改」时才落库；拉取回来的配置一律经 applyCfg 覆盖本地态。
       密钥永远不回传明文（后端只给 hasKey + 掩码），所以输入框始终是空的。 */
    /** 把后端配置铺到界面态 */
    applyCfg(cfg) {
      const c = cfg || {}
      this.llmStages = c.stages || {}
      this.stageMeta = c.stagesMeta || []
      this.cloudBase = (c.cloud && c.cloud.baseUrl) || ''
      this.cloudModel = (c.cloud && c.cloud.model) || ''
      this.cloudHasKey = !!(c.cloud && c.cloud.hasKey)
      this.cloudKeyBroken = !!(c.cloud && c.cloud.keyBroken)
      this.keyMask = (c.cloud && c.cloud.keyMask) || ''
      this.cloudKeyIn = ''            // 不清空会把刚输入的明文一直挂在输入框里
    },
    async loadLlm() {
      try { this.applyCfg(await window.studio.llmConfig()) } catch (_) { /* 拿不到就保持空态 */ }
    },
    /** 保存服务地址 / 模型名；密钥只在用户真输了新值时才提交（留空 = 不改） */
    async saveCloud() {
      const patch = { baseUrl: this.cloudBase, model: this.cloudModel }
      if (this.cloudKeyIn) patch.apiKey = this.cloudKeyIn
      this.llmBusy = true
      try {
        this.applyCfg(await window.studio.setLlmCloud(patch))
        this.llmTestMsg = ''          // 账号改了 → 上次的连通结论作废
        this.$root.toast('已保存云端配置')
      } catch (e) { this.st.fail(e); await this.loadLlm() } finally { this.llmBusy = false }
    },
    async clearKey() {
      this.llmBusy = true
      try {
        this.applyCfg(await window.studio.setLlmCloud({ apiKey: '' }))
        this.llmTestMsg = ''
        this.$root.toast('已清除云端 API Key')
      } catch (e) { this.st.fail(e) } finally { this.llmBusy = false }
    },
    async setStage(id, provider) {
      this.llmBusy = true
      try {
        this.applyCfg(await window.studio.setLlmStage(id, provider))
        const lb = (this.stageMeta.find(s => s.id === id) || {}).label || id
        this.$root.toast('「' + lb + '」已设为' + (provider === 'cloud' ? '云端' : '本地'))
      } catch (e) { this.st.fail(e); await this.loadLlm() } finally { this.llmBusy = false }
    },
    async testCloud() {
      this.llmBusy = true
      this.llmTestMsg = '正在连接…'
      this.llmTestOk = false
      try {
        const r = await window.studio.testLlm()
        this.llmTestOk = !!(r && r.ok)
        this.llmTestMsg = (r && r.message) || '没有返回结果'
      } catch (e) {
        this.llmTestOk = false
        this.llmTestMsg = '测试失败：' + ((e && e.message) || e)
      } finally { this.llmBusy = false }
    },

    async chooseWs() {
      const ws = await window.studio.chooseWorkspace()
      if (ws) { this.st.workspace = ws; await this.st.refresh(); await this.st.refreshEnv() }
    }
  }
}
</script>
