<template>
  <div class="help">
    <h2>快速上手</h2>
    <p class="help-lead">
      软件本身<b>不附带 AI 模型权重</b> —— 主模型、文本编码器、VAE 都要你自己下载。
      模型放对目录后立刻可用，不需要改配置、不需要重新装软件。
    </p>

    <!-- ============ ① 本机自检：把「还差什么」直接摆出来，比看文档快 ============ -->
    <div class="set-card">
      <div class="set-head">
        <h3>本机状态</h3>
        <button class="btn ghost sm" @click="reload">重新检查</button>
      </div>

      <div class="help-row">
        <span class="help-k">模型根目录</span>
        <code class="help-path" :class="{ bad: !rootOk }">{{ root || '还没设置' }}</code>
        <button v-if="root" class="btn ghost sm" @click="open(root)">打开</button>
        <button class="btn ghost sm" @click="st.view = 'settings'">去设置</button>
      </div>
      <div v-if="root && !rootOk" class="help-warn">
        这里没有 ComfyUI 的标准子目录（loras / diffusion_models / vae …）。要选到
        <code>…\ComfyUI-Shared\models</code> 这一层。
      </div>

      <div class="help-list" v-if="imgAssets.length">
        <div v-for="a in imgAssets" :key="a.key" class="help-item" :class="{ ok: a.ok }">
          <span class="help-tick">{{ a.ok ? '✓' : '✗' }}</span>
          <span class="help-item-name">
            {{ a.label }}<i v-if="!a.required" class="help-opt">可选</i>
          </span>
          <span class="help-item-need" :title="a.ok ? (a.sample[0] || '') : a.hint">
            {{ a.ok ? (a.sample && a.sample[0]) || '已就绪' : a.hint }}
          </span>
        </div>
      </div>

      <div class="help-row" style="margin-top:10px">
        <span class="help-k">风格 LoRA</span>
        <span class="help-val" :class="{ bad: !styleCount }">
          {{ styleCount ? '已识别 ' + styleCount + ' 个' : '目录里还没有文件' }}
        </span>
        <button v-if="loraDir" class="btn ghost sm" @click="open(styleDir)">打开 LoRA 目录</button>
      </div>
    </div>

    <!-- ============ ② 第一次用，三步 ============ -->
    <div class="set-card">
      <h3>第一次使用 · 三步</h3>
      <ol class="help-steps">
        <li>
          <b>装 ComfyUI</b>（本软件只负责调用，不带引擎）。
          装 Desktop 版，安装后新建一个实例并至少启动过一次。
          <button class="btn ghost sm" @click="openUrl('https://www.comfy.org/download')">去下载</button>
        </li>
        <li>
          <b>告诉软件模型在哪</b>：设置 → 模型管家 → 选择目录 → 选到
          <code>…\ComfyUI-Shared\models</code>（ComfyUI 的 models 目录本身，不是安装目录）。
        </li>
        <li>
          <b>下载模型放进对应子目录</b>，见下表。放完点上面的「重新检查」，四项都变 ✓ 就能出图。
        </li>
      </ol>
    </div>

    <!-- ============ ③ 模型放哪（表格） ============ -->
    <div class="set-card">
      <h3>模型放到哪个子目录</h3>
      <table class="help-table">
        <thead>
          <tr><th>放到这个子目录</th><th>要什么文件</th><th>大小</th><th>必需</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>diffusion_models\</code></td>
            <td>qwen_image_2.1_int8_convrot.safetensors</td>
            <td>约 7.3 GB</td><td>必需</td>
          </tr>
          <tr>
            <td><code>text_encoders\</code></td>
            <td>qwen3vl_8b_int8_convrot.safetensors</td>
            <td>约 9.4 GB</td><td>必需</td>
          </tr>
          <tr>
            <td><code>vae\</code></td>
            <td>qwen_image_2.1_vae_bf16.safetensors</td>
            <td>约 0.7 GB</td><td>必需</td>
          </tr>
          <tr>
            <td><code>diffusion_models\</code></td>
            <td>qwen_image_2.1_turbo_int8_convrot.safetensors</td>
            <td>约 6.8 GB</td><td>可选</td>
          </tr>
          <tr>
            <td><code>loras\qwen-image\</code></td>
            <td>turbo8_lora_step2500.safetensors（加速）<br>以及你喜欢的任意风格 LoRA</td>
            <td>数百 MB</td><td>可选</td>
          </tr>
        </tbody>
      </table>
      <p class="help-foot">
        文件名不要求一字不差 —— 软件按关键词认（qwen + image + 2）。但别把带
        <code>vae</code> / <code>turbo</code> 字样的文件当成主模型，它们各自占一个槽位。
      </p>
    </div>

    <!-- ============ ④ LoRA 用法（重点） ============ -->
    <div class="set-card">
      <div class="set-head">
        <h3>LoRA 怎么用</h3>
        <button v-if="loraDir" class="btn ghost sm" @click="open(styleDir)">打开目录</button>
      </div>

      <div class="help-tip">
        <b>把 .safetensors 文件直接丢进 <code>loras\qwen-image\</code> 就行</b>，
        图片生成页的「风格 LoRA」下拉里就会出现。剩下的事软件自己处理：
      </div>

      <div class="help-faq">
        <div class="help-qa">
          <div class="q">放完为什么下拉里没有？</div>
          <div class="a">当前版本只在进入图片生成页时读一次目录 —— <b>放完文件请重启软件</b>。另外文件必须在
            <code>loras\qwen-image\</code> 这一层（放 <code>loras\</code> 根目录或更深一层都认不到）。</div>
        </div>
        <div class="help-qa">
          <div class="q">魔搭 / DiffSynth 下的是另一种格式，要转换吗？</div>
          <div class="a">不用。这类权重的 key 名和 ComfyUI 期望的不一样，软件在你<b>第一次用它生成时自动转换</b>，
            转换结果放在同级目录，原文件不动。你什么都不用做。</div>
        </div>
        <div class="help-qa">
          <div class="q">要自己写触发词吗？</div>
          <div class="a">通常不用 —— 训练时写进文件里的触发词会被自动读出来，生成时拼到提示词最前面。
            只有想改「下拉里显示的中文名 / 备注」时才需要配一个同名 json（<code>xxx.safetensors.json</code>），
            这个文件是可选的，没有也能正常用。</div>
        </div>
        <div class="help-qa">
          <div class="q">选中了但画面没变化？</div>
          <div class="a">多半是「转换型」LoRA（把写实照片转成某种画风）。这类 LoRA 必须给它一张
            <b>参考图</b>才有东西可转 —— 在图片生成页上传参考图后再生成，纯文生图对它基本无效。</div>
        </div>
        <div class="help-qa">
          <div class="q">下拉里那一项是灰的，选不了？</div>
          <div class="a">这个 LoRA 不是给 Qwen-Image 用的（Flux / SDXL / 混元 的权重加载不进来，
            强行跑等于没挂）。换成 Qwen-Image 专用的 LoRA。</div>
        </div>
      </div>
    </div>

    <!-- ============ ⑤ 常见问题 ============ -->
    <div class="set-card">
      <h3>还有问题？</h3>
      <div class="help-faq">
        <div class="help-qa">
          <div class="q">「生成」按钮点不动</div>
          <div class="a">模型下拉里有「未安装」，或选的 LoRA 架构不对。看本页顶部的自检清单，缺哪个补哪个。</div>
        </div>
        <div class="help-qa">
          <div class="q">生成到一半软件闪退 / 屏幕黑一下</div>
          <div class="a">显存被撑爆，显卡驱动复位了。换成「Turbo 8 步」档、把分辨率降到 1080p 左右，
            并关掉其它吃显存的程序（游戏、浏览器里的 AI 页面、其它绘图工具）。</div>
        </div>
        <div class="help-qa">
          <div class="q">提示连不上 ComfyUI</div>
          <div class="a">先手动打开 ComfyUI Desktop 确认能正常进界面，再回设置页点「重新检测」。
            首次运行还要让 ComfyUI 自己启动过一次，它才会把实例目录建好。</div>
        </div>
        <div class="help-qa">
          <div class="q">视频生成要怎么配？</div>
          <div class="a">同样是「模型放对子目录」这一套逻辑，视频模型放 <code>diffusion_models\</code>
            与 <code>text_encoders\</code>。具体缺哪个文件，以设置页「模型管家」的提示为准。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'

