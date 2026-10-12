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
      profileErrs: []
    }
  },
  computed: {
    st() { return useProjectStore() }
  },
  async mounted() {
    await this.st.refreshEnv()
    await this.loadProfiles()
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
    async chooseWs() {
      const ws = await window.studio.chooseWorkspace()
      if (ws) { this.st.workspace = ws; await this.st.refresh(); await this.st.refreshEnv() }
    }
  }
}
</script>
