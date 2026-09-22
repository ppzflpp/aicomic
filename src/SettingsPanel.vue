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
      <p class="hint">项目、剧集、角色资源库、工作流模板都在工作区下（模型不在这里 —— 模型与 ComfyUI 共用，见下方「模型目录」）。</p>
    </div>

    <!-- 环境检测 -->
    <div class="set-card">
      <div class="set-head">
        <h3>环境检测</h3>
        <button class="btn ghost sm" @click="recheck">重新检测</button>
      </div>

      <!-- 推理服务 -->
      <div class="env-group">推理服务</div>
      <div class="env-row" v-for="k in ['llm','comfyui']" :key="k">
        <span class="env-name">{{ k==='llm' ? 'LLM（llama-server）' : 'ComfyUI' }}</span>
        <span :class="h(k)?'model-ok':'model-no'">{{ h(k)?'已连接':'未连接' }}</span>
        <input type="text" v-model="ep[k]" placeholder="http://127.0.0.1:8080" style="flex:1" />
        <button class="btn ghost sm" @click="saveEndpoint(k)">保存</button>
      </div>
      <div class="env-row">
        <span class="env-name">ffmpeg</span>
        <span :class="health.ffmpeg?'model-ok':'model-no'">{{ health.ffmpeg?'已就绪':'未找到' }}</span>
        <input type="text" v-model="ffmpegPath" placeholder="留空则依次查找 workspace/tools 与 PATH" style="flex:1" />
        <button class="btn ghost sm" @click="saveFfmpeg">保存</button>
      </div>
      <p class="hint">LLM 用 llama.cpp 的 llama-server 启动（OpenAI 兼容接口）；ComfyUI 启动后保持 8188 端口；ffmpeg.exe 可放到 workspace/tools/。</p>

      <!-- 引擎安装位置 + 一键启动 -->
      <!-- 阶段引擎编排（16GB 显存互斥） -->
      <div class="env-group">阶段引擎编排（llama / 生图模型 / H3 模型在 16GB 显存上互斥）</div>
      <div class="env-row">
        <span class="env-name">按阶段自动启停引擎</span>
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; cursor:pointer">
          <input type="checkbox" v-model="autoOrch" @change="saveAutoOrch" />
          进哪个阶段就启哪个引擎，用完让出显存
        </label>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="releaseNow">立即释放显存</button>
      </div>
      <p class="hint">
        阶段 2/3/5 用 llama（常驻约 10.6GB）；阶段 4 用 ComfyUI+SDXL；阶段 6 用 ComfyUI+H3（近 20GB，靠动态换页）；
        阶段 7 只用 ffmpeg。<b>切换阶段时软件会自动停掉不需要的引擎，并轮询显存真正回收到位后才放行</b>；
        ComfyUI 采用「进程常驻 + 模型按需装卸」（POST /free，秒级），避免每次冷启动等 30-60 秒。
        关掉此开关则一切由你在上面手动控制。
      </p>

      <div class="env-group">引擎安装位置（改完自动保存；填好后点「启动」即可拉起服务）</div>

      <div class="env-row">
        <span class="env-name">llama.cpp 安装目录</span>
        <span :class="eng.llama.exeOk?'model-ok':'model-no'">{{ eng.llama.exeOk?'已就位':'未找到' }}</span>
        <input type="text" v-model="llamaDir" @change="saveDir('llama')"
               placeholder="例：D:\\AIComic\\runtime\\llama（含 llama-server.exe）" style="flex:1" />
        <button class="btn ghost sm" @click="browseDir('llama')">浏览…</button>
        <button class="btn sm" :disabled="starting.llama" @click="start('llama')">
          {{ starting.llama ? '启动中…' : '启动' }}
        </button>
        <button class="btn ghost sm" @click="stop('llama')">停止</button>
      </div>
      <p class="hint mono">{{ eng.llama.exeOk ? 'launcher: ' + eng.llama.exe : '未找到 llama-server.exe' }}
        <span v-if="eng.llama.modelOk">　model: {{ eng.llama.modelFile }}</span>
        <span v-else class="model-no">　缺 GGUF：{{ eng.llama.modelDir }}</span>
      </p>
      <div class="env-row sub">
        <span class="env-name">GPU 加速（CUDA）</span>
        <span :class="cudaOk ? 'model-ok' : 'model-no'">{{ cudaText }}</span>
        <span style="flex:1"></span>
      </div>
      <p v-if="!cudaOk && eng.llama.cuda && eng.llama.cuda.hint" class="hint warn">{{ eng.llama.cuda.hint }}</p>
      <div class="env-row sub">
        <span class="env-name">llama 启动参数</span>
        <input type="text" v-model="llamaArgs" @change="saveArgs"
               placeholder="-ngl 99 -c 32768 -fa on -lm none --jinja" style="flex:1" />
        <button class="btn ghost sm" @click="resetArgs">恢复默认</button>
      </div>
      <p class="hint">模型路径与端口由软件自动补上（<span class="mono">-m &lt;GGUF&gt; --host 127.0.0.1 --port {{ portOf(eng.llama.endpoint) }}</span>）。
        点「启动」为<b>静默后台运行，不会弹出控制台窗口</b>；输出写到 <span class="mono">软件目录\logs\llama-server.log</span>（启动失败时会把日志尾部直接打进「运行日志」），
        要停服务点上面的「停止」。
        <span class="link" @click="openServiceLogs">打开服务日志目录…</span></p>

      <div class="env-row">
        <span class="env-name">ComfyUI 安装目录</span>
        <span :class="eng.comfyui.launcherOk?'model-ok':'model-no'">{{ eng.comfyui.launcherOk?'已就位':'未找到' }}</span>
        <input type="text" v-model="comfyDir" @change="saveDir('comfyui')"
               placeholder="ComfyUI Desktop 安装目录 / 便携包解压目录" style="flex:1" />
        <button class="btn ghost sm" @click="browseDir('comfyui')">浏览…</button>
        <button class="btn sm" :disabled="starting.comfyui" @click="start('comfyui')">
          {{ starting.comfyui ? '启动中…' : '启动' }}
        </button>
      </div>
      <p class="hint mono">{{ eng.comfyui.launcherOk
        ? '启动方式: ' + eng.comfyui.label + '　' + eng.comfyui.exe
        : '未识别到启动程序（Desktop 版找 Comfy Desktop.exe，便携版找 run_nvidia_gpu.bat）' }}
      </p>
      <p class="hint">点「启动」为<b>静默后台运行，不会弹出控制台黑窗</b>（ComfyUI Desktop 自己的界面窗口不受影响）；
        输出写到 <span class="mono">软件目录\logs\comfyui.log</span>。ComfyUI 运行时请用它自己的窗口退出，软件只按需装卸模型。</p>

      <!-- 模型目录（与 ComfyUI 共用） -->
      <div class="env-group">模型目录（直接复用 ComfyUI 的模型目录，无需复制）</div>

      <div class="env-row">
        <span class="env-name">ComfyUI 模型根目录</span>
        <span :class="rootOk?'model-ok':'model-no'">{{ rootOk?'已连通':'未找到' }}</span>
        <input type="text" v-model="modelsRoot" :placeholder="detectedRoot || '例如 D:\\ComfyUI\\ComfyUI-Shared\\models'" style="flex:1" />
        <button class="btn ghost sm" @click="detectRoot">自动检测</button>
        <button class="btn ghost sm" @click="browseRoot">浏览…</button>
        <button class="btn ghost sm" @click="saveRoot">保存</button>
      </div>
      <p class="hint">指向 ComfyUI 的 <b>models</b> 目录（ComfyUI Desktop 一般是 <span class="mono">…\ComfyUI-Shared\models</span>）。在 ComfyUI Desktop 里下载的模型，本软件直接读取，不用复制第二份。</p>

      <div class="env-group">标准子目录（按 ComfyUI 目录规范自动读取）</div>
      <div class="env-row" v-for="m in comfyItems" :key="m.key">
        <span class="env-name">{{ m.short }}</span>
        <span :class="m.ok?'model-ok':'model-no'">{{ m.ok?('已就位 '+m.count):'缺失' }}</span>
        <input type="text" :value="m.path" readonly :title="m.hint" style="flex:1" />
        <span class="mono sample" :title="m.hint">{{ m.ok ? m.sample[0] : m.hint }}</span>
        <button class="btn ghost sm" @click="openPath(m.path)">打开</button>
      </div>

      <div class="env-group">LLM 文本模型（llama.cpp 专用，不在 ComfyUI 体系内）</div>
      <div class="env-row">
        <span class="env-name">GGUF 模型目录</span>
        <span :class="llmItem.ok?'model-ok':'model-no'">{{ llmItem.ok?('已就位 '+llmItem.count):'缺失' }}</span>
        <input type="text" v-model="paths.llm" :placeholder="'默认：' + (llmItem.path||'')" style="flex:1" />
        <button class="btn ghost sm" @click="browse('llm')">浏览…</button>
        <button class="btn ghost sm" @click="savePath('llm')">保存</button>
      </div>
      <p class="hint">llama-server 加载的 *.gguf（如 Qwen3.5-9B-Q5_K_M）。默认读项目 runtime\models\llm；若 GGUF 也放在 ComfyUI 模型根目录下的 llm\ 里，会自动识别。</p>
    </div>

    <!-- 第三方 Skill（提示词扩展） -->
    <div class="set-card">
      <div class="set-head">
        <h3>第三方 Skill（提示词扩展）</h3>
        <button class="btn ghost sm" @click="installSkill">安装…</button>
      </div>
      <p class="hint">选择含 <b>SKILL.md</b> 的技能包文件夹即可安装（references/ 等附件原样保留，不做任何改写）。
        启用的 skill 会作为提示词规范供对应阶段使用；已内置 H3 官方提示词 skill。</p>
      <div class="env-row" v-for="s in skillList" :key="s.id">
        <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; cursor:pointer">
          <input type="checkbox" :checked="s.enabled" @change="toggleSkill(s, $event.target.checked)" />
          启用
        </label>
        <span class="env-name" :title="s.id">{{ s.name }}<span v-if="s.builtin" class="hint">（内置）</span></span>
        <span class="hint" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="s.description">{{ s.description || '（无描述）' }}</span>
        <button class="btn ghost sm" @click="removeSkill(s)">删除</button>
      </div>
      <p v-if="!skillList.length" class="hint">还没有已安装的 skill。</p>
    </div>

    <!-- 工作流 -->
    <div class="set-card">
      <div class="set-head">
        <h3>工作流模板</h3>
      </div>
      <div class="env-row">
        <span class="env-name">生图工作流</span>
        <select v-model="imgTpl" @change="saveImgTpl" style="flex:1">
          <option v-for="t in imgTpls" :key="t.key" :value="t.key">{{ t.label }}</option>
        </select>
      </div>
      <p class="hint">切换后点「生图」立即生效，无需重启。新增工作流：把 ComfyUI 导出的工作流交给软件转成模板文件即可接入。</p>
      <p class="hint">负向提示词在 Turbo 类蒸馏模型（cfg=1）下不参与采样，输入框保留备用 —— 换非蒸馏模型时自动生效。</p>
      <p class="hint">角色图与视频生成通过 ComfyUI 工作流执行，模板位于：</p>
      <p class="hint mono">{{ st.workspace }}\workflows\character.json（SDXL 版）／character_zimage_turbo.json（Z-Image Turbo 版），可自行修改参数</p>
      <p class="hint mono">{{ st.workspace }}\workflows\video_h3.json（H3 视频，需导出 API 格式工作流）</p>
      <p class="hint">模板里的模型名 <b>不用手填</b>，软件会按下列占位符自动从 ComfyUI 的模型目录里解析：</p>
      <p class="hint mono">__CKPT__（checkpoints）／__Z_UNET__·__Z_CLIP__·__Z_VAE__（Z-Image 三件套）／__H3_UNET__（diffusion_models，按模式自动选 fl2va / ref2va）／__H3_TEXT_ENCODER__（text_encoders）／__H3_VIDEO_VAE__·__H3_AUDIO_VAE__（vae）／__H3_LORA__（loras，按模式自动配对 4step / 8step）</p>
      <p class="hint mono">__PROMPT__ __NEGATIVE__ __SEED__ __IMAGE__ __WIDTH__ __HEIGHT__（运行时填入）</p>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'