export default {
  name: 'HelpView',
  data() {
    return {
      root: '',
      rootOk: false,
      loraDir: '',
      styleDir: '',
      imgAssets: [],
      styleCount: 0
    }
  },
  computed: {
    st() { return useProjectStore() }
  },
  async mounted() { await this.reload() },
  methods: {
    /**
     * 读一次本机状态。两路数据：
     *   checkModels → 模型目录 + 每个槽位是否就位（主进程扫盘，渲染层不碰文件系统）
     *   imgModels   → 图片生成页实际能选到的风格 LoRA 数量（口径与下拉一致）
     */
    async reload() {
      try {
        const r = (await window.studio.checkModels()) || {}
        this.root = r.modelsRoot || ''
        this.rootOk = !!r.modelsRootOk
        const items = Array.isArray(r.items) ? r.items : []
        // 只列图片生成要的文件：视频/超分方案的文件混在同一个 diffusion_models 里，
        // 不按 kind 过滤会把它们也当成"缺了就用不了"
        this.imgAssets = items.filter(i => i.group === 'asset' && i.kind === 'image')
        const lora = items.find(i => i.key === 'loras')
        const base = String(this.root || '').replace(/[\\/]+$/, '')
        this.loraDir = (lora && lora.path) || (base ? base + '\\loras' : '')
        this.styleDir = this.loraDir ? this.loraDir + '\\qwen-image' : ''
      } catch (_) { /* 读不到就只显示静态说明 */ }
      try {
        const im = (await window.studio.imgModels()) || {}
        this.styleCount = (im.styles || []).length
      } catch (_) { this.styleCount = 0 }
    },
    async open(p) {
      if (!p) return
      const r = await window.studio.openPath(p)
      if (typeof r === 'string' && r) {
        this.$root.toast(p === this.styleDir ? '这个目录还不存在，先新建它再把 LoRA 放进去' : r)
      }
    },
    async openUrl(u) {
      try { await window.studio.openUrl(u) } catch (_) {}
    }
  }
}
</script>
