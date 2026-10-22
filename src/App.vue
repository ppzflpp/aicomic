<template>
<div class="shell">
  <!-- 顶部标题栏（无边框窗口拖拽区） -->
  <header class="titlebar">
    <div class="tb-brand">
      <span class="tb-logo"></span>
      <span class="tb-name">飞鱼AI视频导演台</span>
    </div>
    <span class="tb-sep"></span>
    <div class="tb-crumb">
      <span>{{ workspaceName }}</span>
      <template v-if="st.current && st.view==='dash'">
        <span class="tb-slash">/</span><b>{{ st.current.name }}</b>
      </template>
      <template v-if="st.view==='settings'">
        <span class="tb-slash">/</span><b>设置</b>
      </template>
    </div>
    <span style="flex:1"></span>

    <!-- 实时系统监控（2026-09-29 Dragon：4 个独立项，各带百分比 + 进度条；宽度随内容自适应） -->
    <div class="tb-sys" :class="{narrow}">
      <span class="tb-metric" :class="gpuView.cls" :title="gpuView.title">
        <b>GPU</b>
        <i class="tb-bar"><em :style="{width: gpuView.pct + '%'}"></em></i>
        <span class="tb-num">{{ gpuView.text }}</span>
        <span class="tb-sub">{{ gpuView.sub }}</span>
      </span>
      <span class="tb-metric" :class="cpuView.cls" :title="cpuView.title">
        <b>CPU</b>
        <i class="tb-bar"><em :style="{width: cpuView.pct + '%'}"></em></i>
        <span class="tb-num">{{ cpuView.text }}</span>
        <span class="tb-sub">{{ cpuView.sub }}</span>
      </span>
      <span class="tb-metric" :class="vramView.cls" :title="vramView.title">
        <b>显存</b>
        <i class="tb-bar"><em :style="{width: vramView.pct + '%'}"></em></i>
        <span class="tb-num">{{ vramView.text }}</span>
        <span class="tb-sub">{{ vramView.sub }}</span>
      </span>
      <span class="tb-metric" :class="memView.cls" :title="memView.title">
        <b>内存</b>
        <i class="tb-bar"><em :style="{width: memView.pct + '%'}"></em></i>
        <span class="tb-num">{{ memView.text }}</span>
        <span class="tb-sub">{{ memView.sub }}</span>
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
  <!-- 左侧菜单栏：可整体收成窄条（只留展开按钮）；「工作台」= 项目树的开关（默认收起） -->
  <aside class="sidebar" :class="{collapsed: sideCollapsed}">
    <button class="side-toggle" :title="sideCollapsed ? '展开菜单栏' : '收起菜单栏'"
            @click="sideCollapsed = !sideCollapsed">{{ sideCollapsed ? '⟩' : '⟨' }}</button>
    <template v-if="!sideCollapsed">
    <div class="side-actions">
      <div class="tree-row nav-row" @click="st.toggleExpand('workbench')">
        <span class="caret">{{ st.expanded.has('workbench') ? '▼' : '▶' }}</span>
        <span>创作台</span>
        <i v-if="shotsBusy" class="nav-dot" title="分镜任务进行中（切菜单/切集不中断）"></i>
      </div>
      <button v-if="st.expanded.has('workbench')" class="btn-new" @click="newProject">＋ 新建项目</button>
    </div>
    <!-- 工作台展开区：只有 新建项目按钮 + 项目列表（图片生成/视频生成与工作台平级，在下方） -->
    <div class="side-scroll" v-if="st.expanded.has('workbench')">
      <div class="side-h">项目</div>
      <template v-for="p in st.tree" :key="p.id">
        <div class="tree-node">
          <div class="tree-row" @click="toggleProject(p.id)">
            <span class="caret">{{ st.expanded.has('p'+p.id) ? '▼' : '▶' }}</span>
            <span>{{ p.name }}</span>
            <i v-if="projectHasTask(p)" class="nav-dot" title="该项目下有任务在跑"></i>
            <span class="ops">
              <button title="项目配置（分辨率 / 视频质量 / 风格）" @click.stop="openProjCfg(p.id)">配置</button>
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
              <i v-if="episodeHasVideoTask(e.id)" class="nav-dot" title="该集有视频任务在跑（切菜单/切集不中断）"></i>
              <span class="ops">
                <button class="op-del" title="删除集数" @click.stop="st.askDelete('episode', e.id, e.name)">✕</button>
              </span>
            </div>

            <!-- 剧本（项目下「剧本/」平铺目录的工件：章节原文/改编稿/分镜脚本/角色·场景档案；
                 扁平化后一个目录平铺全项目工件，靠文件名前缀=集名归集） -->
            <div class="tree-row sub-row" @click="toggleMedia('scripts', p.id)">
              <span class="caret">{{ st.expanded.has('r'+p.id) ? '▼' : '▶' }}</span>
              <span>📜 剧本</span>
              <span class="cnt" v-if="mediaCount(p.id, 'scripts')">{{ mediaCount(p.id, 'scripts') }}</span>
            </div>
            <template v-if="st.expanded.has('r'+p.id)">
              <div v-for="g in mediaGroups(p.id, 'scripts')" :key="'rg'+g.episodeId">
                <div class="tree-row sub2-row" @click="st.toggleExpand('rg' + p.id + ':' + g.episodeId)">
                  <span class="caret">{{ st.expanded.has('rg' + p.id + ':' + g.episodeId) ? '▼' : '▶' }}</span>
                  <span>{{ g.name }}</span>
                  <span class="cnt">{{ g.files.length }}</span>
                </div>
                <template v-if="st.expanded.has('rg' + p.id + ':' + g.episodeId)">
                  <div v-for="f in g.files" :key="f.path" class="tree-row leaf-row" :title="f.file"
                       @click="openScript(f, g)">
                    <span class="leaf-ico">{{ f.ico }}</span>{{ f.label }}
                  </div>
                </template>
              </div>
              <div v-if="!mediaGroups(p.id, 'scripts').length" class="tree-row leaf-row muted">（暂无剧本工件）</div>
            </template>

            <!-- 项目资产：assets/characters（角色图）+ assets/scenes（场景图） -->
            <div class="tree-row sub-row" @click="toggleMedia('assets', p.id)">
              <span class="caret">{{ st.expanded.has('a'+p.id) ? '▼' : '▶' }}</span>
              <span>🗂 assets</span>
              <span class="cnt" v-if="assetCount(p.id)">{{ assetCount(p.id) }}</span>
            </div>
            <template v-if="st.expanded.has('a'+p.id)">
              <div v-for="g in assetGroups(p.id)" :key="'ca'+g.name">
                <div class="tree-row sub2-row" @click="st.toggleExpand('c' + p.id + ':' + g.name)">
                  <span class="caret">{{ st.expanded.has('c' + p.id + ':' + g.name) ? '▼' : '▶' }}</span>
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

            <!-- 分镜（<项目>/分镜 平铺目录，本集镜头视频按文件名前缀=集名归集） -->
            <div class="tree-row sub-row" @click="toggleMedia('shots', p.id)">
              <span class="caret">{{ st.expanded.has('s'+p.id) ? '▼' : '▶' }}</span>
              <span>🎬 分镜</span>
              <span class="cnt" v-if="mediaCount(p.id, 'shots')">{{ mediaCount(p.id, 'shots') }}</span>
            </div>
            <template v-if="st.expanded.has('s'+p.id)">
              <div v-for="g in mediaGroups(p.id, 'shots')" :key="'sg'+g.episodeId">
                <div class="tree-row sub2-row" @click="st.toggleExpand('sg' + p.id + ':' + g.episodeId)">
                  <span class="caret">{{ st.expanded.has('sg' + p.id + ':' + g.episodeId) ? '▼' : '▶' }}</span>
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

            <!-- 成片（<项目>/成片 平铺目录，本集成片按文件名前缀=集名归集） -->
            <div class="tree-row sub-row" @click="toggleMedia('films', p.id)">
              <span class="caret">{{ st.expanded.has('f'+p.id) ? '▼' : '▶' }}</span>
              <span>🎞 成片</span>
              <span class="cnt" v-if="mediaCount(p.id, 'films')">{{ mediaCount(p.id, 'films') }}</span>
            </div>
            <template v-if="st.expanded.has('f'+p.id)">
              <div v-for="g in mediaGroups(p.id, 'films')" :key="'fg'+g.episodeId">
                <div class="tree-row sub2-row" @click="st.toggleExpand('fg' + p.id + ':' + g.episodeId)">
                  <span class="caret">{{ st.expanded.has('fg' + p.id + ':' + g.episodeId) ? '▼' : '▶' }}</span>
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

            <!-- 提示词配置中心（整页视图）：成品预览与整段覆写 + 通用规范 + 模型专属规范 + 风格轴。
                 2026-10-07：老的「逐份改文件」入口已删 —— 它只是「按文件改」的快捷方式，
                 能力被这里的「通用规范」分区完整覆盖（还多一个「恢复内置版」）。 -->
            <div class="tree-row sub-row"
                 :class="{ active: st.view==='prompts' && st.promptTarget && st.promptTarget.projectId===p.id }"
                 title="成品提示词 / 通用规范 / 模型专属规范 / 风格轴 —— 都看得见、改得动"
                 @click="st.openPrompts(p.id)">
              <span class="caret">🎛</span>
              <span>提示词配置中心</span>
            </div>

            <!-- 项目角色场景库：跨集共享的角色/场景条目（名字=图片目录名=分镜 chars 的键）。
                 点条目 → 右侧库编辑区（不属于任何一集，无当前集也能打开） -->
            <div class="tree-row sub-row" @click="toggleLibrary(p.id)">
              <span class="caret">{{ st.expanded.has('L'+p.id) ? '▼' : '▶' }}</span>
              <span>📚 项目角色场景库</span>
              <i v-if="libBusy" class="nav-dot" title="库任务进行中"></i>
              <span class="cnt" v-if="libEntryCount(p.id)">{{ libEntryCount(p.id) }}</span>
            </div>
            <template v-if="st.expanded.has('L'+p.id)">
              <template v-for="grp in libGroups(p.id)" :key="'Lg' + grp.kind + p.id">
                <div v-if="grp.items.length" class="tree-row sub2-row"
                     @click="st.toggleExpand('Lg' + grp.kind + p.id)">
                  <span class="caret">{{ st.expanded.has('Lg' + grp.kind + p.id) ? '▼' : '▶' }}</span>
                  <span>{{ grp.label }}</span>
                  <span class="cnt">{{ grp.items.length }}</span>
                </div>
                <template v-if="st.expanded.has('Lg' + grp.kind + p.id)">
                  <div v-for="e in grp.items" :key="'Le' + e.id" class="tree-row leaf-row"
                       :class="{ active: st.view==='lib' && st.libTarget && st.libTarget.id===e.id }"
                       :title="(e.kind === 'scene' ? '场景' : (e.role || '角色')) + ' · ' + e.images.length + ' 张图'"
                       @click="openLibEntry(p.id, e)">
                    <span class="leaf-ico">{{ e.kind === 'scene' ? '🏞' : '🧑' }}</span>{{ e.name }}
                  </div>
                </template>
              </template>
              <div v-if="!libEntryCount(p.id)" class="tree-row leaf-row muted">（库为空：生成分镜后把本集角色「保存到项目」）</div>
            </template>
          </template>
        </div>
      </template>
    </div>
    <!-- 图片生成 / 视频生成：与工作台同级的独立菜单组 -->
    <div class="side-actions side-sub">
      <div class="tree-row nav-row" @click="st.toggleExpand('imggen')">
        <span class="caret">{{ st.expanded.has('imggen') ? '▼' : '▶' }}</span>
        <span>图片生成</span>
        <i v-if="igState.busy" class="nav-dot" title="正在生成中…"></i>
      </div>
      <div v-if="st.expanded.has('imggen')" class="tree-row nav-leaf"
           :class="{active: st.view==='imggen'}" @click="st.view='imggen'">图片生成
        <i v-if="igState.busy" class="nav-dot" :title="'正在生成：' + (igState.text || '出图中')"></i>
      </div>
      <div class="tree-row nav-row" @click="st.toggleExpand('vidgen')">
        <span class="caret">{{ st.expanded.has('vidgen') ? '▼' : '▶' }}</span>
        <span>视频生成</span>
        <i v-if="vgState.busy" class="nav-dot" title="正在生成中…"></i>
      </div>
      <div v-if="st.expanded.has('vidgen')" class="tree-row nav-leaf"
           :class="{active: st.view==='vidgen'}" @click="st.view='vidgen'">视频生成
        <i v-if="vgState.busy" class="nav-dot" :title="'正在生成：' + (vgState.text || '出视频中')"></i>
      </div>
    </div>
    </template>
    <!-- 模型与工作区信息统一放在最底状态栏，这里只留入口；设置按钮永远显示在最下面（收起态只留 ⚙） -->
    <div class="side-foot">
      <button class="btn-new" :class="{on: st.view==='settings'}" style="margin:0"
              @click="st.view='settings'">{{ sideCollapsed ? '⚙' : '⚙ 设置' }}</button>
    </div>
  </aside>

  <!-- 主区域 -->
  <div class="main">
    <div class="pathbar">
      <button class="btn ghost" style="padding:3px 10px; font-size:12px"
              v-if="st.view==='settings' || st.view==='prompts' || st.view==='imggen' || st.view==='vidgen'"
              @click="st.view='dash'">← 返回</button>
      <span class="crumb">工作区 <b>{{ workspaceName }}</b></span>
      <template v-if="st.view==='dash' && st.current">
        <span class="crumb">/ <b>{{ st.current.name }}</b></span>
      </template>
      <template v-if="st.view==='settings'">
        <span class="crumb">/ <b>设置</b></span>
      </template>
      <template v-else-if="st.view==='imggen'">
        <span class="crumb">/ <b>图片生成</b></span>
      </template>
      <template v-else-if="st.view==='vidgen'">
        <span class="crumb">/ <b>视频生成</b></span>
      </template>
      <template v-if="st.view==='lib'">
        <span class="crumb">/ <b>项目角色场景库</b></span>
        <span class="crumb" v-if="libProject">/ <b>{{ libProject }}</b></span>
      </template>
      <template v-if="st.view==='prompts'">
        <span class="crumb">/ <b>提示词配置中心</b></span>
        <span class="crumb" v-if="promptProject">/ <b>{{ promptProject }}</b></span>
      </template>
      <span style="flex:1"></span>
      <button class="btn ghost" style="padding:4px 12px; font-size:12px" @click="chooseWs">更改工作区</button>
    </div>

    <!-- 设置视图 -->
    <div class="content" v-if="st.view==='settings'">
      <settings-panel />
    </div>

    <!-- 图片生成独立功能页（Qwen-Image 2.1：文生图 / 原生编辑 / 图生图）见本文件末尾常驻块 -->

    <!-- 视频生成独立功能页（MiniMax H3：文生视频 / 参考生视频 / 首尾帧），同样常驻挂载，见末尾常驻块 -->

    <!-- 提示词配置中心（整页视图；不属于任何一集：左树点「提示词配置中心」进来）。
         四个分区：成品提示词（看 / 整段改）/ 通用规范 / 模型专属规范 / 风格轴 -->
    <div class="content pv-content" v-else-if="st.view==='prompts'">
      <prompts-view />
    </div>

    <!-- 仪表盘视图（🔴 常驻挂载 v-show，不参与上面那条 v-if/v-else-if 链，与图片生成页同理：
         切到设置/图片生成/库/提示词等菜单只 display:none 不销毁，分镜/角色/成片等 stage 组件实例保留，
         正在跑的批量任务（批量生成提示词/视频/超分）不被打断。
         🔴 切「集」仍会重建 stage 组件（靠 stageKey 的 :key），那是故意行为，不受本改动影响） -->
    <div class="content dash-content" v-show="st.view==='dash'">
      <div v-if="!st.current" class="placeholder" style="margin-top:60px">
        左侧选择或新建一个集数开始
      </div>
      <div v-else class="grid">
        <!-- 新布局：4 个展示块。管线内部仍是 0..6 七个阶段（状态/解锁/耗时全部不变），
             只是显示上分组成：①剧本创作（原文输入+AI优化稿 一卡两栏）②角色&场景 ③分镜脚本(每行=分镜|H3提示词|视频) ④组装成片 -->
        <!-- 块1：剧本创作（2026-09-27 合并：原「内容输入」+「内容AI优化」两卡并排 → 一卡两栏；
             「改编」与「生成分镜」合并到卡片底部同一条操作条，StageAdapt 通过 Teleport 把耗时+生成分镜挂到 #adapt-ops） -->
        <section class="stage" :class="blkCls(0, 1)" :key="stageKey('duo')" data-nav="1">
          <div class="stage-head">
            <span class="s-num">1</span>
            <span class="s-title">剧本创作</span>
            <span class="s-sub">原文输入 → AI 优化成可分镜剧本</span>
            <span style="flex:1"></span>
            <!-- 字数：原文一个胶囊（与耗时同款式）；改编稿字数由 StageAdapt 通过 Teleport 挂到 #adapt-count -->
            <span class="head-ms" title="章节原文字数">{{ chapter.trim().length }} 字</span>
            <span id="adapt-count" style="display:inline-flex;align-items:center"></span>
            <!-- 2026-09-27 二改（Dragon）：「改编」「生成分镜」按钮移到模块标题栏右边（耗时挂改编左边） -->
            <span id="adapt-ms" style="display:inline-flex;align-items:center"></span>
            <!-- 分隔线：左边是信息（字数 / 耗时），右边全是按钮 -->
            <span class="head-sep"></span>
            <button class="btn h-sm" :class="{ 'stale-need': !!headStale('adapt') }"
                    :disabled="chapter.trim().length<50"
                    :title="headStale('adapt') ? '章节在上次改编后又改过 → 这里点下去会按新章节重新改编' : ''"
                    @click="startAdapt">改编</button>
            <span id="adapt-ops" style="display:inline-flex;align-items:center"></span>
          </div>
          <div class="stage-body">
            <!-- 改编进度条落点：横贯整个剧本创作卡（原来只挂在右栏 AI 优化稿顶部；StageAdapt Teleport 进来） -->
            <div id="adapt-progress"></div>
            <div class="script-grid">
              <div class="script-col">
                <p class="zone-label">原文输入</p>
                <textarea v-model="chapter" rows="10" placeholder="粘贴小说章节原文…" @change="st.saveChapter(chapter)"></textarea>
              </div>
              <div class="script-col">
                <!-- 小字区标 + 节奏体检卡（2026-10-13 Dragon）：StageShots 把**节奏体检卡**（`.pace-card`）
                     Teleport 到右栏这里 —— 目标时长 T 是**上游输入**（它决定镜数 N），该在写剧本时就设。
                     🔴 这是目标时长的**唯一入口**：项目配置弹窗里那个同名输入已于同日删除
                        （见下方 proj-grid 里的说明），避免一个概念两处并存。
                     🔴 落点必须是 .zone-label 的**兄弟节点**，不能塞进 <p class="zone-label"> 里 ——
                        verify3 断言 .zone-label 的文本**恰好**是 ['原文输入','AI 优化稿']，
                        塞进去会让它变成「AI 优化稿95」这种脏串（同时还会破坏它的字号断言）。 -->
                <div class="zone-label-row">
                  <p class="zone-label">AI 优化稿</p>
                  <span id="adapt-pace" style="display:inline-flex;align-items:center;min-width:0"></span>
                </div>
                <stage-adapt />
              </div>
            </div>
          </div>
        </section>

        <!-- 块2：角色 & 场景（无锁定，随时可编辑；上游变化由脏标记提示） -->
        <section class="stage" :class="blkCls(3)" :key="stageKey('chars')" data-nav="2">
          <div class="stage-head">
            <span class="s-num">2</span>
            <span class="s-title">角色 &amp; 场景</span>
            <span style="flex:1"></span>
            <span class="head-sep"></span>
            <!-- 2026-09-27 三改（Dragon）：批量按钮回到模块标题栏右边（StageChars 通过 Teleport 挂进来） -->
            <span id="chars-batch" style="display:inline-flex;gap:8px;align-items:center"></span>
          </div>
          <div class="stage-body">
            <stage-chars />
          </div>
        </section>

        <!-- 块3：分镜脚本（列表化：每行从左到右 = 该镜头的分镜 | H3提示词 | 视频生成；
             无锁定；上游（改编稿/分镜/提示词/素材图）变化由 ⚠ 脏标记提示） -->
        <section class="stage" :class="blkCls(2, 4, 5)" :key="stageKey('shots')" data-nav="3">
          <div class="stage-head">
            <span class="s-num">3</span>
            <span class="s-title">分镜脚本</span>
            <!-- 分镜总时长落点（2026-10-13，Dragon）：StageShots 把「所有镜头 dur 合计」Teleport 到这里，
                 实时跟随编辑。行头那颗「分镜 X」后面的单镜秒数已删除 —— 汇总放模块标题、明细在编辑区，
                 同一屏不重复两遍。 -->
            <span id="shots-total" style="display:inline-flex;align-items:center"></span>
            <span style="flex:1"></span>
            <span class="head-sep"></span>
            <!-- 声音档位开关落点（2026-10-20，Dragon）：模块级唯一实例 —— 一个开关控制本集全部镜头的
                 BGM / 环境音。🔴 绝不能放进每行的 .row-head（那里每镜渲染一次 = N 个开关）。
                 紧挨批量按钮：切完档 → 批量按钮变琥珀（签名变了）→ 一键重做，动线一条直线。 -->
            <span id="shots-audio" style="display:inline-flex;align-items:center"></span>
            <!-- 批量按钮落点：StageShots 通过 Teleport 把「批量生成提示词 / 批量生成视频」挂到这里（2026-09-27 三改：回到标题栏右边，按钮恢复普通 .btn 样式） -->
            <span id="shots-batch" style="display:inline-flex;gap:8px;align-items:center"></span>
          </div>
          <div class="stage-body">
            <stage-shots />
          </div>
        </section>

        <!-- 块4：组装成片（进入即自动组装） -->
        <section class="stage" :class="blkCls(6)" :key="stageKey('export')" data-nav="4">
          <div class="stage-head">
            <span class="s-num">4</span>
            <span class="s-title">组装成片</span>
            <!-- 镜头数与总时长（2026-10-20，Dragon）：靠左显示「共 N 个镜头 · 共 X 分 Y 秒」。
                 StageExport 通过 Teleport 挂到这里，实时跟随分镜增删与 dur 编辑。 -->
            <span id="export-stats" style="display:inline-flex;align-items:center"></span>
            <span style="flex:1"></span>
            <span class="head-sep"></span>
            <!-- 2026-09-27：输出分辨率 / 添加字幕 / 导出成片 移到标题栏靠右（StageExport 通过 Teleport 挂到 #export-ops） -->
            <span id="export-ops" style="display:inline-flex;gap:10px;align-items:center"></span>
          </div>
          <div class="stage-body">
            <stage-export />
          </div>
        </section>
      </div>
    </div>

    <!-- 工作台右侧悬浮导航（2026-10-19 Dragon）：只在工作台出现，
         四项 = 上面的四块卡片；有生成任务在跑的块 → 名称右侧闪烁绿点。 -->
    <app-nav-rail v-if="st.view==='dash' && st.current" />

    <!-- 图片生成独立功能页（Qwen-Image 2.1：文生图 / 原生编辑 / 图生图）
         🔴 常驻挂载（v-show），不参与上面那条 v-if/v-else-if 链：切菜单只 display:none 不销毁，
            参数 / 参考图 / 本次结果 / 正在跑的任务都留在组件实例里 → 切走再回来还在生成、结果还在
            （2026-10-17 用户反馈「切到其他菜单任务就自动停止」的根因 = 原来走 v-else-if，组件被销毁）。 -->
    <div class="content ig-content" v-show="st.view==='imggen'">
      <image-gen ref="imagegen" />
    </div>

    <!-- 视频生成独立功能页（MiniMax H3：文生视频 / 参考生视频 / 首尾帧）
         🔴 常驻挂载（v-show），与图片生成同理：切菜单不销毁组件、任务跑在任务中心不中断。 -->
    <div class="content vg-content" v-show="st.view==='vidgen'">
      <video-gen ref="videogen" />
    </div>

    <!-- 项目角色场景库视图（不属于任何一集：左树点库条目进来，改的是全项目共享的库）。
         🔴 常驻挂载（v-show），与图片生成/工作台同理：库有「批量生成提示词 / 批量生成图片」，
            切菜单不销毁组件实例，批量任务不被打断。
         标题行 = 库视图的模块头（对齐块 2 的角色&场景：标题 + 右侧条目数与批量按钮落点） -->
    <div class="content" v-show="st.view==='lib'">
      <div class="lib-head">
        <span class="lh-title">项目角色场景库</span>
        <span class="lh-sub">跨集共享的角色 / 场景条目 —— 布局与「角色 &amp; 场景」一致</span>
        <span style="flex:1"></span>
        <span id="lib-count" style="display:inline-flex;align-items:center"></span>
        <span id="lib-batch" style="display:inline-flex;gap:8px;align-items:center"></span>
      </div>
      <stage-library />
    </div>

    <!-- 运行日志（底部可折叠抽屉） -->
    <log-panel />

    <div class="statusbar">
      <span>阶段：{{ st.view==='dash' ? blockPos + '/4' : '—' }}</span>
      <span class="sb-sep"></span>
      <!-- 推理服务 -->
      <span class="sbc" :class="st.health && st.health.llm ? 'on' : 'off'" title="LLM 推理服务（llama-server）">LLM</span>
      <span class="sbc" :class="st.health && st.health.comfyui ? 'on' : 'off'" title="ComfyUI（角色出图 / 视频生成）">ComfyUI</span>
      <span class="sbc" :class="st.health && st.health.ffmpeg ? 'on' : 'off'" title="ffmpeg（合成成片与字幕）">ffmpeg</span>
      <span class="sb-sep"></span>
      <!-- 模型就位情况（底模 / H3 等，悬停看文件名与缺失原因） -->
      <span v-for="m in statusModels" :key="m.key" class="sbc" :class="m.ok ? 'on' : 'off'" :title="modelTip(m)">
        {{ m.short || m.key }}<b v-if="m.ok">{{ m.count }}</b>
      </span>
      <span v-if="pl.totalMs">累计耗时：{{ fmtMs(pl.totalMs) }}</span>
      <span style="flex:1"></span>
      <span class="sb-path" :title="'工作区：' + (st.workspace || '')">{{ st.workspace }}</span>
      <span class="sb-log" :class="{on: logs.open}" @click="logs.toggle()">
        运行日志<b v-if="logs.unreadErr" class="sb-badge">{{ logs.unreadErr > 99 ? '99+' : logs.unreadErr }}</b>
      </span>
      <span>v0.3.2-m6</span>
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
            ? '设置项目级风格与分辨率，作为本项目下新建剧集的初始配置'
            : projModal.name + ' · 风格与分辨率' }}</p>
        </div>
      </div>

      <input v-if="projModal.mode === 'create'" class="proj-name" type="text" v-model="projModal.name"
             placeholder="项目名称" @keyup.enter="confirmProj" />

      <!-- 视频质量 / 视频比例（2026-10-15；2026-10-21 改版：三档 × A/B 方案 + 分辨率并进比例文案）：
           质量与比例是**上游两个输入**，选完档位后，推荐画布分辨率自动拼到「视频比例」选项标题上（如「横版 16:9 · 864×480」）。
           推荐画布不在前端硬编码 —— 随档位表由主进程 tierCanvas 下发（见 stores/project.js 的 recCanvas）。 -->
      <div class="proj-grid">
        <div class="proj-row col">
          <span class="proj-kind">视频质量</span>
          <div class="tier-group-list">
            <div class="tier-group" v-for="g in tierGroups" :key="g.base">
              <div class="tier-group-head">{{ g.a ? g.a.label.replace(/[AB]$/, '') : g.base }}</div>
              <div class="tier-ab-row">
                <button type="button" v-if="g.a"
                        class="popt tier-ab" :class="{on: projModal.tier === g.a.key}"
                        :data-tier="g.a.key" @click="pickTier(g.a.key)">
                  <span class="tier-ab-rec" v-if="!vramRecommendB">推荐</span>
                  <b class="tier-ab-name">剪枝版</b>
                  <span class="tier-ab-desc">{{ g.a.desc }}</span>
                </button>
                <button type="button" v-if="g.b"
                        class="popt tier-ab" :class="{on: projModal.tier === g.b.key}"
                        :data-tier="g.b.key" @click="pickTier(g.b.key)">
                  <span class="tier-ab-rec" v-if="vramRecommendB">推荐</span>
                  <b class="tier-ab-name">原始版</b>
                  <span class="tier-ab-desc">{{ g.b.desc }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <!-- 加速优化开关（全局，2026-10-21）：INT8 注意力 + BlockCache，默认开。画面可能有轻微差异 -->
        <div class="proj-row accel-row">
          <span class="proj-kind">加速优化</span>
          <button type="button" class="accel-toggle" :class="{on: accelOn}" @click="toggleAccel">
            <span class="accel-knob"></span>
          </button>
          <span class="accel-label">{{ accelOn ? '已开启（约省 30%，画面可能有轻微差异）' : '已关闭（画面更稳定）' }}</span>
        </div>
        <div class="proj-row col">
          <span class="proj-kind">视频比例</span>
          <div class="popt-grid proj-aspect-grid">
            <button type="button" v-for="a in st.aspectOptions" :key="a.id"
                    class="popt" :class="{on: projModal.aspect === a.id}"
                    :data-aspect="a.id" @click="pickAspect(a.id)">
              <b>{{ a.label }}<em class="aspect-res" v-if="aspectResLabel(a.id)">{{ aspectResLabel(a.id) }}</em></b>
              <span v-if="a.desc">{{ a.desc }}</span>
            </button>
          </div>
        </div>
        <!-- 🔴 2026-10-13：此处原来的「单集目标时长」输入**已删除**（用户要求）。
             它是「本集要铺多长」这个**上游输入**的入口，但同一份数据（projects.target_sec）
             在剧本创作页已有更好的落点 —— 右栏「AI 优化稿」旁的**节奏体检卡**（`.pace-card`，
             StageShots 用 Teleport 挂过去），那里还能同时看见「B 个画面单元 → N* 镜」的推导结果。
             原则：**一个概念只留一个入口**，两处并存时用户改哪边都不确定哪边生效。
             ⚠️ 保存项目配置时**不再提交** targetSec —— 主进程 setProjectRes 是 COALESCE 语义
             （缺字段 = 保留原值），所以弹窗保存**不会**把节奏卡设好的时长清零。
             新建项目落到 DB 默认值 0（不启用双轨配时），与存量项目一致。 -->
      </div>
      <div class="proj-grid proj-grid-style">
        <!-- 风格 = 四轴：画面风格 × 世界设定 × 内容体裁 × 制作调性（项目级）。
             规范正文里的题材词随它们替换；四轴各管一件事，组合起来才是这部片子的风格。
             🔴 2026-10-07：四轴由「下拉」改为「点选网格」（点一下即选中）——
             轴选项自带 label + desc，卡片能把「这一轴有哪几个选择、各自是什么」一次摊开；
             下拉只能看见当前那一个词，用户得逐个展开才知道还有什么。
             🔴 2026-10-08：第三轴之后新增「制作调性」（电影感 / 商业广告大片 / 纪实 / 时尚杂志 / 剧集质感）——
             它管的是「拍成什么档次」（光影要求 / 调色 / 构图守则 / 英文调性词），
             与「世界」正交：同一个世界既能拍纪实质感，也能拍商业广告大片。
             `.proj-style-*` 四个类名保留在网格容器上（外部按它定位），单个选项靠 `data-opt`。 -->
        <div class="proj-row col">
          <span class="proj-kind">{{ st.axisLabel('render') }}</span>
          <div class="popt-grid proj-style-render">
            <button type="button" v-for="o in st.axisOptions('render')" :key="o.id"
                    class="popt" :class="{on: projModal.render === o.id}"
                    :data-opt="o.id" @click="projModal.render = o.id">
              <b>{{ o.label }}</b>
              <span v-if="o.desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>
        <div class="proj-row col">
          <span class="proj-kind">{{ st.axisLabel('world') }}</span>
          <div class="popt-grid proj-style-world">
            <button type="button" v-for="o in st.axisOptions('world')" :key="o.id"
                    class="popt" :class="{on: projModal.world === o.id}"
                    :data-opt="o.id" @click="projModal.world = o.id">
              <b>{{ o.label }}</b>
              <span v-if="o.desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>
        <div class="proj-row col">
          <span class="proj-kind">{{ st.axisLabel('genre') }}</span>
          <div class="popt-grid proj-style-genre">
            <button type="button" v-for="o in st.axisOptions('genre')" :key="o.id"
                    class="popt" :class="{on: projModal.genre === o.id}"
                    :data-opt="o.id" @click="projModal.genre = o.id">
              <b>{{ o.label }}</b>
              <span v-if="o.desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>
        <div class="proj-row col">
          <span class="proj-kind">{{ st.axisLabel('tone') }}</span>
          <div class="popt-grid proj-style-tone">
            <button type="button" v-for="o in st.axisOptions('tone')" :key="o.id"
                    class="popt" :class="{on: projModal.tone === o.id}"
                    :data-opt="o.id" @click="projModal.tone = o.id">
              <b>{{ o.label }}</b>
              <span v-if="o.desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>
      </div>
      <p class="proj-hint warn" v-if="projMismatch()">{{ projMismatch() }}</p>
      <p class="proj-hint" v-if="projStyleDesc()">{{ projStyleDesc() }}</p>
      <p class="proj-hint warn" v-if="projStyleIssue()">{{ projStyleIssue() }}</p>

      <div class="proj-note">
        {{ projModal.mode === 'create'
          ? '风格与视频质量影响本项目所有剧集；分辨率仅作为新建剧集的初始值。'
          : '⚠ 风格与视频质量会立即影响所有剧集；分辨率改动只作用于之后新建的剧集。' }}
      </div>

      <div class="row">
        <button class="btn ghost" @click="projModal = null">取消</button>
        <button class="btn" @click="confirmProj">{{ projModal.mode === 'create' ? '创建项目' : '保存' }}</button>
      </div>
    </div>
  </div>

  <!-- 媒体/工件预览弹窗：左侧树里点角色图 / 镜头视频 / 成片 → 独立弹窗预览；
       点「剧本」节点下的工件 → 同一弹窗走文本预览（kind='text'） -->
  <div class="mask" :class="{hidden: !preview}" @click.self="preview = null">
    <div class="dialog media-dialog" v-if="preview">
      <div class="md-head">
        <div class="md-title">
          <b>{{ preview.file }}</b>
          <span class="md-sub">{{ preview.sub }}</span>
        </div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" v-if="preview.episodeId" @click="openPreviewEpisode">打开本集</button>
        <button class="btn ghost sm" v-if="preview.path" @click="revealMedia">所在文件夹</button>
        <button class="btn ghost sm" @click="preview = null">关闭</button>
      </div>
      <div class="md-body" :class="{'text-body': preview.kind === 'text'}">
        <template v-if="preview.kind === 'text'">
          <pre v-if="preview.text" class="md-text">{{ preview.text }}</pre>
          <div v-else class="md-loading"><i class="spin"></i> 加载中…</div>
        </template>
        <template v-else>
          <div v-if="!preview.src" class="md-loading"><i class="spin"></i> 加载中…</div>
          <img v-else-if="preview.kind === 'image'" :src="preview.src" @load="onPreviewLoad" />
          <video v-else :src="preview.src" controls autoplay loop></video>
        </template>
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
import StageLibrary from './StageLibrary.vue'
import StageExport from './StageExport.vue'
import AppNavRail from './AppNavRail.vue'
import PromptsView from './PromptsView.vue'
import ImageGen from './ImageGen.vue'
import VideoGen from './VideoGen.vue'
import LogPanel from './LogPanel.vue'
import { clearStylePack } from './prompts.js'
import { igState } from './imggenState.js'
import { vgState } from './vidgenState.js'
import { taskState } from './taskState.js'
import { state as taskCenterState } from './taskCenter.js'
import { mediaUrl } from './mediaUrl.js'
import { moduleStale, ackModule, MODULE_STALE_KINDS } from './stale.js'

export default {
  components: { FolderNode, SettingsPanel, StageAdapt, StageShots, StageChars, StageLibrary, StageExport, AppNavRail, PromptsView, ImageGen, VideoGen, LogPanel },
  data() {
    return {
      chapter: '',
      igState,               // 图片生成任务跨页可见状态（侧栏小圆点用，见 imggenState.js）
      vgState,               // 视频生成任务跨页可见状态（侧栏小圆点用，见 vidgenState.js）
      taskState,             // 分镜/库等后台任务跨页可见状态（侧栏闪烁小点用，见 taskState.js）
      taskCenterState,       // 任务中心全局状态（侧栏闪点按类型读 activeByType）
      sideCollapsed: false,   // 左侧菜单栏收起态（窄条只留展开按钮）
      projModal: null,   // 项目配置弹窗 {mode:'create'|'edit', id, name, img, vid, out}
      accelOn: true,     // 加速优化开关（全局）：INT8 注意力 + BlockCache，默认开
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
    /** 分镜模块是否有后台任务在跑：任务中心里的视频任务 + 组件内的提示词/单镜任务。
     *  🔴 直接读模块级 taskCenterState（import 的 reactive 单例），不经过 data 的 this.taskCenterState——
     *     data 里放 reactive 对象会被 Vue 二次包装，读 this.xxx.activeByType 的依赖追踪可能失效。 */
    shotsBusy() {
      return !!(taskCenterState.activeByType.video || this.taskState.shots.busy)
    },
    /** 活跃任务按集聚合：{ [episodeId]: [task,...] }。🔴 直接读模块级 taskCenterState（reactive 单例），
     *  避免 data 二次包装导致依赖追踪失效。 */
    activeTasksByEpisode() {
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
    },
    /** 项目角色场景库是否有后台任务在跑 */
    libBusy() { return !!this.taskState.lib.busy },
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
    /**
     * 视频质量档位按「档」分组（2026-10-21）：tierOptions 里 a/b 两两成对（fasta/fastb…），
     * 视觉上折叠成 3 档，每档内 A（≤16G）/ B（>16G）两个方案左右并排。
     * 分组依据：key 去掉尾部 a/b 后同名前缀归一组，按 tierOrder 顺序（天然 a、b 相邻）扫描配对。
     * @returns {Array<{base, a:{key,label,desc}, b:{key,label,desc}}>}
     */
    tierGroups() {
      const opts = this.st.tierOptions || []
      const groups = []
      const seen = new Set()
      for (const t of opts) {
        if (seen.has(t.key)) continue
        const m = /^(.*?)([ab])$/.exec(t.key)
        if (!m) { groups.push({ base: t.key, a: { key: t.key, label: t.label, desc: t.desc }, b: null }); continue }
        const base = m[1]
        const other = opts.find(x => x.key === base + (m[2] === 'a' ? 'b' : 'a'))
        const a = m[2] === 'a' ? t : other
        const b = m[2] === 'a' ? other : t
        seen.add(t.key); if (other) seen.add(other.key)
        groups.push({
          base,
          a: a ? { key: a.key, label: a.label, desc: a.desc } : null,
          b: b ? { key: b.key, label: b.label, desc: b.desc } : null
        })
      }
      return groups
    },
    /**
     * 本机显卡显存总量（GB）。拿不到（非 NVIDIA / nvidia-smi 不可用）返回 null。
     * 用现有 metrics 快照 `this.m.gpu.totalMiB`，不额外探测。
     */
    vramTotalGB() {
      const g = this.m && this.m.gpu
      if (!g || !g.ok || g.totalMiB == null) return null
      return g.totalMiB / 1024
    },
    /** 是否推荐 B 方案（显存 > 16G）；显存未知时推荐 A（16G 以下方案是通用安全默认）。 */
    vramRecommendB() {
      const v = this.vramTotalGB
      return v != null && v > 16
    },
    /**
     * 状态栏模型胶囊：只显示「目录 / 引擎」级项。
     * 方案逐槽位的明细（Z主模 / Z编码 / H3主模型 / LoRA…）放在设置页的模型检测里，
     * 状态栏只留目录级，避免同一个文件在胶囊上重复出现两次。
     */
    statusModels() {
      return (this.st.models.items || []).filter(m => m.group !== 'asset')
    },
    /** 库编辑区当前所属项目名（面包屑用） */
    libProject() {
      const t = this.st.libTarget
      if (!t) return ''
      const p = this.st.tree.find(x => x.id === t.projectId)
      return p ? p.name : ''
    },
    /** 提示词配置中心当前所属项目名（面包屑用） */
    promptProject() {
      const t = this.st.promptTarget
      if (!t) return ''
      const p = this.st.tree.find(x => x.id === t.projectId)
      return p ? p.name : ''
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
        text: util + '%',
        sub: g.tempC != null ? g.tempC + '℃' : '',
        pct: util,
        cls: util >= 90 ? 'hot' : '',
        title: g.name + '｜GPU 算力占用 ' + util + '%｜显存 ' + used + ' / ' + total + ' GB（' + memPct + '%）'
          + (procs ? '｜显存占用：' + procs : '｜当前无进程占用显存')
      }
    },
    /** 显存使用率（2026-09-29 Dragon：从 GPU 胶囊拆出来单独显示） */
    vramView() {
      const g = this.m && this.m.gpu
      if (!g || !g.ok || g.memPercent == null) {
        return { text: '—', sub: '', pct: 0, cls: 'off', title: '未检测到 NVIDIA 显卡（或 nvidia-smi 不可用）' }
      }
      const used = (g.usedMiB / 1024).toFixed(1)
      const total = (g.totalMiB / 1024).toFixed(1)
      return {
        text: g.memPercent + '%',
        sub: used + '/' + Math.round(g.totalMiB / 1024) + 'G',
        pct: g.memPercent,
        cls: g.memPercent >= 92 ? 'hi' : '',
        title: '显存 ' + used + ' / ' + total + ' GB（' + g.memPercent + '%）'
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
        text: mm.percent + '%',
        sub: used + '/' + Math.round(mm.total / 1024 / 1024 / 1024) + 'G',
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
    // 加速优化开关：读全局设置（'0' = 关，缺省/其他 = 开）
    window.studio.getSetting('h3.attentionBoost').then(v => {
      this.accelOn = String(v || '').trim() !== '0'
    }).catch(() => {})
    // 实时系统指标
    this._offMet = window.studio.onMetrics(s => { this.m = s })
    window.studio.metricsOnce().then(s => { if (s) this.m = s }).catch(() => {})
    // 每秒推进一次，驱动「进行中」阶段的实时计时
    this._tickTimer = setInterval(() => this.pl.tickLive(), 1000)
    // 每 5s 轮询一次 llama / ComfyUI 真实健康状态（标题栏胶囊实时准确）
    this._healthTimer = setInterval(() => this.st.refreshHealth(), 5000)
    // 窄窗口折叠指标文字（2026-09-29：指标拆成 4 个后整体更宽，阈值 1400 → 1500）
    this._offResize = () => { this.narrow = window.innerWidth < 1500 }
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
    // 图片生成/视频生成页是常驻挂载（v-show）的，没有 mounted 时机可依赖 → 每次切回来手动刷一次历史，
    // 免得「上次在别处生成的图/视频（或外部拷进来的）不出现」
    'st.view'(v) {
      if (v === 'imggen') {
        const c = this.$refs.imagegen
        if (c && c.onShow) c.onShow()
      } else if (v === 'vidgen') {
        const c = this.$refs.videogen
        if (c && c.onShow) c.onShow()
      }
    },
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
    /** 某一集是否有活跃视频任务（模板用；读上面的响应式聚合，避免漏渲染）。
     *  🔴 带参数 → 必须是 method，不能放 computed（computed 是无参 getter，放错会「not a function」报错导致整树卸载）。 */
    episodeHasVideoTask(episodeId) {
      if (episodeId == null) return false
      const list = this.activeTasksByEpisode[String(episodeId)]
      return !!(list && list.some(t => t.type === 'video'))
    },
    /** 某项目下（含子文件夹）是否有任何集有活跃任务（项目节点汇总闪点用）。
     *  🔴 必须走 episodeHasVideoTask（读响应式聚合），否则提交任务后项目节点闪点不刷新。 */
    projectHasTask(p) {
      const scan = (folders) => {
        for (const f of folders || []) {
          for (const e of f.episodes || []) if (this.episodeHasVideoTask(e.id)) return true
          if (scan(f.folders)) return true
        }
        return false
      }
      for (const e of p.episodes || []) if (this.episodeHasVideoTask(e.id)) return true
      return scan(p.folders)
    },
    /** 当前「档位 + 比例」的推荐画布文案（如「864×480」），拼在视频比例选项标题上。
     *  取不到（档位/比例未声明画布）返回空串 → 不显示。
     *  🔴 必须是 method（带参数），不能放 computed —— computed 是无参 getter，
     *     放错会导致「aspectResLabel is not a function」运行时错误 → 整组件渲染失败黑屏。 */
    aspectResLabel(aspectId) {
      const m = this.projModal
      if (!m) return ''
      const c = this.st.recCanvas(m.tier, aspectId)
      return c ? c.replace(/x/gi, '×') : ''
    },
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
      // 首屏「启动中」到此结束：各模块从「正在加载…」切到真正的空态文案（2026-10-19）
      this.st.booted = true
      // 启动即把「当前集所属项目」展开并拉一遍媒体：左边菜单打开就有内容，
      // 不再出现「软件刚打开时左侧是空的、得逐个点开才看到」的情况
      const cur = this.st.current
      if (cur && cur.projectId) {
        this.st.expanded.add('p' + cur.projectId)
        try {
          await Promise.all([
            this.st.loadAssets(cur.projectId, true),
            this.st.loadShots(cur.projectId, true),
            this.st.loadFilms(cur.projectId, true),
            this.st.loadLibrary(cur.projectId, true)
          ])
        } catch (_) { /* 预加载失败不影响启动 */ }
      }
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
    /** 点击脏标签 → 消除（不重新生成也消失）；quiet 用于「点生成按钮」时静默收掉琥珀色 */
    async ackHead(kind, quiet) {
      await ackModule(this.st, kind)
      if (!quiet) this.toast('提示已消除')
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
      // 2026-10-19：点「改编」= 接受按新章节重做 → 按钮立刻褪掉琥珀色（不等 LLM 跑完）
      if (this.headStale('adapt')) await this.ackHead('adapt', true)
      this.pl.confirm(0, this.st.current.id)
      this.pl.autoAdapt = true
      this.toast('已确认原文，正在自动改编…')
    },
    /** 新建项目：弹窗里一并定**视频质量 + 视频比例 + 三个分辨率** + 风格四轴（都是项目级）。
     *  2026-10-15：三个分辨率不再是「下拉第一项」，而是「档位 + 比例」的**推荐值** ——
     *  画布必须与该档位实际挂的加速模型训练分辨率匹配，否则镜头构图会漂到全景（2026-10-15 实测）。 */
    newProject() {
      const ax = this.st.defaultAxes()
      const tier = this.st.defaultTier()
      const aspect = '16:9'
      const rec = this.st.recRes(tier, aspect)
      // 兜底：档位表没声明画布（老方案 / 加载未完成）时退回「该比例下下拉的第一项」
      const fb = (kind, dv) => ((this.st.resOptsFor(kind, aspect) || [])[0] || {}).value || dv
      this.projModal = {
        mode: 'create', id: null, name: '',
        img: rec ? rec.img : fb('img', '1920x1080'),
        vid: rec ? rec.vid : fb('vid', '864x480'),
        out: rec ? rec.out : fb('out', 'auto'),
        tier, aspect,
        /** 用户手动改过哪个分辨率 —— 联动（改档位 / 改比例）就不再覆盖它，避免把用户的选择冲掉 */
        touched: { img: false, vid: false, out: false },
        render: ax.render, world: ax.world, genre: ax.genre, tone: ax.tone,
        styleOld: ''
      }
    },
    /** 项目配置：读项目当前三项 + 视频档位 + 比例 + 风格四轴；分辨率改了只影响之后新建的剧集，
     *  档位与风格立即生效（风格决定提示词规范里的题材词，见 prompts.js 的 readPrompt） */
    openProjCfg(pid) {
      const p = this.st.tree.find(x => x.id === pid)
      if (!p) return
      const r = p.res || {}
      const old = r.style || this.st.defaultStyle()
      const tri = this.st.parseTriple(old)
      // 某个轴值已经不存在了（风格包被删/改名）→ 该轴先退回清单第一项，免得下拉显示空白；
      // 但是否真的改掉由用户点保存决定（projStyleIssue 会明确提示"原来用的 X 已不存在"）
      const fix = (ax) => this.st.axisOptions(ax).some(x => x.id === tri[ax])
        ? tri[ax] : ((this.st.axisOptions(ax)[0] || {}).id || tri[ax])
      // 🔴 2026-10-15 比例：主端 readRes 已对存量项目按 res_vid 宽高推断好（aspect 列可空），
      //    这里再兜一层推断，纯前端刷新（不落库）时也不会把比例显示成空。
      const tier = r.tier || this.st.defaultTier()
      const aspect = r.aspect || this.st.aspectOfRes(r.vid)
      const rec = this.st.recRes(tier, aspect) || {}
      // 2026-10-21：img/vid 已锁定 = 档位推荐值，打开配置弹窗时强制对齐推荐（老项目旧值作废）。
      //   out 仍是可手改的，按「与推荐值不同 = 自定义」判断 touched。
      const img = (rec.img) || r.img || '1920x1080'
      const vid = (rec.vid) || r.vid || '864x480'
      const out = r.out || 'auto'
      this.projModal = {
        mode: 'edit', id: pid, name: p.name,
        img, vid, out, tier, aspect,
        /** 与推荐值不同 = 这一项历史上就是自定义的 → 视作 touched，改档位 / 改比例时不动它。
         *  否则（例如老项目恰好等于推荐值）就跟默认值一样参与联动。
         *  🔴 img/vid 已锁定，不再参与 touched（恒 false）。 */
        touched: {
          img: false,
          vid: false,
          out: !!rec.out && out !== rec.out
        },
        render: fix('render'), world: fix('world'), genre: fix('genre'), tone: fix('tone'),
        styleOld: old
      }
    },
    /* ---------------- 视频质量 / 比例 / 三分辨率联动（2026-10-15）----------------
     * 规则：质量与比例是上游两个输入，任一变化 → 把「档位+比例」的推荐值写回**用户没手动改过**的字段。
     * 手动改过的字段（touched）保持不动，旁边给「恢复推荐」。 */

    pickTier(key) {
      const m = this.projModal
      if (!m || m.tier === key) return
      m.tier = key
      this.applyRec()
    },
    /** 加速优化开关（全局）：INT8 注意力 + BlockCache。切换立即写设置，对所有档位/项目生效 */
    toggleAccel() {
      this.accelOn = !this.accelOn
      window.studio.setSetting('h3.attentionBoost', this.accelOn ? '1' : '0').catch(() => {})
    },
    pickAspect(a) {
      const m = this.projModal
      if (!m || m.aspect === a) return
      m.aspect = a
      this.applyRec()
    },
    /** 写回推荐值（2026-10-21：img/vid 已锁定 → 强制 = 推荐值，不再看 touched；out 仍按 touched 联动） */
    applyRec() {
      const m = this.projModal
      if (!m) return
      const rec = this.st.recRes(m.tier, m.aspect)
      if (!rec) return
      if (rec.img) m.img = rec.img
      if (rec.vid) m.vid = rec.vid
      if (rec.out && !m.touched.out) m.out = rec.out
    },
    /** 手动改分辨率：只标记 touched，互不联动。
     *  🔴 图片分辨率与视频分辨率是各自独立的 —— 用户手动改其中一个，另一个不动。
     *     只有「选视频质量 / 选比例」才会自动带出三个推荐值（见 pickTier / pickAspect → applyRec）。 */
    onResPick(kind) {
      const m = this.projModal
      if (!m || !m.touched) return
      m.touched[kind] = true
    },
    /** 当前值是否就是推荐值（决定显示「推荐」角标） */
    isRec(kind) {
      const m = this.projModal
      if (!m) return false
      const rec = this.st.recRes(m.tier, m.aspect)
      return !!rec && !!rec[kind] && m[kind] === rec[kind]
    },
    touched(kind) {
      const m = this.projModal
      return !!(m && m.touched && m.touched[kind])
    },
    /** 「恢复推荐」：取消 touched 并写回推荐值 */
    restoreRec(kind) {
      const m = this.projModal
      if (!m || !m.touched) return
      m.touched[kind] = false
      const rec = this.st.recRes(m.tier, m.aspect)
      if (rec && rec[kind]) m[kind] = rec[kind]
    },
    /** 画面尺寸与该视频质量不搭配时的提醒（只讲后果，不堆技术名词） */
    projMismatch() {
      const m = this.projModal
      if (!m) return ''
      // 判据：是否在该档位「可接受」的尺寸清单里（而非等于推荐值）—— 相邻两档实际都正常，误报会让人白折腾。
      const acc = this.st.canvasAccept(m.tier)
      if (!acc || !acc.length || !m.vid || acc.indexOf(m.vid) >= 0) return ''
      const rec = this.st.recCanvas(m.tier, m.aspect)
      return '⚠ 当前画面尺寸与所选视频质量不搭配，可能让人物变小、画面不完整。建议改回 ' +
        (rec ? rec.replace('x', '×') : '推荐尺寸') + '，或换一个视频质量。'
    },
    /** 风格一句话摘要（四轴卡片已展开全部说明，这里只给一句紧凑总结，不重复长说明） */
    projStyleDesc() {
      const m = this.projModal
      if (!m) return ''
      const pre = this.st.presetNameOf({ render: m.render, world: m.world, genre: m.genre, tone: m.tone })
      if (pre) return '风格预设：' + pre
      const labels = ['render', 'world', 'genre', 'tone']
        .map(ax => (this.st.axisOptions(ax).find(x => x.id === m[ax]) || {}).label)
        .filter(Boolean)
      return labels.length ? labels.join(' · ') : ''
    },
    /**
     * 风格体系的警告（黄条）—— 两类：
     * ① 主进程报的结构性问题（风格包文件坏了 / 核心键缺失 / 世界没给某个画面风格备短语）；
     * ② 本项目原来用的风格已经解析不了了（styleOld 里的轴值不在清单里）。
     * 🔴 这些以前全都被悄悄吞掉（styles.errors() 是死代码），结果是「项目设的是 A 风格、
     *    实际出的是 B 风格」而用户毫不知情。必须显示出来。
     */
    projStyleIssue() {
      const m = this.projModal
      const iss = this.st.styleIssues || {}
      const msgs = []
      for (const x of (iss.errors || [])) msgs.push(x)
      for (const x of (iss.warnings || [])) msgs.push(x)
      if (m && m.mode === 'edit' && m.styleOld) {
        const miss = this.st.missingAxes(this.st.parseTriple(m.styleOld))
        if (miss.length) {
          msgs.push('本项目原来用的 ' + miss.join('、') + ' 已经不在可用清单里，下拉已退回默认值；' +
            '不改就会在保存时按现在选的生效')
        }
      }
      if (!msgs.length) return ''
      return '⚠ 风格配置需要注意：' + msgs.slice(0, 3).join('；') +
        (msgs.length > 3 ? '（还有 ' + (msgs.length - 3) + ' 条，详见日志面板）' : '')
    },
    async confirmProj() {
      const m = this.projModal
      if (!m) return
      const style = this.st.tripleId({ render: m.render, world: m.world, genre: m.genre, tone: m.tone })
      // 🔴 此处**不再提交 targetSec**（2026-10-13）：入口已收敛到剧本创作页的节奏体检卡。
      //    主进程 setProjectRes 走 COALESCE，缺字段 = 保留原值 → 保存项目配置不会把时长清零。
      const res = { img: m.img, vid: m.vid, out: m.out, tier: m.tier, aspect: m.aspect, style }
      if (m.mode === 'create') {
        const name = (m.name || '').trim()
        if (!name) { this.toast('请填写项目名称'); return }
        this.projModal = null
        await this.st.createProject(name, res)
        this.toast('已新建项目：' + name)
      } else {
        const before = ((this.st.tree.find(x => x.id === m.id) || {}).res || {}).style
        this.projModal = null
        await this.st.setProjectRes(m.id, res)
        if (before !== style) {
          // 换风格 → 渲染层的风格包缓存作废（下次读规范时按新风格重新取）
          clearStylePack()
          this.toast('已切换风格 —— 之后新生成的档案与提示词会按新风格写；已有的档案 / 提示词要重新生成才会变')
        } else {
          this.toast('已保存（分辨率只影响之后新建的剧集）')
        }
      }
    },
    /* ---- 左侧树：项目媒体节点（剧本 / assets / 分镜 / 成片），展开时才拉数据 ---- */
    /**
     * 展开/收起项目节点；展开时顺手把四类媒体都拉一遍。
     * 目的：项目一展开就能看到「几个剧本工件 / 多少张角色图 / 多少个镜头视频 / 几个成片」，
     * 不必逐个点开子节点（旧行为只在点子节点时才拉，所以刚打开软件时左边一片空白）。
     */
    async toggleProject(pid) {
      const key = 'p' + pid
      const wasOpen = this.st.expanded.has(key)
      this.st.toggleExpand(key)
      if (wasOpen) return
      await Promise.all([
        this.st.loadScripts(pid, true),
        this.st.loadAssets(pid, true),
        this.st.loadShots(pid, true),
        this.st.loadFilms(pid, true),
        this.st.loadLibrary(pid, true)
      ])
    },
    /** 展开/收起某个媒体节点：**每次展开都重新拉取**（功能区一生成，左边就跟上；缓存只避免收起期间的重复拉取） */
    async toggleMedia(kind, pid) {
      const key = { scripts: 'r', assets: 'a', shots: 's', films: 'f' }[kind] + pid
      const wasOpen = this.st.expanded.has(key)
      this.st.toggleExpand(key)
      if (wasOpen) return
      if (kind === 'scripts') await this.st.loadScripts(pid, true)
      else if (kind === 'assets') await this.st.loadAssets(pid, true)
      else if (kind === 'shots') await this.st.loadShots(pid, true)
      else await this.st.loadFilms(pid, true)
    },
    /* ---- 左侧树：项目角色场景库节点（跨集共享的角色/场景条目） ---- */
    /**
     * 点「📚 项目角色场景库」：展开/收起 + **打开右侧库编辑区**。
     * 🔴 必须能打开库编辑区：库为空时树里没有任何叶子可点，而「手动新增」按钮在库编辑区里——
     *    只靠点叶子进库，空库就永远进不去（死锁）。所以点节点本身也要切到 lib 视图。
     */
    async toggleLibrary(pid) {
      const key = 'L' + pid
      const wasOpen = this.st.expanded.has(key)
      this.st.toggleExpand(key)
      if (wasOpen) return
      await this.st.loadLibrary(pid, true)
      const cur = this.st.libTarget
      // 保留同项目已选中的条目；换项目/没选过则置空 id（库编辑区显示占位 + 左侧列表 + 新增按钮）
      if (!cur || cur.projectId !== pid) this.st.libTarget = { projectId: pid, id: '' }
      this.st.view = 'lib'
    },
    /** 库条目的两个分组（角色 / 场景） */
    libGroups(pid) {
      const es = this.st.libEntries(pid)
      return [
        { kind: 'character', label: '🧑 角色', items: es.filter(e => e.kind !== 'scene') },
        { kind: 'scene', label: '🏞 场景', items: es.filter(e => e.kind === 'scene') }
      ]
    },
    libEntryCount(pid) { return this.st.libEntries(pid).length },
    /** 点库条目 → 打开右侧库编辑区（切到 lib 视图，**不依赖当前集**） */
    async openLibEntry(pid, e) {
      await this.st.loadLibrary(pid)
      this.st.libTarget = { projectId: pid, id: e.id }
      this.st.view = 'lib'
    },
    /** assets 下的分组（角色名 / 场景名） */
    assetGroups(pid) {      const slot = this.st.media[pid]
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
    /** 打开预览弹窗：图片/视频都走 base64（渲染层不能直接读本地文件）。
         🔴 必须全程通过 this.preview（响应式代理）改字段：曾因持有原始对象改其字段 ——
         绕过代理的改动不触发渲染、且代理不等于原始对象导致提前 return → 弹窗永远停在「加载中」 */
    async openPreview(it, kind, label) {
      this.preview = { kind, file: it.file, path: it.path, sub: label || '', src: '' }
      const p = this.preview
      if (kind === 'video') {
        const bits = [label, ratioFromW(it.width, it.height)]
        if (it.durationSec) bits.push(it.durationSec.toFixed(1) + 's')
        if (it.size) bits.push(this.fmtSize(it.size))
        if (it.elapsedMs) bits.push('导出耗时 ' + fmtMs(it.elapsedMs))
        p.sub = bits.filter(Boolean).join(' · ')
      }
      try {
        // 图片：直接给协议 URL，不再把整张图读成 base64 再拼 data URL（2026-10-17）
        // —— 那条链要「同步读 + 33% 膨胀 + 跨进程拷贝 + 主线程拼串 + 整图解码」全走一遍，点开明显一顿。
        // 现在由 Chromium 自己流式读、缓存、异步解码，弹窗不再出现「加载中」空档。
        if (kind === 'image') { p.src = mediaUrl(it.path); return }
        const b64 = await window.studio.readFileBase64(it.path)
        // 期间可能已关掉/点了别的文件：比对当前弹窗指向，过期结果直接丢弃
        if (!this.preview || this.preview.file !== it.file || this.preview.path !== it.path) return
        this.preview.src = b64 ? 'data:video/mp4;base64,' + b64 : ''
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
    /** 打开「剧本」节点下的工件：复用媒体弹窗走文本预览（kind='text'）。
     *  读文件仍走已有的 readFileBase64（不新增 IPC），本地手写 UTF-8 解码（工件里有中文，
     *  不能让 atob 的 latin1 结果直接上屏）；.json 工件先美化再显示。 */
    async openScript(f, g) {
      const bits = [g && g.name, f.label]
      if (f.size != null) bits.push(this.fmtSize(f.size))
      if (f.mtimeMs) bits.push(new Date(f.mtimeMs).toLocaleString('zh-CN', { hour12: false }))
      this.preview = {
        kind: 'text', file: f.file, path: f.path, text: '',
        sub: bits.filter(Boolean).join(' · '),
        episodeId: (g && g.episodeId) || null
      }
      const p = this.preview
      try {
        const b64 = await window.studio.readFileBase64(f.path)
        // 期间可能已关掉/点了别的文件：比对当前弹窗指向，过期结果直接丢弃
        if (!this.preview || this.preview.path !== f.path) return
        let text = ''
        if (b64) {
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          text = new TextDecoder('utf-8').decode(bytes)
        }
        if (/\.json$/i.test(f.file)) {
          try { text = JSON.stringify(JSON.parse(text), null, 2) } catch (_) { /* 坏 JSON 就原样显示 */ }
        }
        if (!this.preview || this.preview.path !== f.path) return
        this.preview.text = text || '（文件是空的）'
      } catch (_) { /* 读取失败就停在上面的「加载中」 */ }
    },
    /** 剧本预览弹窗里的「打开本集」：关弹窗 → 切到该集（右侧进功能区） */
    openPreviewEpisode() {
      const id = this.preview && this.preview.episodeId
      this.preview = null
      if (id) this.st.openEpisode(id)
    },
    fmtSize(bytes) {
      const mb = bytes / 1024 / 1024
      return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB'
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