export default {
  name: 'SettingsPanel',
  data() {
    return {
      paths: { llm: '' },
      ep: { llm: '', comfyui: '' },
      ffmpegPath: '',
      modelsRoot: '',
      detectedRoot: '',
      eng: {
        llama: { installDir: '', exe: '', exeOk: false, cuda: { backend: false, runtime: false, ok: false, hint: '' }, modelDir: '', modelFile: '', modelOk: false, endpoint: '' },
        comfyui: { installDir: '', launcherOk: false, label: '', exe: '', endpoint: '' }
      },
      llamaDir: '',
      comfyDir: '',
      llamaArgs: '',
      starting: { llama: false, comfyui: false },
      autoOrch: true,
      imgTpl: '',
      imgTpls: [],
      skillList: []
    }
  },
  computed: {
    st() { return useProjectStore() },
    health() { return this.st.health || { llm: false, comfyui: false, ffmpeg: false } },
    models() { return this.st.models || { items: [] } },
    comfyItems() { return (this.models.items || []).filter(m => m.group === 'comfy') },
    llmItem() {
      return (this.models.items || []).find(m => m.key === 'llm') ||
        { key: 'llm', short: 'LLM', ok: false, count: 0, path: '', sample: [], hint: '' }
    },
    rootOk() { return !!(this.models.modelsRoot && this.models.modelsRootOk) },
    cudaOk() {
      const c = this.eng && this.eng.llama && this.eng.llama.cuda
      return !!(c && c.ok)
    },
    cudaText() {
      const c = this.eng && this.eng.llama && this.eng.llama.cuda
      if (!c) return '未检测'
      if (c.ok) return '已启用（模型跑在显卡上）'
      if (c.backend) return '缺 CUDA 运行时 → 将用 CPU 推理'
      return '当前构建不含 CUDA → 将用 CPU 推理'
    }
  },
  async mounted() {
    const saved = await window.studio.getSetting('comfyui.modelsRoot')
    this.modelsRoot = saved || (this.models.modelsRoot || '')
    const v = await window.studio.getSetting('modelpath.llm')
    if (v) this.paths.llm = v
    for (const k of ['llm', 'comfyui']) {
      const e = await window.studio.getSetting('endpoint.' + k)
      this.ep[k] = e || (k === 'llm' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8188')
    }
    this.ffmpegPath = (await window.studio.getSetting('ffmpeg.path')) || ''
    await this.st.refreshEnv()
    this.modelsRoot = this.models.modelsRoot || this.modelsRoot
    this.detectedRoot = this.models.detectedRoot || ''
    await this.refreshEngine()
    await this.refreshImgTpls()
    try { this.autoOrch = await window.studio.getAutoOrchestrate() } catch (_) {}
    await this.refreshSkills()
  },
  methods: {
    /* ---- 第三方 Skill ---- */
    async refreshSkills() {
      try { this.skillList = await window.studio.skillsList() || [] } catch (_) { this.skillList = [] }
    },
    async installSkill() {
      try {
        const id = await window.studio.skillsInstall()
        if (id) { this.$root.toast('已安装 skill：' + id); await this.refreshSkills() }
      } catch (e) { this.st.fail(e) }
    },
    async toggleSkill(s, on) {
      try { await window.studio.skillsToggle(s.id, on); s.enabled = !!on } catch (e) { this.st.fail(e) }
    },
    async removeSkill(s) {
      if (!window.confirm('确定删除 skill「' + s.name + '」？' + (s.builtin ? '（内置版，删除后下次启动不会自动恢复）' : ''))) return
      try { await window.studio.skillsRemove(s.id); this.$root.toast('已删除'); await this.refreshSkills() } catch (e) { this.st.fail(e) }
    },
    h(k) { return !!this.health[k] },
    portOf(url) { try { return new URL(url).port || '8080' } catch (_) { return '8080' } },
    /* ---- 阶段引擎编排 ---- */
    async refreshImgTpls() {
      try {
        const list = await window.studio.imageTemplates() || []
        this.imgTpls = list
        const act = list.find(t => t.active)
        if (act) this.imgTpl = act.key
      } catch (_) { /* 环境接口不可用时静默 */ }
    },
    async saveImgTpl() {
      try {
        const st = await window.studio.setImageTemplate(this.imgTpl)
        if (st) { this.st.models = st; this.$root.toast('生图工作流已切换：' + this.imgTpl) }
      } catch (e) { this.st.fail(e) }
    },
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
    /* ---- 引擎安装位置 ---- */
    async refreshEngine() {
      const info = await window.studio.engineInfo()
      if (!info) return
      this.eng = info
      if (!this.llamaDir) this.llamaDir = info.llama.installDir || ''
      if (!this.comfyDir) this.comfyDir = info.comfyui.installDir || ''
      this.llamaArgs = info.llama.args || ''
    },
    async saveDir(key) {
      const dir = (key === 'llama' ? this.llamaDir : this.comfyDir).trim()
      const info = await window.studio.setEngineDir(key, dir || null)
      if (info) {
        if (key === 'llama') { this.eng.llama = info; this.llamaDir = info.installDir || '' }
        else { this.eng.comfyui = info; this.comfyDir = info.installDir || '' }
      }
      this.$root.toast('路径已保存')
    },
    async browseDir(key) {
      const info = await window.studio.chooseEngineDir(key)
      if (!info) return
      if (key === 'llama') { this.eng.llama = info; this.llamaDir = info.installDir || '' }
      else { this.eng.comfyui = info; this.comfyDir = info.installDir || '' }
      this.$root.toast('路径已保存')
    },
    async saveArgs() {
      this.llamaArgs = await window.studio.setLlamaArgs(this.llamaArgs)
      this.$root.toast('启动参数已保存')
    },
    async resetArgs() {
      this.llamaArgs = await window.studio.setLlamaArgs('')
      this.$root.toast('已恢复默认启动参数')
    },
    async start(key) {
      this.starting[key] = true
      try {
        const r = await window.studio.startEngine(key)
        this.$root.toast(r && r.message ? r.message : '已发送启动指令')
        if (r && !r.ok && !r.already) this.st.fail(new Error(r.message))
        await this.st.refreshEnv()
        await this.refreshEngine()
      } catch (e) {
        this.st.fail(e)
      } finally {
        this.starting[key] = false
      }
    },
    async stop(key) {
      try {
        const r = await window.studio.stopEngine(key)
        this.$root.toast(r && r.message ? r.message : '已发送停止指令')
        await this.st.refreshEnv()
        await this.refreshEngine()
      } catch (e) {
        this.st.fail(e)
      }
    },
    async openServiceLogs() {
      // 日志固定在软件目录 logs\ 下（从 serviceLogs 接口拿真实路径更稳）
      try {
        const sl = await window.studio.serviceLogs()
        const any = sl && (sl['llama-server'] || sl.comfyui)
        const dir = any && any.path ? any.path.replace(/[\\/][^\\/]+$/, '') : ''
        if (dir) { await window.studio.openPath(dir); return }
      } catch (_) {}
      this.$root.toast('服务日志目录还没生成（启动一次服务就有了）')
    },
    async recheck() { await this.st.refreshEnv(); await this.refreshEngine() },
    async saveEndpoint(k) {
      await window.studio.setSetting('endpoint.' + k, this.ep[k])
      await this.st.refreshEnv()
      this.$root.toast('已保存并重新检测')
    },
    async saveFfmpeg() {
      await window.studio.setSetting('ffmpeg.path', this.ffmpegPath.trim())
      await this.st.refreshEnv()
      this.$root.toast('已保存并重新检测')
    },
    /* ---- ComfyUI 模型根目录 ---- */
    async detectRoot() {
      const r = await window.studio.detectModelsRoot()
      this.detectedRoot = r.detected || ''
      if (r.state) this.st.models = r.state
      if (r.detected) {
        this.modelsRoot = r.detected
        this.$root.toast('已探测到 ComfyUI 模型目录，点「保存」生效')
      } else {
        this.$root.toast('没探测到 ComfyUI 模型目录，请手动浏览指定')
      }
    },
    async browseRoot() {
      const res = await window.studio.chooseModelDir('comfyui.modelsRoot')
      if (res) { this.st.models = res; this.modelsRoot = res.modelsRoot || this.modelsRoot; this.$root.toast('已保存路径') }
    },
    async saveRoot() {
      const res = await window.studio.setModelsRoot((this.modelsRoot || '').trim() || null)
      if (res) this.st.models = res
      this.$root.toast('已保存并重新检测')
    },
    async openPath(p) {
      if (!p) return
      const err = await window.studio.openPath(p)
      if (err) this.$root.toast(err)
    },
    async browse(key) {
      const res = await window.studio.chooseModelDir(key)
      if (res) {
        this.st.models = res
        const it = (res.items || []).find(i => i.key === key)
        if (it) this.paths[key] = it.path
        this.$root.toast('已保存路径')
      }
    },
    async savePath(key) {
      const res = await window.studio.setModelPath(key, (this.paths[key] || '').trim() || null)
      if (res) this.st.models = res
      this.$root.toast('已保存并重新检测')
    },
    async chooseWs() {
      const ws = await window.studio.chooseWorkspace()
      if (ws) { this.st.workspace = ws; await this.st.refresh(); await this.st.refreshEnv() }
    }
  }
}
</script>
