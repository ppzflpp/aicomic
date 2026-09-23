<template>
<div class="shell">
  <!-- 顶部标题栏（无边框窗口拖拽区） -->
  <header class="titlebar">
    <div class="tb-brand">
      <span class="tb-logo"></span>
      <span class="tb-name">飞鱼AI短剧 Studio</span>
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
              <button title="项目配置（分辨率）" @click.stop="openProjCfg(p.id)">配置</button>
              <button title="新建子文件夹" @click.stop="newFolder(p.id, null)">＋夹</button>
              <button title="新建集数" @click.stop="newEpisode(p.id, null)">＋集</button>
              <button class="op-del" title="删除项目" @click.stop="st.askDelete('project', p.id, p.name)">✕</button>
            </span>
          </div>
          <template v-if="st.expanded.has('p'+p.id)">
            <folder-node v-for="f in p.folders" :key="f.id" :node="f" :depth="1" />
            <div v-for="e in p.episodes" :key="e.id" class="tree-row ep-row"
                 :class="{active: st.view==='dash' && st.current && st.current.id===e.id}" @click="st.openEpisode(e.id)">
              📄 {{ e.name }}
              <span class="ops">
                <button class="op-del" title="删除集数" @click.stop="st.askDelete('episode', e.id, e.name)">✕</button>
              </span>
            </div>

            <!-- 项目资产：assets/characters（角色图）+ assets/scenes（场景图） -->
            <div class="tree-row sub-row" @click="toggleMedia('assets', p.id)">
              <span class="caret">{{ st.expanded.has('a'+p.id) ? '▾' : '▸' }}</span>
              <span>🗂 assets</span>
              <span class="cnt" v-if="assetCount(p.id)">{{ assetCount(p.id) }}</span>
            </div>
            <template v-if="st.expanded.has('a'+p.id)">
              <div v-for="g in assetGroups(p.id)" :key="'ca'+g.name">
                <div class="tree-row sub2-row" @click="st.toggleExpand('c' + p.id + ':' + g.name)">
                  <span class="caret">{{ st.expanded.has('c' + p.id + ':' + g.name) ? '▾' : '▸' }}</span>
                  <span>{{ g.name }}</span>
                  <span class="cnt">{{ g.files.length }}</span>
                </div>
                <template v-if="st.expanded.has('c' + p.id + ':' + g.name)">
                  <div v-for="f in g.files" :key="f.path" class="tree-row leaf-row" @click="openPreview(f, 'image', g.name)">
                    <span class="leaf-ico">🖼</span>{{ f.file }}
                  </div>
                </template>
              </div>
              <div v-if="!assetGroups(p.id).length" class="tree-row leaf-row muted">（暂无角色图/场景图）</div>
            </template>

            <!-- 分镜（各集镜头视频，仍放在 <项目>/分镜/<集>/） -->
            <div class="tree-row sub-row" @click="toggleMedia('shots', p.id)">
              <span class="caret">{{ st.expanded.has('s'+p.id) ? '▾' : '▸' }}</span>
              <span>🎬 分镜</span>
              <span class="cnt" v-if="mediaCount(p.id, 'shots')">{{ mediaCount(p.id, 'shots') }}</span>
            </div>
            <template v-if="st.expanded.has('s'+p.id)">
              <div v-for="g in mediaGroups(p.id, 'shots')" :key="'sg'+g.episodeId">
                <div class="tree-row sub2-row" @click="st.toggleExpand('sg' + p.id + ':' + g.episodeId)">
                  <span class="caret">{{ st.expanded.has('sg' + p.id + ':' + g.episodeId) ? '▾' : '▸' }}</span>
                  <span>{{ g.name }}</span>
                  <span class="cnt">{{ g.files.length }}</span>
                </div>
                <template v-if="st.expanded.has('sg' + p.id + ':' + g.episodeId)">
                  <div v-for="f in g.files" :key="f.path" class="tree-row leaf-row" @click="openPreview(f, 'video', g.name)">
                    <span class="leaf-ico">🎞</span>{{ f.file }}
                  </div>
                </template>
              </div>
              <div v-if="!mediaGroups(p.id, 'shots').length" class="tree-row leaf-row muted">（暂无镜头视频）</div>
            </template>

            <!-- 成片（仍放在 <项目>/成片/<集>/） -->
            <div class="tree-row sub-row" @click="toggleMedia('films', p.id)">
              <span class="caret">{{ st.expanded.has('f'+p.id) ? '▾' : '▸' }}</span>
              <span>🎞 成片</span>
              <span class="cnt" v-if="mediaCount(p.id, 'films')">{{ mediaCount(p.id, 'films') }}</span>
            </div>
            <template v-if="st.expanded.has('f'+p.id)">
              <div v-for="g in mediaGroups(p.id, 'films')" :key="'fg'+g.episodeId">
                <div class="tree-row sub2-row" @click="st.toggleExpand('fg' + p.id + ':' + g.episodeId)">
                  <span class="caret">{{ st.expanded.has('fg' + p.id + ':' + g.episodeId) ? '▾' : '▸' }}</span>
                  <span>{{ g.name }}</span>
                  <span class="cnt">{{ g.files.length }}</span>
                </div>
                <template v-if="st.expanded.has('fg' + p.id + ':' + g.episodeId)">
                  <div v-for="f in g.files" :key="f.path" class="tree-row leaf-row" @click="openPreview(f, 'video', g.name)">
                    <span class="leaf-ico">🎞</span>{{ f.file }}
                  </div>
                </template>
              </div>
              <div v-if="!mediaGroups(p.id, 'films').length" class="tree-row leaf-row muted">（暂无成片）</div>
            </template>

            <!-- 项目提示词规范：<项目>/prompts/*.md（五个模块的风格规范，可编辑；缺失/旧版自动补内置版） -->
            <div class="tree-row sub-row" @click="togglePrompts(p.id)">
              <span class="caret">{{ st.expanded.has('q'+p.id) ? '▾' : '▸' }}</span>
              <span>📝 提示词规范</span>
            </div>
            <template v-if="st.expanded.has('q'+p.id)">
              <div v-for="f in promptFiles" :key="'q' + p.id + f.name" class="tree-row leaf-row"
                   @click="openPromptEdit(p.id, f)">
                <span class="leaf-ico">📄</span>{{ f.label }}
              </div>
            </template>
          </template>
        </div>
      </template>
      <div class="side-sep"></div>
      <div class="side-h">位置</div>
      <div class="tree-row" style="cursor:default">📁 {{ workspaceName }}</div>
    </div>
    <!-- 模型与工作区信息统一放在最底状态栏，这里只留入口 -->
    <div class="side-foot">
      <button class="btn-new" :class="{on: st.view==='settings'}" style="margin:0" @click="st.view='settings'">⚙ 设置</button>
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
        <!-- 新布局：5 个展示块。管线内部仍是 0..6 七个阶段（状态/解锁/耗时全部不变），
             只是显示上分组成：①章节输入+漫剧改编并排 ②角色&场景 ③分镜脚本(每行=分镜|H3提示词|视频) ④组装成片 -->
        <!-- 块1：章节输入 ＋ 漫剧改编（并排各占 50%，两卡等高） -->
        <div class="duo-row" :key="stageKey('duo')">
          <section class="stage half" :class="blkCls(0)">
            <div class="stage-head">
              <span class="s-num">1</span>
              <span class="s-title">章节输入</span>
              <span style="flex:1"></span>
              <!-- 字数：与耗时同款式的小胶囊，放在标题行右侧 -->
              <span class="head-ms" title="章节原文字数">{{ chapter.trim().length }} 字</span>
            </div>
            <div class="stage-body">
              <textarea v-model="chapter" rows="8" placeholder="粘贴小说章节原文…" @change="st.saveChapter(chapter)"></textarea>
              <div class="ops-bar">
                <span style="flex:1"></span>
                <button class="btn" :disabled="chapter.trim().length<50" @click="startAdapt">改编</button>
              </div>
            </div>
          </section>
          <section class="stage half" :class="blkCls(1)">
            <div class="stage-head">
              <span class="s-num">2</span>
              <span class="s-title">漫剧改编</span>
              <!-- 脏标签：显示在模块标题后面（上游变化提示） -->
              <span v-if="headStale('adapt')" class="stale head-stale" title="点击消除提示"
                    @click="ackHead('adapt')">{{ headStale('adapt') }}</span>
              <span style="flex:1"></span>
              <!-- 字数胶囊落点：StageAdapt 通过 Teleport 把「N 字」挂到这里（切集重挂载时走 tpReady 延迟） -->
              <span id="adapt-count" style="display:inline-flex;align-items:center"></span>
            </div>
            <div class="stage-body">
              <stage-adapt />
            </div>
          </section>
        </div>

        <!-- 块2：角色 & 场景（无锁定，随时可编辑；上游变化由脏标记提示） -->
        <section class="stage" :class="blkCls(3)" :key="stageKey('chars')">
          <div class="stage-head">
            <span class="s-num">3</span>
            <span class="s-title">角色 &amp; 场景</span>
            <span v-if="headStale('chars')" class="stale head-stale" title="点击消除提示"
                  @click="ackHead('chars')">{{ headStale('chars') }}</span>
            <span style="flex:1"></span>
            <!-- 批量按钮落点：StageChars 通过 Teleport 把「批量生成提示词 / 批量生成图片」挂到这里（状态文本左边） -->
            <span id="chars-batch" style="display:inline-flex;gap:8px;align-items:center"></span>
          </div>
          <div class="stage-body">
            <stage-chars />
          </div>
        </section>

        <!-- 块3：分镜脚本（列表化：每行从左到右 = 该镜头的分镜 | H3提示词 | 视频生成；
             无锁定；上游（改编稿/分镜/提示词/素材图）变化由 ⚠ 脏标记提示） -->
        <section class="stage" :class="blkCls(2, 4, 5)" :key="stageKey('shots')">
          <div class="stage-head">
            <span class="s-num">4</span>
            <span class="s-title">分镜脚本</span>
            <span v-if="headStale('shots')" class="stale head-stale" title="点击消除提示"
                  @click="ackHead('shots')">{{ headStale('shots') }}</span>
            <span style="flex:1"></span>
            <!-- 批量按钮落点：StageShots 通过 Teleport 把「批量生成提示词 / 批量生成视频」挂到这里（状态文本左边） -->
            <span id="shots-batch" style="display:inline-flex;gap:8px;align-items:center"></span>
          </div>
          <div class="stage-body">
            <stage-shots />
          </div>
        </section>

        <!-- 块4：组装成片（进入即自动组装） -->
        <section class="stage" :class="blkCls(6)" :key="stageKey('export')">
          <div class="stage-head">
            <span class="s-num">5</span>
            <span class="s-title">组装成片</span>
            <span style="flex:1"></span>
          </div>
          <div class="stage-body">
            <stage-export />
          </div>
        </section>
      </div>
    </div>

    <!-- 运行日志（底部可折叠抽屉） -->
    <log-panel />

    <div class="statusbar">
      <span>阶段：{{ st.view==='settings' ? '—' : blockPos + '/4' }}</span>
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

  <!-- 项目配置弹窗：新建项目时一并填分辨率（项目级默认值）；项目创建后可改（只影响之后新建的剧集） -->
  <div class="mask" :class="{hidden: !projModal}">
    <div class="dialog proj-dialog" v-if="projModal">
      <div class="proj-head">
        <div class="proj-head-txt">
          <h3>{{ projModal.mode === 'create' ? '新建项目' : '项目配置' }}</h3>
          <p class="proj-sub">{{ projModal.mode === 'create'
            ? '设置项目级分辨率，作为本项目下新建剧集的初始配置'
            : projModal.name + ' · 分辨率模板' }}</p>
        </div>
      </div>

      <input v-if="projModal.mode === 'create'" class="proj-name" type="text" v-model="projModal.name"
             placeholder="项目名称" @keyup.enter="confirmProj" />

      <div class="proj-grid">
        <div class="proj-row">
          <span class="proj-kind">图片生成</span>
          <select v-model="projModal.img"><option v-for="o in resOpts.img" :key="o.value" :value="o.value">{{ o.label }}</option></select>
        </div>
        <div class="proj-row">
          <span class="proj-kind">视频生成</span>
          <select v-model="projModal.vid"><option v-for="o in resOpts.vid" :key="o.value" :value="o.value">{{ o.label }}</option></select>
        </div>
        <div class="proj-row">
          <span class="proj-kind">视频输出</span>
          <select v-model="projModal.out"><option v-for="o in resOpts.out" :key="o.value" :value="o.value">{{ o.label }}</option></select>
        </div>
      </div>

      <div class="proj-note">
        {{ projModal.mode === 'create'
          ? '以上分辨率将在本项目下新建剧集时作为初始值；每个剧集之后可单独调整。'
          : '⚠ 修改只影响之后新建的剧集，已创建的剧集保持各自当前配置。' }}
      </div>

      <div class="row">
        <button class="btn ghost" @click="projModal = null">取消</button>
        <button class="btn" @click="confirmProj">{{ projModal.mode === 'create' ? '创建项目' : '保存' }}</button>
      </div>
    </div>
  </div>

  <!-- 媒体预览弹窗：左侧树里点角色图 / 镜头视频 / 成片 → 独立弹窗预览 -->
  <div class="mask" :class="{hidden: !preview}" @click.self="preview = null">
    <div class="dialog media-dialog" v-if="preview">
      <div class="md-head">
        <div class="md-title">
          <b>{{ preview.file }}</b>
          <span class="md-sub">{{ preview.sub }}</span>
        </div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" v-if="preview.path" @click="revealMedia">所在文件夹</button>
        <button class="btn ghost sm" @click="preview = null">关闭</button>
      </div>
      <div class="md-body">
        <div v-if="!preview.src" class="md-loading"><i class="spin"></i> 加载中…</div>
        <img v-else-if="preview.kind === 'image'" :src="preview.src" @load="onPreviewLoad" />
        <video v-else :src="preview.src" controls autoplay loop></video>
      </div>
    </div>
  </div>

  <!-- 提示词编辑弹窗：<项目>/prompts/*.md，保存后下次生成即生效 -->
  <div class="mask" :class="{hidden: !promptEdit}" @click.self="promptEdit = null">
    <div class="dialog media-dialog prompt-dialog" v-if="promptEdit">
      <div class="md-head">
        <div class="md-title">
          <b>{{ promptEdit.label }}</b>
          <span class="md-sub">{{ promptEdit.name }} · 这是风格规范（不是直接发给大模型的提示词），可自由编辑，保存后下次生成即生效</span>
        </div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" @click="promptEdit = null">关闭</button>
        <button class="btn sm" :disabled="promptEdit.busy" @click="savePromptEdit">保存</button>
      </div>
      <div class="md-body">
        <textarea v-model="promptEdit.text" class="prompt-editor" :disabled="promptEdit.busy" spellcheck="false"></textarea>
      </div>
    </div>
  </div>

  <!-- 危险确认弹窗（删除） -->
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
import StageExport from './StageExport.vue'
import LogPanel from './LogPanel.vue'
import { PROMPT_FILES } from './prompts.js'
import { moduleStale, ackModule, MODULE_STALE_KINDS } from './stale.js'

export default {
  components: { FolderNode, SettingsPanel, StageAdapt, StageShots, StageChars, StageExport, LogPanel },
  data() {
    return {
      chapter: '',
      projModal: null,   // 项目配置弹窗 {mode:'create'|'edit', id, name, img, vid, out}
      promptEdit: null,  // 提示词编辑弹窗 {pid, name, label, text, busy}
      preview: null,     // 媒体预览弹窗 {kind:'image'|'video', file, sub, src, path}
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
    /** 分辨率档位（按当前模型过滤）；选项未加载完时空列表，select 自然回退默认值 */
    resOpts() {
      return this.st.resOptions || { img: [], vid: [], out: [] }
    },
    /** 项目提示词文件清单（固定四个：adapt/shots/chars/h3） */
    promptFiles() { return PROMPT_FILES },
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
    /** 状态栏的展示进度：管线 0..6 映射到 4 个展示块（0,1→1；3→2；2,4,5→3；6→4） */
    blockPos() {
      if (this.st.view !== 'dash') return 0
      const a = this.pl.active
      return a <= 1 ? 1 : (a === 3 ? 2 : (a === 6 ? 4 : 3))
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
      this.st.loadResOptions()
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
    /**
     * 某阶段是否正在生成。第 3 阶段（分镜）与「角色&场景」档案是同一次 LLM 调用产出的，
     * 所以分镜在跑时，角色&场景块也要一起显示「进行中」。
     */
    isGen(i) {
      if (this.pl.genStartAt[i]) return true
      return i === 3 && !!this.pl.genStartAt[2]
    },
    /** 展示块的样式类：块内全部完成 → done；有进行中 → running（无锁定态） */
    blkCls(...idx) {
      if (idx.every(i => this.pl.done[i])) return { done: true }
      if (idx.some(i => (i === this.pl.active || this.isGen(i)) && !this.pl.done[i])) return { running: true }
      return {}
    },
    /** 模块级脏标签文案（显示在模块标题后面）；无则返回空串 */
    headStale(kind) {
      if (!this.st.current) return ''
      return moduleStale(this.st.current.revs, kind) ? MODULE_STALE_KINDS[kind].text : ''
    },
    /** 点击脏标签 → 消除（不重新生成也消失） */
    async ackHead(kind) {
      await ackModule(this.st, kind)
      this.toast('提示已消除')
    },
    /** 展示块的 key：换集时变化 → 强制重挂载，清空上一集残留（角色库/视频/提示词…） */
    stageKey(suffix) {
      return (this.st.current ? this.st.current.id : 0) + ':' + suffix
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
    /** 第 1 块「改编」：存章节 → 确认进入第 2 块 → 置自动改编标记（改编模块挂载后立即开跑） */
    async startAdapt() {
      if (!this.st.current) return
      await this.st.saveChapter(this.chapter)
      this.pl.confirm(0, this.st.current.id)
      this.pl.autoAdapt = true
      this.toast('已进入漫剧改编，正在自动改编…')
    },
    /** 新建项目：弹窗里一并定三个分辨率（项目级默认值，初始化本项目下新建的剧集） */
    newProject() {
      const d = this.st.resOptions || { img: [], vid: [], out: [] }
      this.projModal = {
        mode: 'create', id: null, name: '',
        img: (d.img[0] || {}).value || '1216x832',
        vid: (d.vid[0] || {}).value || '864x480',
        out: (d.out[0] || {}).value || '1920x1080'
      }
    },
    /** 项目配置：读项目当前三项，改了只影响之后新建的剧集 */
    openProjCfg(pid) {
      const p = this.st.tree.find(x => x.id === pid)
      if (!p) return
      const r = p.res || {}
      this.projModal = {
        mode: 'edit', id: pid, name: p.name,
        img: r.img || '1216x832', vid: r.vid || '864x480', out: r.out || '1920x1080'
      }
    },
    async confirmProj() {
      const m = this.projModal
      if (!m) return
      const res = { img: m.img, vid: m.vid, out: m.out }
      if (m.mode === 'create') {
        const name = (m.name || '').trim()
        if (!name) { this.toast('请填写项目名称'); return }
        this.projModal = null
        await this.st.createProject(name, res)
        this.toast('已新建项目：' + name)
      } else {
        this.projModal = null
        await this.st.setProjectRes(m.id, res)
        this.toast('已保存（只影响之后新建的剧集）')
      }
    },
    /* ---- 左侧树：项目媒体节点（assets / 分镜 / 成片），展开时才拉数据 ---- */
    /** 展开/收起某个媒体节点；首次展开时拉取数据 */
    async toggleMedia(kind, pid) {
      const key = { assets: 'a', shots: 's', films: 'f' }[kind] + pid
      const wasOpen = this.st.expanded.has(key)
      this.st.toggleExpand(key)
      if (wasOpen) return
      if (kind === 'assets') await this.st.loadAssets(pid)
      else if (kind === 'shots') await this.st.loadShots(pid)
      else await this.st.loadFilms(pid)
    },
    /** assets 下的分组（角色名 / 场景名） */
    assetGroups(pid) {
      const slot = this.st.media[pid]
      if (!slot || !slot.characters) return []
      return [...(slot.characters || []), ...(slot.scenes || [])]
    },
    assetCount(pid) {
      return this.assetGroups(pid).reduce((n, g) => n + g.files.length, 0)
    },
    /** 分镜 / 成片的分组（按集） */
    mediaGroups(pid, kind) {
      const slot = this.st.media[pid]
      const list = slot && slot[kind]
      return Array.isArray(list) ? list : []
    },
    mediaCount(pid, kind) {
      return this.mediaGroups(pid, kind).reduce((n, g) => n + g.files.length, 0)
    },
    /** 打开预览弹窗：图片/视频都走 base64（渲染层不能直接读本地文件） */
    async openPreview(it, kind, label) {
      const entry = { kind, file: it.file, path: it.path, sub: label || '', src: '' }
      this.preview = entry
      if (kind === 'video') {
        const bits = [label, ratioFromW(it.width, it.height)]
        if (it.durationSec) bits.push(it.durationSec.toFixed(1) + 's')
        if (it.size) bits.push(this.fmtSize(it.size))
        if (it.elapsedMs) bits.push('导出耗时 ' + fmtMs(it.elapsedMs))
        entry.sub = bits.filter(Boolean).join(' · ')
      }
      try {
        const b64 = await window.studio.readFileBase64(it.path)
        if (this.preview !== entry) return   // 期间已经关了/换了
        entry.src = b64 ? (kind === 'image' ? 'data:image/png;base64,' + b64 : 'data:video/mp4;base64,' + b64) : ''
      } catch (_) { /* 读取失败就停在上面的「加载中」 */ }
    },
    /** 图片加载完 → 补上真实分辨率与体积 */
    onPreviewLoad(e) {
      const p = this.preview
      if (!p) return
      const im = e && e.target
      if (im && im.naturalWidth) p.sub = [p.sub, im.naturalWidth + '×' + im.naturalHeight].filter(Boolean).join(' · ')
    },
    revealMedia() {
      if (this.preview && this.preview.path) window.studio.revealFile(this.preview.path)
    },
    fmtSize(bytes) {
      const mb = bytes / 1024 / 1024
      return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB'
    },
    newFolder(pid, parentId) {
      this.st.askText('子文件夹名称', '', name => this.st.addFolder(pid, parentId, name).then(() => this.toast('已新建文件夹')))
    },
    /* ---- 左侧树：项目提示词文件（<项目>/prompts/*.md，固定四个） ---- */
    async togglePrompts(pid) {
      const key = 'q' + pid
      const wasOpen = this.st.expanded.has(key)
      this.st.toggleExpand(key)
      if (!wasOpen) {
        // 主进程在 list 时会把缺失的内置提示词补齐（新项目/被删过都能自愈）
        try { await window.studio.promptsList(this.st.workspace, pid) } catch (_) {}
      }
    },
    async openPromptEdit(pid, f) {
      this.promptEdit = { pid, name: f.name, label: f.label, text: '', busy: true }
      try {
        const text = await window.studio.readPrompt(this.st.workspace, pid, f.name)
        if (!this.promptEdit || this.promptEdit.pid !== pid || this.promptEdit.name !== f.name) return
        this.promptEdit.text = text
        this.promptEdit.busy = false
      } catch (e) {
        this.toast('读取失败：' + (e && e.message || e))
        this.promptEdit = null
      }
    },
    async savePromptEdit() {
      const p = this.promptEdit
      if (!p || p.busy) return
      p.busy = true
      try {
        await window.studio.savePrompt(this.st.workspace, p.pid, p.name, p.text)
        this.toast('提示词已保存，下次生成即生效')
        this.promptEdit = null
      } catch (e) {
        this.toast('保存失败：' + (e && e.message || e))
        p.busy = false
      }
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
    askUnlock() { /* 🔴 锁定已全面移除：保留空实现防止遗留调用报错 */ },
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

/** 宽高 → '864×480（16:9）'；缺值返回空串 */
function ratioFromW(w, h) {
  if (!w || !h) return ''
  const g = (a, b) => { while (b) { [a, b] = [b, a % b] } return a || 1 }
  const d = g(w, h)
  return w + '×' + h + '（' + (w / d) + ':' + (h / d) + '）'
}
</script>
