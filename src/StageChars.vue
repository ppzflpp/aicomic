<template>
  <div>
    <div v-if="busy || shotsGening" class="progress"><div class="bar indeterminate"></div></div>
    <!-- 🔴 一条龙进度（2026-10-16 · Dragon「我要的所有的自动化」）：生成分镜之后自动跑那五步，
         在这里显示「跑到哪一步 / 正在处理谁」，并能中途停（与批量按钮的「停止」同口径：
         当前条目跑完即停，已完成的部分一律保留）。不跑时不占位（自动流程之外完全不可见）。 -->
    <div v-if="auto.on" class="autobar">
      <i class="spin"></i>
      <b>自动流程 {{ auto.n }}/{{ auto.total }}</b>
      <span class="astep">{{ auto.step }}<em v-if="auto.detail">{{ auto.detail }}</em></span>
      <button class="btn ghost xs" :disabled="auto.stop" @click="stopAuto()">停止</button>
    </div>

    <!-- 🔴 2026-10-19（Dragon：「打开软件时这块空白一会」）：启动期先给一句「正在加载」。
         两段时间会走到这里：① 首屏还没恢复上次的集（st.booted=false）；② 集已恢复、卡片正在构建。
         没有它的时候，这段就是**纯空白**（.placeholder 要求 cards 为空且非 busy，看着像卡死）。 -->
    <div v-if="(!st.booted || loadPending) && !cards.length" class="loading-hint"><i class="spin"></i>正在加载角色与场景…</div>
    <div v-else-if="!busy && !shotsGening && !cards.length" class="placeholder">确认分镜后，从分镜中自动提取角色与场景（含各自的档案与美术提示词）。</div>

    <!-- 单一网格：先摆角色、再摆场景，末尾常驻三张「新增入口」虚线卡；卡片左右结构（左：大图+档案 / 右：提示词 → 参数），无锁定随时可编辑
         脏标签（改编稿改过 → 建议重新出图）统一显示在本模块标题后面，见 App.vue 的 stage-head -->
    <div class="grp">
      <div class="char-grid">
        <!-- 同一主体的一组卡（`主体名--视角` 双横杠命名）靠**同一个组色的加粗边框**认亲（2026-10-08，Dragon）：
             第一版整组装进一个醒目大框，反馈「太丑」→ 撤掉；第二版把底色染成组色，反馈「背景还是要一样的」
             → 只留边框上色（底色回归角色蓝 / 场景紫）。
             色相 = hashName(主体名) 取 GROUP_HUES（8 档、每档相隔 45°）→ 同一个主体在任何会话 /
             任何项目里都是同一个颜色，而任意两组之间色差都拉得开（用户要求「不同组区别大点」）。
             🔴 `data-name` 是**测试用的稳定锚点**：视角浮层切到别的视角后，图上名称角标（.kind-tag-pos）
                的文本会跟着变成那张视角卡的名字 —— 靠角标文本找卡会找不到，一律用这个属性找。 -->
        <div v-for="it in ordered" :key="it.c.kind + '|' + it.c.name" class="ccard"
             :data-name="it.c.name"
             :class="[it.c.kind, { 'card-busy': it.c._gen, 'lib-ro': isLibRo(it.c), vgrp: grpHue(it.c) != null }]"
             :style="grpStyle(it.c)">
          <span v-if="it.c._gen" class="busy-txt"><i class="spin"></i>正在生成…</span>

          <!-- 左：大预览图（按原图比例完整显示）+ 图上角标（名称 / 定位 两枚独立徽标、分辨率） -->
          <div class="cleft">
            <div class="bigprev">
              <!-- 🔴 大图与图上的名称 / 分辨率 / 耗时角标一律取 `showCard(it.c)` —— 视角浮层里切到哪张，
                   这里就显示哪张（右栏的提示词同步跟着切）。别名 sc 走 `<template v-for>`
                   （Vue 模板没有 let 绑定，而下面要引用它十几次）。 -->
              <template v-for="sc in [showCard(it.c)]" :key="sc.name">
                <img v-if="selFile(sc)" :src="imgSrc(absOf(sc, selFile(sc)))"
                     :title="'点击放大预览（' + sc.name + '）'" @click="previewImg(sc)" />
                <div v-else class="ph">{{ sc.name[0] }}</div>
                <!-- 角标：名称、定位各一枚独立徽标（分开显示，不拼成一串）；**下面紧跟一行「分辨率 + 耗时」**。
                     场景卡的定位恒为「场景」（与卡片类型、下方「场景档案」标题重复）→ 只显示名称徽标。
                     🔴 2026-10-13 三改（Dragon「把分辨率与时长显示到主人公标签那行的下面」）：这两枚角标
                        原来贴在图片**下缘**（左下 / 右下），现改为一律放进 .kind-wrap 里、由 .kw-meta
                        独占一行 —— 名称行（.kw-top）/ 元信息行（.kw-meta）**竖排**成两行，不再靠
                        top/bottom 硬定位。
                        顺带解决两件事：① 视角浮层出现时不用再把角标抬高 56px；
                        ② 左下角原本与「库来源徽标」（.lib-badge，也在左下）叠在一起。 -->
                <div class="kind-wrap">
                  <span class="kw-top">
                    <span class="kind-tag-pos" :class="it.c.kind" :style="grpTagStyle(it.c)">{{ sc.name }}</span>
                    <span v-if="it.c.kind !== 'scene' && it.c.role" class="role-tag-pos" :class="it.c.kind">{{ it.c.role }}</span>
                    <!-- 派生视角卡（2026-10-08，Dragon）：**只在主体卡上出现** —— 名字里没有双横杠的卡才算主体卡，
                         视角子卡自己不再有入口（否则会派生出台 `V9X--正面--侧面` 这种语义不明的卡）。
                         点它弹出「主体名固定 + 只填视角名」的弹窗，用户不必知道双横杠约定，也不会撞名。
                         🔴 这里用 it.c 而不是 sc：这一格**是不是主体卡**由它自己决定，与正在看哪张图无关。 -->
                    <button v-if="!isLibRo(it.c) && isParentCard(it.c)" class="derive-btn" :disabled="busy"
                            title="给这张卡派生一张视角卡（正面 / 侧面 / 内饰…）：主体名固定，你只填视角名。新卡会自动与它相邻摆放、同一个颜色、共用档案。"
                            @click.stop="openDerive(it.c)">+</button>
                  </span>
                  <!-- 元信息行（🔴 靠 .kind-wrap 的 flex-direction:column 与 .kw-top **天然分成两行**，
                       不用 flex-basis:100% —— 绝对定位的收缩容器里百分比基准不确定，靠它换行会随内容飘）：
                       分辨率（原左下角）+ 出图耗时（原右下角）—— 两枚角标同款胶囊底、等宽字号。
                       🔴 一律取 sc 而不是 it.c：视角浮层切到哪张，这里显示的就是那张图的分辨率与耗时。 -->
                  <span class="kw-meta">
                    <span v-if="dimOf(sc)" class="dim-tag" title="当前预览图片的实际分辨率">{{ dimOf(sc) }}</span>
                    <span v-if="genText(sc)" class="gen-tag" :class="{ live: sc._genAt }"
                          title="这张卡的出图耗时">{{ genText(sc) }}</span>
                  </span>
                </div>
                <!-- 角色图「背景检查」角标已于 2026-10-08 按 Dragon 要求整体移除（提示太吵、误报多） -->
                <!-- 库来源徽标（🔴 卡级状态，用 it.c 不用 sc）：从项目库加载的卡（只读）／已同步到项目库的本地卡 -->
                <span v-if="isLibRo(it.c)" class="lib-badge ro"
                      title="这张卡来自项目角色场景库：文案、提示词、分辨率与出图都不在这里改（在左侧「项目角色场景库」里统一修改）。想改成本集专属版本，先「另存为本集变体」。">
                  📚 从项目库加载 · 禁止修改
                </span>
                <span v-else-if="it.c.libId" class="lib-badge ok"
                      title="这张卡是本集自己的副本，已同步到项目库；在这里改是改本集，点「更新到项目库」才会推回库（会影响引用该角色的其它集）。">
                  📚 已同步到项目库
                </span>
              </template>
              <!-- ============ 视角浮层（2026-10-13 二改，Dragon）============
                   **悬浮**在大预览图的**下缘**：第一张是主体卡自己那张（标「正面」），后面是本组全部视角卡。
                   点一张 → 大图**就地**换成那一张（上面那层 template 的 sc 随之变），
                   右栏的正向 / 负向提示词、抽卡记录一起跟着切 —— 即「看哪张图，就顺手改哪张的提示词」。
                   🔴 纯查看态：**不动物体卡的 cur**，所以「一键填充整组 / 存到项目 / 写入镜头」的
                      行为与改造前逐字一致（视角只影响「屏幕上在看哪张」）。
                   🔴 它取代了旧的「卡底视角条 + 卡内手风琴面板」：整组依旧只占**主体卡这一格**，
                      但**没有「展开」这个态** —— 编辑入口就是右栏（切过去看到的就是那头的提示词）。
                   🔴 组内没有视角卡时整层不渲染 —— 只有一张正面图时不留一条空浮层。
                   🔴 两个子类区分「主体卡自己」与「视角变体卡」（`.vf-self` / `.vf-var`）：两者的显示名
                      可能都叫「正面」（用户派生了一张名为「正面」的视角卡），靠类名区分才不歧义。 -->
              <div v-if="hasViews(it.c)" class="vfloat">
                <button v-for="v in viewCards(it.c)" :key="v.name" class="vf-chip"
                        :class="[v.name === it.c.name ? 'vf-self' : 'vf-var', { on: showCard(it.c).name === v.name }]"
                        :disabled="busy"
                        :title="v.name === it.c.name
                          ? '切回正面（主体卡「' + it.c.name + '」自己那张图）'
                          : '切到「' + v.name + '」：大图与右侧的提示词一起切过去；点「正面」切回来。'"
                        @click.stop="viewSel = (v.name === it.c.name ? '' : v.name)">
                  <span class="vf-thumb">
                    <img v-if="selFile(v)" :src="imgSrc(absOf(v, selFile(v)))" alt="" />
                    <i v-else class="vf-none">空</i>
                  </span>
                  <span class="vf-name">{{ v.name === it.c.name ? '正面' : vVar(v.name) }}</span>
                </button>
              </div>
            </div>
            <!-- 库版本落后黄标：库里改过这个条目 → 本集副本是旧的，建议重新生成 -->
            <div v-if="libStale(it.c)" class="lib-stale">
              <span class="ls-txt" :title="'库中「' + it.c.name + '」已更新（库版本 ' + it.c._libRevNow + '，本集副本是版本 ' + it.c.libRevAt + '）'">
                📚 项目库已更新 · 建议重新生成
              </span>
              <button class="btn ghost xs" @click="updateFromLib(it.c)">按库更新本卡</button>
              <button class="btn ghost xs" @click="ackLib(it.c)">忽略</button>
            </div>

            <!-- 场景档案体检黄标（仅场景卡）：缺档案 / 档案为空 / 档案挂错名字。
                 挂错名字时给一键修法：把这张卡的档案搬到镜头真正在用的那张卡上 -->
            <div v-if="it.c.kind === 'scene' && scNote(it.c)" class="sc-issue">
              <span class="sc-txt" :title="scNote(it.c)">⚠ {{ scNote(it.c) }}</span>
              <button v-if="scAdviceOf(it.c)" class="btn ghost xs"
                      title="把这张卡的档案与提示词搬到镜头真正在用的那张卡上（搬完这张空卡自动删除；图片文件不动）"
                      @click="mergeSceneInto(it.c, scAdviceOf(it.c))">
                档案搬到「{{ scAdviceOf(it.c) }}」
              </button>
            </div>

            <!-- 主体组黄标：这一组只有视角变体卡、没有「主体卡」（名字正好等于主体名的那张）。
                 档案与提示词只认主体卡那一份，缺了就等于这一组没有对外依据 → 给一键补建 -->
            <div v-if="grpNoParent(it.c)" class="grp-warn">
              <span class="gw-txt" :title="'这一组只有视角变体卡，没有名字正好是「' + vBase(it.c.name) + '」的主体卡。发给视频模型的档案只取主体卡那一份，缺了就等于这一组没有外观依据；点右边按钮可从组内现有档案补建一张。'">
                ⚠ 本组缺主体卡「{{ vBase(it.c.name) }}」
              </span>
              <button class="btn ghost xs" :disabled="busy" @click="makeParent(it.c)">建主体卡</button>
            </div>

            <!-- 🔴 装扮不再有任何手动入口（2026-10-16 二次拍板，Dragon：「不需要用户点识别装扮」）。
                 识别装扮 → 建派生卡 是**生成分镜那一下自动做的**（见 runAuto），
                 「哪一镜穿哪套」是**点「一键填充」时自动判的**（见 fillRefs）。
                 原来的「识别装扮」「按装扮填镜头」两行与整个识别面板已删除 —— 装扮现在是数据，不是功能。 -->

            <!-- 档案（提示词的唯一依据，可手改）：与大预览同列（图下）；
                 改动 → 脏标记「档案已改 · 提示词待更新」→ 点标题右侧的刷新图标按新档案重算。
                 🔴 视角变体卡（`主体名--视角`）不显示档案区：它共用主体卡的档案，填了也不下发（见 src/variant.js） -->
            <div v-if="!isVariantCard(it.c)" class="f pf-box">
              <div class="pf-head">
                <label>{{ it.c.kind === 'scene' ? '场景档案' : '角色档案' }}</label>
                <span style="flex:1"></span>
                <!-- 2026-10-19 Dragon：「档案已改 · 提示词待更新」不再只给一句提示语 ——
                     需要重做的那颗「刷新提示词」按钮（右栏标题行）直接变琥珀色，点它即按新档案重算。 -->
              </div>
              <textarea v-model="it.c.profile" :rows="it.c.kind === 'scene' ? 5 : 7"
                        :readonly="isLibRo(it.c)"
                        placeholder="档案：每行一个字段「字段名：值」（来自剧本提取，可手工修改）…"
                        @change="touchProfile(it.c)"></textarea>
            </div>
            <!-- 变体卡在这里看到的替代说明（档案区隐藏，从结构上杜绝「填 4 份一样的档案」）
                 🔴 2026-10-16：文案按变体类型分叉 —— 装扮变体是「另一套装扮」，与「换个看点」不是一回事 -->
            <div v-else class="f vnote">
              <div class="pf-head"><label>{{ isOutfitVar(it.c) ? '装扮变体 · 共用档案' : '视角变体 · 共用档案' }}</label></div>
              <div class="vnote-body">
                <div>本卡是主体「<b>{{ vBase(it.c.name) }}</b>」的 <b>{{ vVar(it.c.name) }}</b> {{ isOutfitVar(it.c) ? '装扮' : '视角' }}。</div>
                <div v-if="isOutfitVar(it.c)">档案只维护在主体卡上，发给视频模型时也只发那一份；本卡只负责提供这套装扮的参考图 —— 用「重出这一装扮」从主体卡当前的图派生（只换衣服，脸与背景不变）。</div>
                <div v-else>档案只维护在主体卡上，发给视频模型时也只发那一份；本卡只负责提供这一视角的参考图。</div>
              </div>
            </div>
          </div>

          <!-- 右：正向/负向提示词 → 小预览图 → 分辨率 → 生图按钮（固定右下角）
               链路：档案 → 刷新提示词 → 生图；三级都随时可编辑。
               🔴 2026-10-13 二改（Dragon）：整块包在 `<template v-for="sc in [showCard(it.c)]">` 里，
                  内部一律用别名 sc 而**不是** it.c —— 视角浮层切到哪张，右栏的正/负向提示词、抽卡记录、
                  分辨率就跟着切成那张的（即「看哪张图，就顺手改哪张的提示词」）。
                  别名必须是 sc：Vue 模板没有 let 绑定，而这块要引用它二十几次。
               🔴 只读 / 视角变体卡的按钮可见性也一律按 sc 判 —— 切到视角卡上时「一键填充整组 /
                  存到项目 / 写入镜头」照样不出现（与改造前视角卡不占格时的行为逐字一致）。 -->
          <div class="cright">
            <template v-for="sc in [showCard(it.c)]" :key="sc.name">
            <div class="f ta-prompt">
              <!-- 标题行：正向提示词 + 右侧「刷新提示词」图标（按本卡档案重算正/负向提示词，会覆盖当前值） -->
              <div class="ta-head">
                <label>正向提示词</label>
                <span style="flex:1"></span>
                <!-- 删除整张卡（2026-09-27：从底部操作行挪到标题行、放在刷新图标左边，只显示图标不带文字）：
                     档案与提示词一起删，已生成的图片文件保留在项目 assets 下，可用缩略图上的 ✕ 单独清理。
                     🔴 删的是**当前正在看的那张**（sc）：切到侧面视角再点它 = 删那张视角卡（原来的
                        删卡入口在卡内手风琴面板里，二改后面板没了，这里就是它唯一的入口）。 -->
                <button class="del-btn head-x" :disabled="busy"
                        title="删除这张卡：档案与提示词会一起删掉（图片文件保留在 项目/assets 下，可用缩略图上的 ✕ 单独清理）"
                        @click="askDelCard(sc)">✕</button>
                <!-- 刷新提示词：🔴 视角变体卡共用主体卡的档案（档案区本身也是隐藏的）→ 它上面不给这个入口；
                     按下标取卡用 idxOf(sc)，不用 it.i —— it.i 是「这一格」的下标，与 sc 不一定是同一张 -->
                <button v-if="!isVariantCard(sc)" class="btn icon" :class="{ regen: sc._profRevAt > 0, 'stale-need': profStale(sc) }"
                        :disabled="busy || isLibRo(sc) || !String(sc.profile || '').trim()"
                        :title="profStale(sc)
                          ? '档案改过，提示词还没跟上 → 点这里按新档案重算正向 / 负向提示词'
                          : '刷新提示词（按本卡档案重新生成正向 / 负向提示词，会覆盖当前提示词，之后仍可手改）'"
                        @click="genPromptFromProfile(idxOf(sc))">
                  <span v-if="sc._pgGen" class="busy-txt"><i class="spin"></i></span>
                  <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
                  </svg>
                </button>
              </div>
              <textarea v-model="sc.prompt" rows="5" :readonly="isLibRo(sc)" placeholder="正向提示词"
                        @change="saveAll()"></textarea></div>
            <div class="f ta-neg"><label>负向提示词</label>
              <textarea v-model="sc.negative" rows="3" :readonly="isLibRo(sc)" placeholder="负向提示词"
                        @change="saveAll()"></textarea></div>

            <!-- 小预览图（抽卡记录，最多显示最新 4 张；点击选中作图生图底图，✕ 删除）
                 2026-10-08（Dragon）：去掉「小预览图 / 点击选中…」标题与提示语；
                 末尾的虚线「+」= 从本地导入一张图（外观参考「新增角色」的 .add-tile：虚线框、悬停变蓝）；
                 只读副本卡（库里导入的）不显示 ✕ 与 + -->
            <div class="f">
              <div class="thumbs">
                <div v-for="t in shown(sc)" :key="t.i" class="thumb-wrap">
                  <img :src="imgSrc(absOf(sc, t.f))" :class="{ cur: t.i === sc.cur }"
                       title="点击选中／再点一次取消选中" @click="pick(sc, t.i)" />
                  <button v-if="!isLibRo(sc)" class="img-x" title="删除这张图" @click.stop="askDel(sc, t.i)">✕</button>
                </div>
                <button v-if="!isLibRo(sc)" class="thumb-add" :disabled="busy"
                        title="从本地选图当这张卡的参考图（可多选，一次全导进来）：会复制进本卡的素材目录并重命名为「卡名」（永不覆盖，同名自动编号）"
                        @click="importImgOf(sc)">+</button>
              </div>
              <!-- 2026-10-13 三改（Dragon）：没图时原来这里补一句「尚未出图」文字提示，现整体去掉
                   （没图时只剩末尾那个虚线「+」导入格，本身就是最直白的「这里还没有图」）。
                   🔴 连带影响：.cright 里 `!sc.candidates.length` 分支已不存在 —— 测试脚本里
                      任何按这段文字定位的探针都要一起改（grep「尚未出图」）。 -->
            </div>

            <!-- 库操作 + 一键填充（次级功能：绿色）。
                 2026-10-08（Dragon）：与下方「分辨率」上下换位 —— 按钮行在上、分辨率在下并入出图行。
                 🔴 视角变体卡上这三个按钮全部隐藏（2026-10-08，Dragon）：它共用主体卡的档案与图组，
                    填充/入库/写镜头都只对主体卡有意义（填图走主体卡的「一键填充整组」）。
                    视角名也永远不会写进分镜，写进 chars 反而会让 init 把卡建回来。
                    三个都没了 → 整行收起（.row-empty），不留空档。 -->
            <div class="cops fill-row" :class="{ 'row-empty': fillRowEmpty(sc) }">
              <!-- 父卡 → 整组一次填充；视角变体卡无此按钮（2026-10-08） -->
              <button v-if="!isVariantCard(sc)" class="btn sec sm" :disabled="busy || !selFile(sc)"
                      :title="grpSize(sc) > 1
                        ? '把「' + sc.name + '」整组的 ' + grpSize(sc) + ' 张图（父卡 + 全部视角变体）一次填到所有包含「' + vBase(sc.name) + '」的镜头的参考图区（只填参考图，不动首尾帧）。本集识别过这个角色的装扮时，改为按镜头逐镜填那一镜该穿的那套'
                        : '把当前选中的这张图填到所有包含「' + vBase(sc.name) + '」的镜头的参考图区（只填参考图，不动首尾帧）。视角变体卡按主体名匹配，所以分镜里不必写「' + sc.name + '」。本集识别过这个角色的装扮时，改为按镜头逐镜填那一镜该穿的那套'"
                      @click="fillRefs(idxOf(sc))">
                {{ grpSize(sc) > 1 ? '一键填充整组' : '一键填充' }}
              </button>
              <!-- 「从本地导入」已挪到上方小预览图区（末尾虚线「+」格子，2026-10-08） -->
              <!-- 本集新增卡 → 保存到项目库；已入库的本地卡 → 更新到项目库（视角变体卡不参与入库） -->
              <button v-if="!sc.libId && !isVariantCard(sc)" class="btn sec sm" :disabled="busy"
                      title="把这张卡（档案 + 正负提示词 + 已选中的图 + 分辨率）打包保存到项目角色场景库，供其它集复用"
                      @click="saveToLib(sc)">
                存到项目
              </button>
              <button v-else-if="!isLibRo(sc) && !isVariantCard(sc)" class="btn sec sm" :disabled="busy"
                      title="把本集的改动推回项目库（库版本 +1；引用该条目的其它集会提示重新生成）"
                      @click="updateToLib(sc)">
                更新到项目库
              </button>
              <!-- 只读卡：库里存在同基础名的多张卡时，允许切换（系统判错时的纠正出口） -->
              <label v-if="isLibRo(sc) && libVariantsOf(sc).length > 1" class="lib-switch"
                     title="库里存在同基础名的多张卡（如 李白-少年 / 李白-老年）。系统自动选的可能不对，可在这里换成正确的那张。">
                <select :value="sc.libId" :disabled="busy" @change="switchVariant(sc, $event.target.value)">
                  <option v-for="v in libVariantsOf(sc)" :key="v.id" :value="v.id">{{ v.name }}</option>
                </select>
              </label>
              <!-- 把这张卡写进本集镜头的 chars 字段（手动新增的卡否则不会出现在任何镜头的参考图里） -->
              <button v-if="!isVariantCard(sc)" class="btn ghost sm" :disabled="busy || !(ep && ep.shots && ep.shots.length)"
                      title="把「本集有谁」写进选定镜头的 chars 字段：只有写进去，这张卡的图才会在一键填充 / H3 生成时被挂上"
                      @click="openWriteShots(sc)">
                写入镜头
              </button>
              <!-- 「删除卡」已挪到上方「正向提示词」标题行（2026-09-27） -->
            </div>

            <!-- 底部操作区：**竖排两行**（2026-10-13 三改，Dragon）。
                 第 1 行 = 分辨率（靠左）+「生成3视图」（靠右，同一行）；
                 第 2 行 = 生图按钮（靠右，仍停在卡片右下角）。
                 2026-10-08（Dragon）：原「耗时 xxx」文案去掉「耗时」前缀并挪到图上角标（.gen-tag）。
                 🔴 新类 `.ops-stack` 只为角色卡这一处 —— 绝不能给共用的 `.ops-row` 本体加
                    flex-direction:column：StageLibrary / StageShots 也在用它，会连带改掉那两个页面。 -->
            <div class="ops-row ops-stack">
              <!-- 第 1 行：分辨率 + 3 视图开关（.card-tv 靠 margin-left:auto 顶到行尾） -->
              <div class="ops-res-row">
                <label class="card-res">分辨率
                  <select :value="resOf(sc)" :disabled="true" title="分辨率由视频质量档位决定（在「新建项目 / 项目配置」里切换档位）">
                    <option v-for="o in optsFor(sc)" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </label>
                <!-- 三视图开关（2026-10-13，Dragon）：角色卡上才有 —— 打开时点一次生图会依次出
                     正面 / 侧面 / 背面 三张独立图（侧背以正面图为参考走编辑通道，自动派生 `主体名--视角` 卡）。
                     🔴 默认**关闭**（2026-10-14 Dragon 改）：判据 = `!!sc.threeView`，缺字段即关。
                        以前是判「非 false 即开」+ init 白名单漏了该字段 → 值每次重建都退回 undefined
                        → 勾选框点不动（根因与修法见 init() 里 `threeView` 那条注释）。
                     🔴 用 `:checked` + `@change` 而不是 v-model：写值必须走 liveCard + saveAll 那一套，
                        直接 v-model 改的是 v-for 里的视图引用，下一条 saveAll 会拿旧值把它冲掉。
                     🔴 这里必须是 input 而不是 button —— 测试脚本按 `.ops-row button` 精确数按钮个数。
                     🔴 showViewChk(sc) 本身已排除视角变体卡 → 切到视角时它也自动消失。 -->
                <label v-if="showViewChk(sc)" class="card-tv"
                       title="默认关闭。打开后，点一次「生图」会依次出三张独立图：正面（常规文生图）、侧面、背面。侧面与背面以正面图为参考自动派生并出图（每张约 1 分钟）；三张图共用一个主体组，用「一键填充整组」可一次填进镜头。关着则只出正面一张。">
                  <input type="checkbox" :checked="!!sc.threeView" :disabled="busy || isLibRo(sc)"
                         @change="setThreeView(sc, $event.target.checked)" />
                  生成3视图
                </label>
              </div>
              <!-- 第 2 行：生图按钮（靠右）。
                   🔴 正在看变体卡时，这颗按钮变成「重出这一视角 / 重出这一装扮」（走编辑通道、以主体卡当前的图为参考）；
                      看主体卡自己那张时与从前完全一致（文生图 / 图生图）。 -->
              <button v-if="isVariantCard(sc)" class="btn sm" :disabled="busy || isLibRo(sc)" @click="regenView(sc)">
                {{ isOutfitVar(sc) ? '重出这一装扮' : '重出这一视角' }}
              </button>
              <button v-else class="btn sm" :class="{ regen: sc.refAsBase && sc.cur >= 0 }" :disabled="busy || isLibRo(sc)" @click="gen(it.i)">
                {{ sc.refAsBase && sc.cur >= 0 ? '图生图' : '文生图' }}
              </button>
            </div>
            </template>
          </div>

          <!-- ===== 旧「卡底视角条（.vstrip）+ 卡内手风琴面板（.vpanel）」已在 2026-10-13 二改中删除 =====
               它们的取代物 = 贴在大预览图下缘的 **视角浮层**（`.vfloat`，见上面 `.bigprev` 里那段注释）：
               点浮层里的一张 → 大图就地换 → 右栏提示词 / 抽卡记录跟着切；删那张卡的入口 = 右栏标题行的 ✕。
               🔴 别再加回来：整组只占主体卡一格这条约束照旧，但界面里**不再有** `.vstrip` / `.vpanel`。 -->
        </div>

        <!-- 新增入口：单张虚线卡内放 3 个纯文字按钮（2026-09-27 三改，Dragon：不带 +/📚 前缀、无底色；
             虚线框与角色/场景卡同格同大）。点哪个按钮执行哪个操作（弹与原底条按钮相同的弹窗）；库为空时「从项目库导入」置灰 -->
        <div class="add-tile" title="手动新增角色 / 场景，或从项目库导入到本集">
          <div class="add-tile-btns">
            <button class="tile-link" :disabled="busy" @click="openAdd('character')">新增角色</button>
            <button class="tile-link" :disabled="busy" @click="openAdd('scene')">新增场景</button>
            <button class="tile-link" :disabled="busy || !libAll.length"
                    title="从项目角色场景库挑一条导入到本集（导入的卡在本集为只读副本，改要去库编辑区）"
                    @click="openImportLib()">从项目库导入</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 操作条：提示文字靠左（2026-09-27 三改，Dragon：批量按钮移到模块标题栏右边，此处只剩提示文字） -->
    <div class="ops-bar">
      <span class="hint">角色图与场景图都保存到项目 assets 下（永不覆盖，可无限重生成）</span>
    </div>

    <!-- 批量按钮：Teleport 到块 2 标题行右边（App.vue 的 #chars-batch）。
         🔴 Teleport 延迟挂载：切集时 <section :key> 整棵重建，mounted 前 #chars-batch 不在文档里 →
         必须 mounted + nextTick 后再渲染（tpReady），否则内容被静默丢弃。
         空闲 = 「批量生成提示词 / 批量生成图片」；跑动中 = 「停止批量」；已请求停止 = 「停止中…」（禁点） -->
    <Teleport v-if="tpReady" to="#chars-batch">
      <!-- 批量填充（2026-10-19 Dragon）：把**所有已生成的图**按每镜的角色/场景一次填进参考图区。
           放在最前面 = 显示在「批量生成提示词」左边。 -->
      <button class="btn sec sm"
              :disabled="batchFill || batchP || batchPStop || batchI || batchIStop || !cards.length || !((ep && ep.shots) || []).length"
              title="把所有已生成的图（角色 + 场景）按每镜分镜行里的「角色 / 场景」自动匹配，一次填进全部镜头的参考图区；只填参考图，不动首尾帧，已有其它参考图不会被删"
              @click="batchFillRefs">
        <span v-if="batchFill" class="busy-txt"><i class="spin"></i>填充中…</span>
        <span v-else>批量填充角色图</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && cards.some(c => String(c.profile || '').trim()), danger: batchP || batchPStop, 'stale-need': !batchP && !batchPStop && anyProfStale }"
              :disabled="batchPStop || batchI || batchFill"
              :title="anyProfStale && !batchP ? '有卡片的档案改过、提示词还没跟上 → 点这里批量重算' : (batchP ? '点击停止：当前条目跑完后，剩余条目不再执行' : '按档案批量重新生成提示词，或只处理档案有变动 / 还没有提示词的条目')"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <!-- 本模块的主操作 = 出图；标题栏里只有它是实心蓝（pro），其余两只是描边 -->
      <button class="btn sm pro" :class="{ regen: !batchI && !batchIStop && cards.some(c => c.candidates.length), danger: batchI || batchIStop }"
              :disabled="batchIStop || batchP || batchFill"
              :title="batchI ? '点击停止：当前条目跑完后，剩余条目不再执行' : '依次生成所有还没有图的角色图与场景图（已有图的跳过）'"
              @click="batchImages">
        <span v-if="batchIStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchI">停止批量({{ batchIN }}/{{ batchITotal }})</span>
        <span v-else>批量生成图片</span>
      </button>
    </Teleport>

    <!-- 新增角色/场景：填名字建一张空白本集卡 -->
    <div v-if="askAdd" class="modal-mask" @click.self="askAdd = null">
      <div class="modal">
        <div class="modal-title">新增{{ askAdd.kind === 'scene' ? '场景' : '角色' }}卡</div>
        <div class="modal-note">
          <div>名字是这张卡在本集与项目库里的**唯一标识**（决定图片目录与参考图归属），请与分镜里写的名字逐字一致。</div>
          <div style="margin-top:6px">同一人物的不同年龄 / 形态请写成「基础名-限定词」（如 李白-少年、李白-老年），不要用同一个名字。</div>
          <div style="margin-top:6px">同一件产品 / 道具 / 角色的**不同视角**（正面、侧面、内饰…）**不要在这里新建**：请回到那张主体卡，点它名字旁边的「+」派生 —— 主体名会自动带上，你只填视角名即可，不会撞名。</div>
        </div>
        <input type="text" v-model="askAdd.name" placeholder="例如：张伯 / 李白-少年"
               @keyup.enter="doAdd" style="margin:8px 0" />
        <div v-if="addErrMsg" class="modal-err">{{ addErrMsg }}</div>
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askAdd = null">取消</button>
          <button class="btn" :disabled="!String(askAdd.name || '').trim() || !!addErrMsg" @click="doAdd">新增</button>
        </div>
      </div>
    </div>

    <!-- 派生变体卡（2026-10-08，Dragon）：主体名前缀固定成灰色胶囊，用户只填变体名。
         这样「V9X--正面」这种名字只能由系统拼出来 —— 用户既不用知道双横杠约定，也不会写出撞名 / 写错的卡名。
         🔴 2026-10-16 新增**变体类型**切换（角色卡才有）：视角变体 = 换个看点（三视图走的那一路，图要自己导）；
            装扮变体 = 同一角色的另一套装扮（指令由 views.md 的换装行预填，用「重出这一装扮」从主体卡的图派生）。 -->
    <div v-if="askDerive" class="modal-mask" @click.self="askDerive = null">
      <div class="modal">
        <div class="modal-title">给「{{ askDerive.base }}」派生一张{{ askDerive.outfit ? '装扮卡' : '视角卡' }}</div>
        <!-- 类型切换：只给角色卡用 —— 「场景换装」没有意义（场景的变体恒为视角） -->
        <div v-if="askDerive.kind !== 'scene'" class="dkind">
          <button type="button" :class="{ on: !askDerive.outfit }" @click="askDerive.outfit = false">
            视角变体
            <span>正面 / 侧面 / 内饰…</span>
          </button>
          <button type="button" :class="{ on: askDerive.outfit }" @click="askDerive.outfit = true">
            装扮变体
            <span>婚装 / 常服 / 夜行装…</span>
          </button>
        </div>
        <div class="modal-note">
          <div>主体名固定为「<b>{{ askDerive.base }}</b>」，你只需要填{{ askDerive.outfit ? '**装扮名**（如 婚装 / 常服 / 夜行装）' : '**视角名**（如 正面 / 侧面 / 内饰 / 顶部）' }}。</div>
          <div v-if="askDerive.outfit" style="margin-top:6px">
            派生后卡上会预填一条**换装指令**（来自 views.md：只说换衣服，其余一律保持原样）：把里面的
            「{装束}」补成这套装扮的服装 / 配饰 / 头饰描述（可从角色档案的「服装」字段抄），再点「<b>重出这一装扮</b>」——
            它会拿主体卡当前的图当参考，走编辑通道**只换衣服**（脸、背景、光线、构图都不变）。
            <b>这里只在补一张特例卡时才用</b>：正常路子上装扮卡由「生成分镜」自动识别并建好（指令里已经填好装束描述）。
          </div>
          <div v-else style="margin-top:6px">新卡会自动与主体卡相邻摆放、**共用同一个背景框与档案**（发给视频模型时只发主体卡那一份），分镜里也只需写主体名。</div>
        </div>
        <div class="dname">
          <span class="dname-fix">{{ askDerive.base }}--</span>
          <input type="text" v-model="askDerive.suffix"
                 :placeholder="askDerive.outfit ? '装扮名，如：婚装' : '视角名，如：正面'"
                 @keyup.enter="doDerive" />
        </div>
        <div v-if="deriveName" class="dname-prev">将创建：<b>{{ deriveName }}</b></div>
        <div v-if="deriveErr" class="modal-err">{{ deriveErr }}</div>
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askDerive = null">取消</button>
          <button class="btn" :disabled="!deriveName || !!deriveErr" @click="doDerive">派生</button>
        </div>
      </div>
    </div>

    <!-- 装扮清单的识别面板已删除（2026-10-16 二次拍板，Dragon：「不需要用户点识别装扮」）：
         识别 → 建 `主体--装扮名` 派生卡 全程由「生成分镜」那一下自动完成（见 runAuto），
         卡片上的换装指令与装束描述可以直接改 —— 这就是唯一的编辑出口。 -->

    <!-- 从项目库导入：列出库里该类型、本集还没有的条目，导入为只读副本 -->
    <div v-if="askImport" class="modal-mask" @click.self="askImport = null">
      <div class="modal">
        <div class="modal-title">从项目角色场景库导入</div>
        <div class="modal-note">导入的卡在本集是**只读副本**（按钮禁用、文案不可改）；要改请到左侧「项目角色场景库」编辑。</div>
        <div class="import-list">
          <div v-for="e in importable" :key="e.id" class="import-row" @click="doImport(e)">
            <span class="ir-ico">{{ e.kind === 'scene' ? '🏞' : '🧑' }}</span>
            <span class="ir-name">{{ e.name }}</span>
            <span class="ir-sub">{{ e.kind === 'scene' ? '场景' : (e.role || '角色') }} · {{ e.images.length }} 张图</span>
          </div>
          <div v-if="!importable.length" class="muted" style="padding:10px 0">库里没有可导入的条目（本集已全部导入，或库还是空的）</div>
        </div>
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askImport = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 写入镜头：把这张卡的名字写进选定镜头的 chars 字段（本集有谁） -->
    <div v-if="askWrite" class="modal-mask" @click.self="askWrite = null">
      <div class="modal">
        <div class="modal-title">把「{{ askWrite.name }}」写进哪些镜头？</div>
        <div class="modal-note">勾选的镜头，其「本集有谁」会加上这个名字 → 一键填充与 H3 生成时才会把这张卡挂成参考图。</div>
        <div class="shot-pick">
          <div v-for="(s, i) in (ep && ep.shots) || []" :key="i" class="sp-row" @click="askWrite.sel[i] = !askWrite.sel[i]">
            <input type="checkbox" :checked="!!askWrite.sel[i]" @click.stop="askWrite.sel[i] = !askWrite.sel[i]" />
            <span class="sp-i">镜{{ i + 1 }}</span>
            <span class="sp-scene">{{ s.scene || '' }}</span>
            <span class="sp-act">{{ (s.action || '').slice(0, 40) }}</span>
            <span v-if="shotHasStr(s, askWrite.name)" class="sp-has">已含</span>
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn ghost sm" @click="writePickAll(true)">全选</button>
          <button class="btn ghost sm" @click="writePickAll(false)">全不选</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askWrite = null">取消</button>
          <button class="btn" @click="doWriteShots">写入</button>
        </div>
      </div>
    </div>

    <!-- 批量入库：整块生成完 → 一次性询问本集新增的卡是否保存到项目库（默认全选） -->
    <div v-if="askLibSave" class="modal-mask" @click.self="askLibSave = null">
      <div class="modal">
        <div class="modal-title">本集新增的角色 / 场景，保存到项目库？</div>
        <div class="modal-note">
          保存后这些卡会成为项目角色场景库的条目，其它集再出现同名人物时**自动只读加载同一套外观与图片**（避免每集各一张脸）。
          取消勾选的卡留在本集，之后可随时用卡片上的「保存到项目」补录。
        </div>
        <div class="import-list">
          <div v-for="n in askLibSave.chars" :key="'c' + n" class="import-row" @click="askLibSave.sel[n] = !askLibSave.sel[n]">
            <input type="checkbox" :checked="askLibSave.sel[n] !== false" @click.stop="askLibSave.sel[n] = askLibSave.sel[n] === false" />
            <span class="ir-ico">🧑</span><span class="ir-name">{{ n }}</span><span class="ir-sub">角色</span>
          </div>
          <div v-for="n in askLibSave.scenes" :key="'s' + n" class="import-row" @click="askLibSave.sel[n] = !askLibSave.sel[n]">
            <input type="checkbox" :checked="askLibSave.sel[n] !== false" @click.stop="askLibSave.sel[n] = askLibSave.sel[n] === false" />
            <span class="ir-ico">🏞</span><span class="ir-name">{{ n }}</span><span class="ir-sub">场景</span>
          </div>
        </div>
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askLibSave = null">稍后（不保存）</button>
          <button class="btn" @click="doBatchLibSave">保存选中的到项目库</button>
        </div>
      </div>
    </div>

    <!-- 删除单张图：永久删除（物理删盘）/ 删除显示（仅移出列表） -->
    <div v-if="ask" class="modal-mask" @click.self="ask = null">
      <div class="modal">
        <div class="modal-title">删除这张{{ ask.c.kind === 'scene' ? '场景图' : '角色图' }}？</div>
        <div class="modal-body mono">{{ ask.c.name }} / {{ ask.f }}</div>
        <div class="modal-note">
          <b>永久删除</b>：从磁盘物理删除，无法恢复。<br>
          <b>删除显示</b>：只是不再在这里列出，磁盘文件仍保留在 项目/assets/{{ ask.c.kind === 'scene' ? 'scenes' : 'characters' }}/ 下。
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDel(true)">永久删除</button>
          <button class="btn ghost" @click="doDel(false)">删除显示</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="ask = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 删除整张卡片（与「删图」区分：删卡 = 删档案与提示词，图片文件留在磁盘） -->
    <div v-if="askCard" class="modal-mask" @click.self="askCard = null">
      <div class="modal">
        <div class="modal-title">删除这张{{ askCard.c.kind === 'scene' ? '场景' : '角色' }}卡？</div>
        <div class="modal-body mono">{{ askCard.c.name }}</div>
        <div class="modal-note">
          <div>· 卡上的<b>档案与提示词会一起删掉</b>，不可恢复。</div>
          <div style="margin-top:6px">· 已生成的<b>图片文件仍保留</b>在项目的 assets 素材目录下（要清磁盘请在缩略图上点 ✕）。</div>
          <div style="margin-top:6px">· 项目角色场景库里的<b>同名条目不受影响</b>（要删库条目请在左侧库里操作）。</div>
          <div v-if="askCard.used" style="margin-top:6px;color:#fcd34d">
            ⚠ 分镜里还有 <b>{{ askCard.used }}</b> 个镜头在用这个名字，删除时会<b>一并从这些镜头里移除</b>
            （不摘掉的话，下一轮重建会照分镜里的名字把这张卡又建回来）。
          </div>
          <!-- 删主体卡 = 连子卡一起删（2026-10-08，Dragon）：视角卡离开主体就没有任何意义 -->
          <div v-if="askCard.kids && askCard.kids.length" style="margin-top:6px;color:#fcd34d">
            ⚠ 这是主体卡，它的 <b>{{ askCard.kids.length }}</b> 张视角卡会<b>一并删除</b>：
            {{ askCard.kids.map(k => k.name).join('、') }}（图片文件同样保留在磁盘）。
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDelCard()">删除{{ askCard.kids && askCard.kids.length ? '（含 ' + askCard.kids.length + ' 张视角卡）' : '卡片' }}</button>
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askCard = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 批量生成弹框：提示词 / 图片 二选一范围（kind 区分），可随时停止 -->
    <div v-if="askBatch" class="modal-mask" @click.self="askBatch = null">
      <div class="modal">
        <template v-if="askBatch.kind === 'prompts'">
          <div class="modal-title">批量生成提示词</div>
          <div class="modal-note">
            <div><b>全部重新生成</b> —— 所有角色与场景都按各自档案重算提示词，<b>覆盖现有提示词（含手改过的）</b>。</div>
            <div style="margin-top:6px"><b>只生成需更新的</b> —— 仅处理「档案已改但提示词没重算」和「还没有提示词」的条目，其余不动。</div>
            <div style="margin-top:6px">生成过程会同时把同类其它档案下发给模型，保证新提示词与已有角色在至少 3 个维度上不撞。</div>
          </div>
          <div class="modal-ops">
            <button class="btn" @click="askBatchAll">全部重新生成</button>
            <button class="btn" @click="askBatchMissing">只生成需更新的</button>
            <button class="btn ghost" @click="askBatch = null">取消</button>
          </div>
        </template>
        <template v-else>
          <div class="modal-title">批量生成图片</div>
          <div class="modal-note">
            <div><b>只补还没有图的</b> —— 仅给还没有图片的条目出图；已有图的全部跳过（想重出某一张，用该卡片右下角的「生图 / 图生图」按钮）。</div>
            <div style="margin-top:6px"><b>全部重新生成</b> —— 所有条目都重新出一张图，完成后<b>自动选中新版本</b>（旧版本保留，可随时切回）。</div>
            <div style="margin-top:6px">当前共 {{ askBatch.total }} 个条目：已有图 <b>{{ askBatch.have }}</b> 个、还没有图 <b>{{ askBatch.miss }}</b> 个。</div>
            <div style="margin-top:6px">条目 = 角色 / 场景<b>主体卡 + 它们的装扮卡</b>（装扮卡以主体卡的图为参考、只换衣服；视角卡不在其中）。装扮卡要等主体卡先有图，所以「只补还没有图的」会先出主体卡、再出装扮卡。</div>
          </div>
          <div class="modal-ops">
            <button class="btn" @click="askBatchImgMissing">只补还没有图的</button>
            <button class="btn" @click="askBatchImgAll">全部重新生成</button>
            <button class="btn ghost" @click="askBatch = null">取消</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 2026-09-27：批量按钮已直接渲染在本组件底部操作条（见上方 .ops-bar），
         不再 Teleport 到块 2 标题行 —— #chars-batch 落点与延迟挂载开关一并移除 -->
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog, secs, dbgPrompt } from './ulog.js'
import { parseRes, ratioLabel, resLabel, optsWith, seg, joinPath } from './resutil.js'
import { baseOf, variantOf, isVariant, hasSep, groupCards, hashName, GROUP_HUES } from './variant.js'
import {
  readPrompt, parseFallbacks, pickFallback, section, ensureSceneKeeper, composeSystem, composeUser,
  normalizeProfile, profileDirty, profileBrief, readEquipmentWords, stripEquipmentWords
} from './prompts.js'
import {
  sceneCardIssues, outfitShotBrief, parseOutfitList, tidyOutfitDesc, shotHasChar,
  outfitPlan, mergeOutfitList, outfitKnownBrief
} from './promptlib.js'
import { overrideOf } from './llmSource.js'

// 🔴 生图环节的三份兜底（负向词表 / 空镜必备句 / 生图模板）全部来自项目规范 md
//    —— chars.md 的「## 兜底默认」（主人公 / 配角 / 负向）与 scenes.md 的「## 兜底默认」/「## 空镜必备句」，
//    由 fallbackTemplates() 在每次载入时刷新。代码不再内置任何提示词文案。
//    这三个名字保持模块级可变，是为了让下面各处引用零改动地复用（读不到时为空串 = 不补）。
let DEFAULT_NEG = ''
let SCENE_KEEPER_DEFAULT = ''
let FALLBACK_TPL = { hero: '', npc: '', scene: '' }
let EQ_WORDS = []   // 器材词表（风格包的 equipStrip 优先，scenes.md「器材词:」行兜底）：生图发送前剥掉命中短语，防器材被画进画面
// 三视图的视角编辑指令（views.md「## 兜底默认」里的 侧面 / 背面 / 公共约束 三行）——与上面几份兜底同一套读法：
// 每次载入刷新，读不到就是空串，空串时三视图功能整体不生效（自动退回「只出一张正面图」的老行为）。
// 🔴 2026-10-16 起同一个对象还装**装扮变体**那两行（outfit / outTail）—— 同文件、同读法、同一个 md 小节：
//    outfit = 换装句（含 `{装扮}` 占位符，程序换成派生弹窗里填的装扮名）、outTail = 换装约束句。
//    读不到时（outfit 为空）装扮变体整体不生效：派生直接中止，绝不发半句残缺指令。
let VIEW_TPL = { side: '', back: '', tail: '', outfit: '', outTail: '' }
/** 三视图要自动派生（或复用）的视角名，顺序即出图顺序 */
const VIEW_NAMES = ['侧面', '背面']
/** 编辑通道的分辨率档：1024 → 参考图等比缩到约 1024² 面积（竖幅实测 768×1376，约 54s/张） */
const VIEW_RESOLUTION = 1024
const SHOW_MAX = 4   // 抽卡区最多渲染最新几张（磁盘与 candidates 记录不受影响）
// 分镜行参考图上限（与 StageShots 的 MAX_REF_IMG 保持一致）：一键填充不允许把镜头填爆
const MAX_REF_IMG = 9
const EMPTY_REFS = () => ({ images: [], videos: [], first: null, last: null })
const TAG = '阶段4 角色&场景'

// 🔴 档案 → 提示词的提示词全部来自项目 prompts/：promptgen.md 承载任务身份与 JSON 输出契约，
//    profile.md + chars.md / scenes.md 承载写法规范（见 composeSystem 的 specs），代码不再硬编码

// （生图模板已迁到项目规范 md 的「## 兜底默认」小节，见上方 fallbackTemplates 的说明）

/** 取 scenes.md「空镜必备句」小节里的那句话（跳过括号说明行 / 列表符号行） */
function pickKeeper(md) {
  const body = section(md, '空镜')
  if (!body) return ''
  for (const raw of String(body).split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln || /^[（(]/.test(ln) || /^[-*#>]/.test(ln)) continue
    return ln
  }
  return ''
}

/** 相对时间文案（「刚刚 / N 分钟前」；依赖每秒 tick 的调用方自己 void live） */
function agoText(ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
  return Math.floor(d / 86400000) + ' 天前'
}

/**
 * 解析「档案 → 提示词」的输出（容错）：
 * 优先 JSON（{"prompt","negative"} / 裸字符串）；模型只回了一段文本就当正向提示词用。
 */
function parsePcOut(text) {
  const raw = String(text || '')
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = m ? m[1] : raw
  const s = body.search(/[{[]/)
  if (s < 0) return { prompt: raw.trim(), negative: '' }
  const e = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  try {
    const o = JSON.parse(body.slice(s, e > s ? e + 1 : undefined))
    if (typeof o === 'string') return { prompt: o.trim(), negative: '' }
    return { prompt: String(o.prompt || o.positive || '').trim(), negative: String(o.negative || '').trim() }
  } catch (_) {
    return { prompt: raw.trim(), negative: '' }
  }
}

/**
 * 读生图兜底（chars.md / scenes.md 的「## 兜底默认」小节 + scenes.md 的「## 空镜必备句」）：
 * 正向模板（主人公 / 配角 / 场景）、负向词表、空镜必备句全部来自 md，读不到就是空
 * —— 主进程 readAt 已保证项目副本不可用时回退内置版，所以这里不再需要代码内的兜底文案。
 */
async function fallbackTemplates() {
  const out = { hero: '', npc: '', scene: '', keeper: '', negative: '', words: [] }
  try {
    const cl = parseFallbacks(await readPrompt('chars.md'))
    out.hero = pickFallback(cl, ['主人公', '主角', 'hero'])
    out.npc = pickFallback(cl, ['配角', 'npc', 'npc角色'])
    out.negative = pickFallback(cl, ['负向', 'negative'])
  } catch (_) { /* 读不到就留空 */ }
  try {
    const smd = await readPrompt('scenes.md')
    out.scene = pickFallback(parseFallbacks(smd), ['场景', 'scene'])
    out.keeper = pickKeeper(smd)
    // 🔴 器材词表优先取**风格包**的 equipStrip（画风族声明该剥哪些词），scenes.md 那一行只作兜底
    out.words = await readEquipmentWords()
    if (!out.negative) out.negative = pickFallback(parseFallbacks(smd), ['负向', 'negative'])
  } catch (_) { /* 读不到就留空 */ }
  // 回写给模块级变量，让上面那些同步引用复用（新建卡片时的默认提示词 / 负向、生图时的空镜句）
  DEFAULT_NEG = out.negative
  SCENE_KEEPER_DEFAULT = out.keeper
  FALLBACK_TPL = { hero: out.hero, npc: out.npc, scene: out.scene }
  EQ_WORDS = out.words || []
  // 三视图的视角指令（views.md 的「## 兜底默认」小节）——与上面几份同一套读法（parseFallbacks
  // 的「键: 值」行）：读不到就是空串，空则三视图的编辑通道分支整体不生效
  // （宁可退化成「只出一张正面图」的老行为，也不发出一句残缺的编辑指令）
  try {
    const vfb = parseFallbacks(await readPrompt('views.md'))
    VIEW_TPL = {
      side: pickFallback(vfb, ['侧面']),
      back: pickFallback(vfb, ['背面']),
      tail: pickFallback(vfb, ['公共约束']),
      // 🔴 装扮变体（2026-10-16）：换装句 / 换装约束句。pickFallback 取的是**第一条键名含该词**的行
      //    → views.md 里「换装」必须排在「换装约束」之前（那条约束已写进 views.md 的说明里）。
      outfit: pickFallback(vfb, ['换装']),
      outTail: pickFallback(vfb, ['换装约束'])
    }
  } catch (_) { VIEW_TPL = { side: '', back: '', tail: '', outfit: '', outTail: '' } }
  out.views = VIEW_TPL
  return out
}

export default {
  name: 'StageChars',
  data() {
    return {
      cards: [], busy: false, loadPending: false, _b64: {}, _dims: {}, ask: null, _keeper: SCENE_KEEPER_DEFAULT,
      // 视角浮层里当前**正在看**的那张（2026-10-13 二改，Dragon）：存**视角卡名**，
      // 空串 = 看主体卡自己那张（浮层里的「正面」）。纯界面态，不落库。
      // 🔴 它只决定「屏幕上在看哪张图」—— **不动物体卡的 cur**，所以一键填充 / 存到项目 /
      //    写入镜头的行为与改造前逐字一致（视角卡只影响预览哪个像素，不改任何下游数据）。
      viewSel: '',
      // 批量任务（块 2 标题行的两个按钮）：
      //   batch*=队列在跑；*Stop=已点停止等当前条目收尾；askBatch=范围选择弹窗
      //   batch*N/Total=按钮上的进度（正在处理第 N 个 / 共 Total 个），跑完/停止归零
      batchP: false, batchPStop: false, batchPN: 0, batchPTotal: 0,
      batchI: false, batchIStop: false, batchIN: 0, batchITotal: 0,
      batchFill: false,   // 「批量填充角色图」跑动中（只锁按钮，不参与停止队列）
      askBatch: null,
      // 项目角色场景库相关的四个弹窗：手动新增 / 从库导入 / 写入镜头 / 批量入库
      askAdd: null, askImport: null, askWrite: null, askLibSave: null, askDerive: null,
      // 删除整张卡片的确认弹窗（与「删图」区分：删卡删档案与提示词，图片文件留在磁盘）
      askCard: null,
      // 「本集新增卡片是否入库」的询问去重键（同一个集的同一批卡片只问一次，避免每次重建都弹）
      _libAskFor: '',
      // 有生成在跑时 = 该次生成所属的集 id；切集时改置 'SWITCHED'（收尾写库守卫据此丢弃，防旧集数据写进新集）
      _busyEpId: null,
      /**
       * 「一条龙」运行态（2026-10-16）：`{ on, step, detail, n, total, stop }`。
       * 只在内存里（刷新即消失）—— 它描述的是「此刻跑到第几步」，不是需要持久化的事实。
       * 卡片上方那条进度条读它；`stop` 由进度条上的「停止」按钮置位（与批量按钮的停止同口径）。
       */
      auto: { on: false, step: '', detail: '', n: 0, total: 2, stop: false },
      // 🔴 Teleport 延迟挂载开关：切集时 <section :key> 整棵重建，mounted 前 #chars-batch 不在文档里
      tpReady: false
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    /** 是否有卡片的档案改过、提示词还没重算（标题栏「批量生成提示词」的琥珀态，2026-10-19） */
    anyProfStale() { return this.cards.some(c => profileDirty(c)) },
    /** 当前生图方案是否支持图生图（不支持时点缩略图只预览、不当底图） */
    capsI2i() { const c = this.st.caps && this.st.caps.image; return !c || c.i2i !== false },
    /**
     * 单一网格的摆放顺序（2026-10-08 改）：先角色、后场景；**同一主体（`主体名--视角`）的卡强制相邻**，
     * 父卡（名字正好等于主体名的那张）排在组内第一。每项带上在 cards 里的真实下标。
     * 没有双横杠命名时行为与改造前完全一致（每张卡各自成组，组序 = 原下标序）。
     *
     * 🔴 2026-10-13（Dragon）：**组内有主体卡时，视角变体卡不再进网格** —— 它们收进主体卡大预览图
     *    下缘的**视角浮层**里。网格里卡片数 = 主体数，不再随视角数增长（改造前三视图一出就多两张同样大的卡）。
     *    这只是渲染层的收拢：视角卡在 chars.json 里仍是独立条目 —— 共用主体档案、`_manual` 豁免
     *    重生成分镜的清理、一键填充整组、级联删除、H3 原生多视角合并全部照旧。
     * 🔴 缺主体卡的组（本组没有名字正好等于主体名的那张卡）**保持老行为**：视角卡照样各自成卡 ——
     *    否则整组会从界面上消失，用户也没有入口去点「建主体卡」。
     */
    ordered() {
      const rank = { character: 0, scene: 1 }
      const groups = groupCards(this.cards)
      const withParent = {}
      for (const g of groups) if (g.parent) withParent[g.base] = true
      groups.sort((a, b) => {
        const ra = rank[(this.cards[a.first] || {}).kind] || 0
        const rb = rank[(this.cards[b.first] || {}).kind] || 0
        return (ra - rb) || (a.first - b.first)
      })
      const out = []
      for (const g of groups) {
        const items = g.items.slice()
        if (g.parent) {
          const at = items.findIndex(o => o.i === g.parent.i)
          if (at > 0) { const p = items.splice(at, 1)[0]; items.unshift(p) }
        }
        for (const o of items) {
          // 组内有主体卡 → 视角卡由主体卡内的视角条呈现，不再单独占一格
          if (withParent[g.base] && isVariant(o.c && o.c.name)) continue
          out.push(o)
        }
      }
      return out
    },
    /** 渲染用：主体名 → 组（含 parent / variantCount），组色与「缺父卡」黄标都从这里取数 */
    grpMap() {
      const m = {}
      for (const g of groupCards(this.cards)) m[g.base] = g
      return m
    },
    /** 「新增角色 / 场景」弹窗的内联校验（2026-10-08）：撞名、或写了视角卡名 → 就地报错 + 禁用「新增」，
     *  不关弹窗。视角卡只允许从主体卡的「+」派生，所以这里把 `主体名--视角` 一律挡掉。 */
    addErrMsg() {
      const a = this.askAdd
      if (!a) return ''
      const n = String(a.name || '').trim()
      if (!n) return ''
      const kind = a.kind === 'scene' ? 'scene' : 'character'
      if (hasSep(n)) {
        return '「' + n + '」是变体卡写法（双横杠），不能手工创建。请回到主体卡「' + baseOf(n) +
          '」，点它名字旁边的「+」派生 —— 主体名会自动带上，你只填视角名（正面 / 侧面 / 内饰…）或装扮名（婚装 / 常服…）。'
      }
      if (this.cards.some(c => c.kind === kind && c.name === n)) return '本集已有同名' + (kind === 'scene' ? '场景' : '角色') + '卡'
      return ''
    },
    /** 「派生变体卡」弹窗将要创建的完整卡名（主体名 + 双横杠 + 变体名）；变体名为空时返回空串 */
    deriveName() {
      const a = this.askDerive
      if (!a) return ''
      const s = String(a.suffix || '').trim()
      return s ? (a.base + '--' + s) : ''
    },
    /** 「派生变体卡」弹窗的内联校验（2026-10-16：变体名按类型称呼 —— 视角名 / 装扮名） */
    deriveErr() {
      const a = this.askDerive
      if (!a) return ''
      const s = String(a.suffix || '').trim()
      if (!s) return ''
      const noun = a.outfit ? '装扮名' : '视角名'
      if (hasSep(s)) return noun + '里不能再出现双横杠（那是主体与变体之间的分隔符）—— 只填「正面 / 侧面 / 婚装」这样的短词即可。'
      if (s.length > 16) return noun + '太长了（不超过 16 个字）。写成「正面 / 左前 / 内饰」「婚装 / 常服」这样的短词更好认。'
      if (this.cards.some(c => c.kind === a.kind && c.name === this.deriveName)) return '本集已有「' + this.deriveName + '」这张卡了'
      return ''
    },
    /** 依赖每秒自增的 tick，让「生成中 已用 X」实时刷新 */
    live() { return this.pl.tick },
    /** 分镜生成进行中（阶段3 一次产出 分镜+角色/场景档案）→ 本块同步显示进度条，表示两块同时工作 */
    shotsGening() { return !!this.pl.genStartAt[2] },
    /** 项目角色场景库条目（响应式读 store：库里改了本块要立刻反映，如下拉选项、黄标） */
    libAll() { return this.st.libEntries(this.ep && this.ep.projectId) },
    /**
     * 场景档案体检（纯函数）：以本集镜头的场景名为事实基准，找「缺档案 / 档案为空 / 档案挂错名字」。
     * 模型在分镜那批输出里偶会漏写档案、或把同一场景写成两种拼法（实测三项目里中两个），
     * 结果档案挂在没有镜头使用的名字上、镜头真正在用的卡却空着 → 生图退化成通用空镜。
     */
    scIssues() {
      const ep = this.ep
      // 用「当前卡片」而不是 ep.scenes：卡上刚改的档案要立刻反映（ep.scenes 要等落库才同步）
      return sceneCardIssues((ep && ep.shots) || [], this.cards.filter(c => c.kind === 'scene'))
    },
    /** 本集有几张卡来自项目库（标题行计数用） */
    libCount() { return this.cards.filter(c => c.libId).length },
    /** 库中可导入本集的条目（本集还没有同类型同名的卡） */
    importable() {
      return this.libAll.filter(e => !this.cards.some(c => c.kind === e.kind && c.name === e.name))
    }
  },
  watch: {
    'st.current'(ep) {
      // 生成在跑时切了集：自动请求停止（当前条目跑完即停，剩余丢弃）；
      // 并把 _busyEpId 置哨兵，让在途任务的收尾写库被守卫丢弃——否则旧集数据会写进新集
      if (this.batchP || this.batchI || this.busy) {
        this.batchPStop = this.batchIStop = true
        this._busyEpId = 'SWITCHED'
        this.$root.toast('已切换剧集：当前条目完成后批量停止，剩余任务丢弃')
      }
      // 切集 → 视角浮层回到「看主体卡那张」（纯界面态、卡名是集内局部的，绝不跨集保留；
      // 🔴 init 里刻意不清，见那边的注释）
      this.viewSel = ''
      if (ep) this.init(ep)
    },
    // 🔴 各块常驻挂载（无锁定随时可见）：分镜/档案在别处生成后要立即反映到这里
    'st.current.chars'() { this.rebuildSoon() },
    'st.current.scenes'() { this.rebuildSoon() },
    'st.current.shots'() { this.rebuildSoon() },
    // 🔴 自动流程（2026-10-16 · Dragon「不需要用户点识别装扮；你自动识别出来并且建卡」）：
    //    分镜生成完会置一张票（`st.requestAuto`），这里收到就自己把「图片提示词 → 识别装扮 → 建派生卡」
    //    跑完 —— 用户只需要点那一次「生成分镜」。票走 store 中转的理由见 project.js 的 requestAuto。
    'st.autoReq'(v) { this.onAutoReq(v) },
    'pl.active'(v) {
      if (v !== 3 || this.busy) return
      // 🔴 进入本块必须按「上一阶段的最新产出」重建卡片：
      //    组件在打开剧集时就全部挂载了，那一刻分镜还不存在；
      //    用户生成完分镜点「下一步」只是把数据写进 st.current（同引用，watch('st.current') 不触发）。
      // 🔴 批量入库询问**只在「刚确认完上一阶段」时弹**：confirm(i) 会刷新 pl.times[i].at 时间戳，
      //    用它判断（比 watch 的 ov 可靠 —— e2e/切集路径下 ov 未必是 2）。只判 v === 3 也不够：
      //    用户后来改分镜里的场景名/角色名 → 冒出新卡 → 以后每次进块都弹「保存到项目库？」，
      //    烦人且这个弹窗不关会压住全页面（e2e 实测踩到）。
      //    之后新增的卡走单卡「保存到项目」补录，或下次生成分镜确认时再问。
      const t = (this.pl.times && this.pl.times[2]) || null
      const justConfirmed = !!(t && t.at && Date.now() - t.at < 8000)
      this.syncFromEpisode().then(() => { if (justConfirmed) this.maybeAskLibSave() })
    }
  },
  created() { if (this.ep) this.init(this.ep) },
  /** 🔴 批量按钮 Teleport 延迟挂载：mounted 后 DOM 才真正插入文档，#chars-batch 此时才可被命中 */
  mounted() {
    this.$nextTick(() => { this.tpReady = true })
  },
  methods: {
    ratioLabel,
    resLabel,
    /** 分镜/档案在他处更新后延迟重建（合并同帧多次触发；生成中不重建） */
    rebuildSoon() {
      clearTimeout(this._rt)
      this._rt = setTimeout(() => { if (this.ep && !this.busy) this.init(this.ep) }, 150)
    },
    /** 按当前剧集重建卡片（进入本块时调用；档案/出图/分辨率都会保留） */
    async syncFromEpisode() { if (this.ep) await this.init(this.ep) },

    /* ================= 项目角色场景库（跨集共享的角色/场景条目） ================= */
    /** 该卡是否「从项目库加载」的只读副本（编辑入口全禁，改要去库编辑区） */
    isLibRo(c) { return c.libReadonly === true },
    /** 库条目（按 id，响应式读 store） */
    libEntry(id) { return this.libAll.find(e => e.id === id) || null },
    /** 库版本落后（库改过 → 本集副本是旧的）；点「忽略」后消失 */
    libStale(c) {
      return !!(c.libId && c.libRevAt && c._libRevNow > c.libRevAt && c._libAck !== c._libRevNow)
    },
    /** 基础名：「李白-少年」→「李白」；「张伯 (2)」→「张伯」 */
    libBase(name) {
      const s = String(name || '').trim().replace(/\s*\(\d+\)$/, '')
      const i = s.indexOf('-')
      return i > 0 ? s.slice(0, i) : s
    },
    /** 库里同基础名的其它变体（**只对角色**；场景名里的「-」是地名的一部分，不能当分隔符）——只读卡的切换下拉用 */
    libVariantsOf(c) {
      if (!this.isLibRo(c) || c.kind !== 'character') return []
      const base = this.libBase(c.name)
      return this.libAll.filter(e => e.kind === 'character' && this.libBase(e.name) === base)
    },
    /** 把卡当前内容打包成库条目 payload */
    libPayload(c) {
      const ep = this.ep
      return {
        kind: c.kind, name: c.name, role: c.role,
        profile: c.profile, prompt: c.prompt, negative: c.negative,
        res: c.res, cur: c.cur,
        from: ep ? { episodeId: ep.id, epName: ep.name } : null
      }
    },
    /** 本集新增卡 → 保存到项目库（撞名时主进程自动加序号并把最终名字返回） */
    async saveToLib(c) {
      const ep = this.ep
      if (!ep) return
      const card = this.liveCard(c)
      const L = stepLog(TAG)
      try {
        const r = await this.st.saveLibrary(ep.projectId, this.libPayload(card))
        if (!r || !r.entry) throw new Error('入库失败')
        card.libId = r.entry.id
        card.libRevAt = r.entry.libRev || 1
        card.libReadonly = false
        card._libRevNow = card.libRevAt
        // 🔴 把本集的图推一份到库条目目录：库条目扫的是 assets/<类型>/<条目id>/，而本集卡的图在集私有
        //    目录里（见 rootOf），不推过去库里的这张卡就是没图的。图片从此是两份独立副本，各自重生成互不影响。
        const pic = await this.pushImagesToLib(card, r.entry)
        if (r.renamed) {
          card.name = r.entry.name
          this.$root.toast('库里已有同名条目，已存为「' + r.entry.name + '」；请核对分镜里的写法')
        } else {
          this.$root.toast('已保存到项目角色场景库：「' + card.name + '」' + (pic ? '（图片 ' + pic + ' 张）' : ''))
        }
        await this.saveAll()
        this.st.invalidateMedia(ep.projectId, 'library')
        L.done('保存到项目库：' + r.entry.name)
      } catch (e) { L.fail('保存到项目库失败', null, e); this.st.fail(e) }
    },
    /** 已入库的本地卡 → 把本集改动推回库（库版本 +1，引用它的其它集会提示重新生成） */
    async updateToLib(c) {
      const ep = this.ep
      if (!ep) return
      const card = this.liveCard(c)
      if (!card.libId) return this.saveToLib(card)
      const L = stepLog(TAG)
      try {
        const p = this.libPayload(card)
        delete p.name
        const r = await this.st.saveLibrary(ep.projectId, Object.assign(p, { updateId: card.libId }))
        card.libRevAt = (r && r.entry && r.entry.libRev) || (card.libRevAt + 1)
        card._libRevNow = card.libRevAt
        card._libAck = card.libRevAt
        // 本集新出的图也一起推给库（只增不删）
        if (r && r.entry) await this.pushImagesToLib(card, r.entry)
        await this.saveAll()
        this.st.invalidateMedia(ep.projectId, 'library')
        this.$root.toast('已更新到项目库：「' + card.name + '」')
      } catch (e) { L.fail('更新到项目库失败', null, e); this.st.fail(e) }
    },
    /** 「按库更新本卡」：用库条目内容覆盖本集副本（保留本集名字与库来源标记） */
    async updateFromLib(c) {
      const card = this.liveCard(c)
      const e = this.libEntry(card.libId)
      if (!e) { this.$root.toast('库条目已不存在，无法更新'); return }
      card.role = e.role || card.role
      if (e.profile) card.profile = normalizeProfile(e.profile)
      if (e.prompt) card.prompt = e.prompt
      card.negative = e.negative || card.negative || DEFAULT_NEG
      if (e.res) card.res = e.res
      if (Array.isArray(e.images) && e.images.length) {
        card.candidates = e.images.slice()
        // candidates 已换成库那边的图名 → 文件得跟着进本集目录，否则本集的图框会是空的
        // （本集卡看的是集私有目录，库的图在共享目录，两处已分开）
        await this.pullImagesFromLib(card)
      }
      if (typeof e.cur === 'number' && e.cur >= 0) card.cur = e.cur
      card.libRevAt = e.libRev || card._libRevNow
      card._libAck = card.libRevAt
      card._imgRev = (card._imgRev || 1) + 1
      await this.saveAll()
      this.$root.toast('已按项目库更新「' + card.name + '」；引用它的镜头提示词已标 ⚠')
    },
    /** 忽略库更新提示（不重新生成也让它消失） */
    async ackLib(c) {
      const card = this.liveCard(c)
      card._libAck = card._libRevNow
      await this.saveAll()
    },

    /* ---- 集私有素材 ↔ 库素材：两处目录分开后，跨目录的动作要显式搬图（都只增不删，源图保留） ---- */
    /** 本集私有图目录（rootOf 里 libReadonly=false 那一侧） */
    privateDirOf(kind, name) { return this.dirOf({ kind, name, libReadonly: false }) },
    /** 库条目图目录（rootOf 里 libReadonly=true 那一侧，目录名就是条目 id） */
    libDirOf(kind, id) { return this.dirOf({ kind, name: id, libReadonly: true }) },
    /** 本集私有的图 → 库条目目录（入库 / 更新到库时调用，让库里的这张卡有图） */
    async pushImagesToLib(card, entry) {
      if (!entry || !entry.id) return 0
      const from = this.privateDirOf(card.kind, card.name)
      const to = this.libDirOf(card.kind, entry.id)
      if (!from || !to || from === to) return 0
      try { return await window.studio.copyDir(from, to) } catch (_) { return 0 }
    },
    /** 库条目的图 → 本集目录（「按库更新本卡」时调用，candidates 已换成库那边的图名） */
    async pullImagesFromLib(card) {
      if (!card.libId) return 0
      const from = this.libDirOf(card.kind, card.libId)
      const to = this.privateDirOf(card.kind, card.name)
      if (!from || !to || from === to) return 0
      try { return await window.studio.copyDir(from, to) } catch (_) { return 0 }
    },

    /** 切换变体：把本集这张只读卡换成库里另一个条目（连带把分镜/对白里的旧名换掉、参考图路径改到新目录） */
    async switchVariant(c, id) {
      const ep = this.ep
      const card = this.liveCard(c)
      const e = this.libEntry(id)
      if (!ep || !card || !e || e.id === card.libId) return
      const oldName = card.name, newName = e.name
      // 参考图路径重写要知道两张卡各自的图根：旧卡按它当前归属、新卡一定是库条目（只读视图）
      const oldDir = this.dirOf({ kind: card.kind, name: oldName, libReadonly: card.libReadonly === true })
      const newDir = this.dirOf({ kind: card.kind, name: newName, libReadonly: true })
      const L = stepLog(TAG)
      try {
        const touched = await window.studio.librarySwap(this.st.workspace, ep.projectId, ep.id, card.kind, oldName, newName, e.id)
        const fixed = await this.rewriteRefsDir(oldDir, newDir)
        ep.shotsSyncAt = Date.now()      // 分镜里的名字已被主进程改掉 → 让分镜块按最新工件重建
        card.name = newName
        card.libId = e.id
        card.libRevAt = e.libRev || 1
        card._libRevNow = card.libRevAt
        card._libAck = card.libRevAt
        card.libReadonly = true
        card.role = e.role || card.role
        card.profile = normalizeProfile(e.profile || '')
        card.prompt = e.prompt || ''
        card.negative = e.negative || card.negative || DEFAULT_NEG
        if (e.res) card.res = e.res
        card.candidates = Array.isArray(e.images) ? e.images.slice() : []
        card.cur = (typeof e.cur === 'number' && e.cur >= 0) ? e.cur : -1
        card._imgRev = (card._imgRev || 1) + 1
        await this.saveAll()
        this.$root.toast('已把本集「' + oldName + '」切换为库里的「' + newName + '」' +
          ((touched && touched.length) || fixed ? '，并同步了分镜/对白与参考图路径' : ''))
        L.done('切换变体：' + oldName + ' → ' + newName)
      } catch (err) { L.fail('切换变体失败', null, err); this.st.fail(err) }
    },
    /** 把本集镜头参考图 / 首尾帧里指向 oldDir 的路径改成 newDir（换变体后旧路径会指向另一个人） */
    async rewriteRefsDir(oldDir, newDir) {
      const ep = this.ep
      if (!ep || !oldDir || !newDir || oldDir === newDir) return 0
      const prompts = JSON.parse(JSON.stringify(ep.prompts || []))
      let n = 0
      const fix = (p) => {
        if (typeof p !== 'string' || p.indexOf(oldDir) !== 0) return p
        n++
        return newDir + p.slice(oldDir.length)
      }
      for (const pr of prompts) {
        if (!pr || !pr.refs) continue
        if (Array.isArray(pr.refs.images)) pr.refs.images = pr.refs.images.map(fix)
        if (pr.refs.first) pr.refs.first = fix(pr.refs.first)
        if (pr.refs.last) pr.refs.last = fix(pr.refs.last)
      }
      if (n) { await this.st.saveArtifact('prompts', prompts); ep.promptsSyncAt = Date.now() }
      return n
    },

    /* ================= 手动新增 / 从库导入 / 写入镜头 / 批量入库 ================= */
    openAdd(kind) { this.askAdd = { kind, name: '' } },
    /** 打开「派生变体卡」弹窗（2026-10-08，Dragon）：入口只在主体卡的名字角标旁。
     *  主体名取 baseOf(卡名) 而不是卡名本身 —— 万一这组的父卡刚被删、只剩下一张
     *  `V9X--正面`，从它派生出来的也应该是 `V9X--侧面`，而不是 `V9X--正面--侧面`。
     *  🔴 2026-10-16：同一个弹窗多了一个「类型」切换 —— 视角变体（正面/侧面/内饰…）/
     *     装扮变体（婚装/常服/夜行装…）。outfit=false 时行为与改造前逐字一致。 */
    openDerive(c) {
      const card = this.liveCard(c)
      if (!card) return
      if (!this.isParentCard(card)) { this.$root.toast('只有主体卡能派生变体卡'); return }
      this.askDerive = { kind: card.kind, base: baseOf(card.name), suffix: '', outfit: false }
    },
    /** 新增一张空白本集卡（名字手填，档案与提示词留空，之后照常补） */
    async doAdd() {
      const a = this.askAdd
      if (!a) return
      const name = String(a.name || '').trim()
      if (!name) return
      const kind = a.kind === 'scene' ? 'scene' : 'character'
      // 🔴 视角卡名不允许手工创建（2026-10-08，Dragon）：只允许从主体卡的「+」派生 ——
      //    主体名由系统拼、用户只填视角名，既不会与已有子卡撞名，也不会有「全角/半角横杠、
      //    1 个还是 2 个」这类写错（parseName 认 8 种横杠类字符，只查 ASCII `--` 等于拦了个假的）。
      if (hasSep(name)) {
        this.$root.toast('「' + name + '」是视角卡写法：请回到主体卡「' + baseOf(name) + '」点「+」派生'); return
      }
      if (this.cards.some(c => c.kind === kind && c.name === name)) {
        this.$root.toast('本集已有同名' + (kind === 'scene' ? '场景' : '角色') + '卡'); return
      }
      this.askAdd = null
      const defRes = (this.ep && this.ep.res && this.ep.res.img) || '1920x1080'
      this.cards.push({
        kind, name, role: kind === 'scene' ? '场景' : '配角',
        profile: '', _profRevAt: 0, _profRev: 0, _profAck: 0,
        prompt: '', negative: DEFAULT_NEG,
        promptMs: 0, promptAt: 0, candidates: [], cur: -1, res: defRes, genMs: 0,
        _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0,
        // 🔴 手动新增标记（2026-10-07）：重新生成分镜时档案一律按本次结果重建（buildArchive），
        //    历史角色不再保留 —— 但手工加的卡本来就不在分镜里（用户加完要自己「写入镜头」），
        //    不豁免的话等于把用户的手工活一起清了。
        _manual: true
      })
      await this.saveAll()
      this.$root.toast('已新增' + (kind === 'scene' ? '场景' : '角色') + '卡：「' + name + '」；记得用「写入镜头」把它写进相关镜头')
    },
    /**
     * 派生一张视角变体卡（2026-10-08，Dragon）：名字**固定**为「主体名--视角名」，由系统拼，用户只填视角名。
     * - 档案留空：视角卡共用主体卡的档案，填了也不下发（见 src/variant.js 的 groupProfiles）。
     * - 正负提示词从主体卡复制一份当起点：这样「文生图」按钮立即可用，用户按视角微调即可。
     * - 🔴 图片**绝不复制**主体卡的图：复制出来的就是同一张图重复占位（白占 MAX_REF_IMG=9 的一格，
     *   V9X-2 里 `V9X.jpg` 与 `V9X--正面.jpg` md5 完全相同就是这么来的）。要用户自己导这一视角的图。
     * - 🔴 `_manual: true` 不是可选项：视角卡的名字**永远不会出现在分镜里**（分镜只写主体名），
     *   重新生成分镜时 `buildArchive` 只认本次结果 + 豁免卡，它会像手动卡一样被静默清掉。
     */
    async doDerive() {
      const a = this.askDerive
      if (!a) return
      const name = this.deriveName
      if (!name) { this.$root.toast(a.outfit ? '请先填装扮名（如 婚装 / 常服 / 夜行装）' : '请先填视角名（如 正面 / 侧面 / 内饰）'); return }
      if (this.deriveErr) { this.$root.toast(this.deriveErr); return }
      const suffix = String(a.suffix || '').trim()
      const parent = this.cards.find(c => c.kind === a.kind && c.name === a.base) || null
      // 🔴 装扮变体（2026-10-16）：指令由 views.md 的 换装 + 换装约束 两行拼出（`{装扮}` 换成用户填的名字），
      //    其中的 `{…}` 槽留给用户补这套装扮的服装描述 —— 补完才允许「重出这一装扮」（regenView 有护栏）。
      //    views.md 读不到「换装」行 → 不发残缺指令，中止派生并说清去哪儿补。
      const outfitInstr = a.outfit ? this.outfitInstrOf(suffix) : ''
      if (a.outfit && !outfitInstr) { this.$root.toast('读不到 views.md 的「换装」兜底行：先补上那两行（换装 / 换装约束）再派生'); return }
      this.askDerive = null
      const defRes = (this.ep && this.ep.res && this.ep.res.img) || '1920x1080'
      this.cards.push({
        kind: a.kind, name, role: (parent && parent.role) || (a.kind === 'scene' ? '场景' : '配角'),
        profile: '', _profRevAt: 0, _profRev: 0, _profAck: 0,
        // 视角变体沿用主体卡的提示词（那张卡的 prompt 就是「这一视角的编辑指令」，由 regenView 用）；
        // 装扮变体直接拿换装指令当 prompt（右栏可手改，改的就是要发给生图模型的那句）
        prompt: a.outfit ? outfitInstr : ((parent && parent.prompt) || ''),
        negative: (parent && parent.negative) || DEFAULT_NEG,
        promptMs: 0, promptAt: 0, candidates: [], cur: -1,
        res: (parent && parent.res) || defRes, genMs: 0,
        _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0,
        _manual: true,
        // 'outfit' = 装扮变体（不进「一键填充整组」的整组名单；主体卡的「一键填充」在本集识别过装扮时
        //            会按镜头逐镜填对的那张，见 fillByOutfits）
        // 'view'   = 视角变体（三视图派生，一切行为与改造前逐字一致）
        _varKind: a.outfit ? 'outfit' : 'view',
        // 手动派生这条路没有装束描述（用户自己在右栏把 `{装束}` 补进指令里）；
        // 生成分镜时自动识别装扮的那条路会把识别出的描述一并写进来
        _varDesc: ''
      })
      await this.saveAll()
      this.$root.toast(a.outfit
        ? '已派生装扮卡「' + name + '」：右栏指令里的「{装束}」补上这套装扮的服装与配饰（可从档案的「服装」字段抄），再点「重出这一装扮」——它会拿主体卡当前的图当参考，只换衣服'
        : '已派生「' + name + '」（' + suffix + ' 视角）：点小预览图区的「+」导入这一视角的图，' +
          '再点主体卡的「一键填充整组」把它写进镜头')
    },
    /**
     * 装扮变体的编辑指令 = views.md 的「换装」句（`{装扮}` ← 装扮名，`{装束}` ← 装束描述）+「换装约束」句（逗号连接）。
     * 🔴 读不到「换装」行就返回空串 —— 调用方据此中止派生（宁可不做，也不发半句残缺指令；
     *    同三视图那套判据：`!!VIEW_TPL.side && !!VIEW_TPL.back` 才开工）。
     * 🔴 两个槽**可能填不满**（手动路径只填了装扮名 / 识别结果缺描述）→ 返回值里会留着 `{装束}`，
     *    所以它不能直接发给生图模型：regenView 有「还剩花括号就拦住」的护栏，别把那条删了。
     *    自动路径（装扮清单识别）两个槽都由程序填满 → 返回值里没有花括号，卡建出来即可直接出图。
     * @param {string} attr 装扮名（如 婚装）
     * @param {string} desc 装束描述（服装 + 配饰 + 头饰；可空）
     */
    outfitInstrOf(attr, desc) {
      const main = String(VIEW_TPL.outfit || '').trim()
      if (!main) return ''
      const a = String(attr || '').trim()
      // 🔴 描述要过清洗（2026-10-16 端到端实测连踩两次）：`{装束}` 两侧的逗号和后续句子是模板写死的，
      //    所以槽里必须是**逗号短语串**而不能自成句 —— 句子以「。」结尾会拼出「。，」；更隐蔽的是
      //    句中带句号（模型写成「…无配饰，黑发以素色布带束于顶。」），只去尾部治不了，会在句中拼出「。，」。
      //    清洗规则统一收在 promptlib.tidyOutfitDesc（句末标点一律降级为逗号 + 去花括号 + 折叠分隔符）。
      const d = tidyOutfitDesc(desc)
      let s = main
      if (a) s = s.replace('{装扮}', a)
      if (d) s = s.replace('{装束}', d)
      return [s, VIEW_TPL.outTail].filter(Boolean).join('，')
    },
    /* ================= 装扮清单：从分镜的服装记录里识别装扮并自动建派生卡（2026-10-16，Dragon） =================
       出发点：**用户不该写提示词、也不该点任何「识别」按钮**（二次拍板原话：
       「不需要用户点『识别装扮』；你自动识别出来并且建卡……把这个按钮去掉」）。
       原料早就在库里 —— 分镜抽取时本来就逐镜产出了 continuity（本镜状态快照，「服装」只是其中一个维度）
       与 change（本镜实际发生的换装「旧 → 新」）。所以「这个角色在本集穿了几套、第几镜换的」
       是**已有数据里的显式事实**，不需要重新读剧本去猜。
       🔴 两个纯函数段（面板时代留下的分层，现在只由自动流程调用）：
         · identifyOutfitsOf —— 把该角色的镜头服装记录丢给大模型，让它归并措辞、起名、写装束描述
         · deriveOutfitCards —— 幂等派生 `主体--装扮名` 卡，把描述填进换装指令的 `{装束}` 槽
                               （→ 卡建出来就是可直接出图的完整指令，没有花括号）
       🔴 调用点只有一处：`runAuto`（生成分镜之后）。出图走「生成图片」批量、填镜头走「一键填充」。
       🔴 幂等：同名卡已存在就**不覆盖**它的指令（重跑识别不该毁掉用户手工调过的句子），只在指令为空时补。 */
    /**
     * 本集已有的装扮卡 → 装扮条目。卡上只存指令与 `_varDesc`（装束描述），**不存 kw**，
     * 所以补进来的条目 kw 只放名字本身 —— 它够用来「让模型沿用这个名字」，不够用来做镜头匹配。
     */
    outfitCardsOf(base) {
      const out = []
      for (const c of this.cards) {
        if (!c || c.kind !== 'character') continue
        if (baseOf(c.name) !== base) continue
        // 🔴 2026-10-20（Dragon 报障「H10 产品图一键填充整组总是失败」的根因）：
        //    这里以前只判 variantOf(name)，把**视角变体卡**（`主体--正面/侧面/背面`）也算成了装扮卡 ——
        //    两种变体都用双横杠，只差 `_varKind` 一个字段。后果是一条链：
        //      view 卡 → outfitListOf 非空 → fillRefs 误判「这角色有装扮」→ 走逐镜装扮口径
        //      → 清单里全是 base:false（视角卡）→ 「没有标出基线装束」直接放弃 → 一个镜头都填不进去。
        //    修法：装扮卡只认 `isOutfitVar`（`_varKind === 'outfit'`，派生装扮卡时写入）。
        if (!this.isOutfitVar(c)) continue
        const v = variantOf(c.name)
        if (!v) continue                       // 主体卡自己（定妆图）不是装扮
        out.push({ name: v, desc: c._varDesc || '', kw: [v], base: false })
      }
      return out
    },
    /**
     * 这个主体**已有的全套装扮**（名字 / 描述 / kw）—— 一个来源，两个用途：
     *   ① 识别时的 `{{known}}` 槽：把已有名字下发给模型，让它沿用（跨集继承）
     *   ② 「按装扮填全部镜头」的匹配依据：`matchOutfit` 靠 kw 把每一镜的服装描述归到某套装扮
     * 两个来源缺一不可：
     *   · **项目清单**（<项目>/assets/outfits.json）带上一集识别出的 名字 / 描述 / kw —— 名字稳定靠它；
     *   · **本集装扮卡**是「这个名字已经有卡了」的直接证据（用户手工建的卡、或清单还没落盘的中间态）。
     *     只认清单的话，手工建的卡在识别时不算已有名字 → 模型会另起一个 → 同一套装扮两张卡。
     * 顺序：清单里的在前（基线标记也随之保留），卡补进来的追加在后 —— 与卡片显示顺序无关。
     */
    outfitListOf(base) {
      const pid = this.ep && this.ep.projectId
      const list = (this.st.outfitsOf(pid, base) || []).map(o => ({
        name: o.name, desc: o.desc, kw: o.kw, base: !!o.base
      }))
      const has = new Set(list.map(o => o.name))
      for (const e of this.outfitCardsOf(base)) {
        if (has.has(e.name)) continue
        has.add(e.name)
        list.push(e)
      }
      return list
    },
    /**
     * 识别某个角色在本集的装扮清单 —— **纯 IO 段**（唯一调用点是 runAuto）。
     *
     * 原料 = 分镜里该角色出现过的镜头 + 他的服装状态与换装点（`outfitShotBrief`），不重读剧本。
     * 返回 `[{name,desc,kw,base}]`；该角色在本集没有镜头 → 返回 null（这不是错误）。
     * 其余失败一律 throw，由调用方记进流水线日志（每个角色单独 try，一个失败不拦其余）。
     */
    async identifyOutfitsOf(card) {
      const shots = (this.ep && this.ep.shots) || []
      const brief = outfitShotBrief(shots, card.name)
      if (!brief) return null
      // 🔴 识别前先 **force 重拉**项目装扮清单（跨集继承就靠这一步）：可能刚在同一个项目的
      //    别的集里识别过，也可能上次打开集数时读取失败过。读不到就按「暂无」识别 —— 不拦。
      try { await this.st.loadOutfitBook(this.ep && this.ep.projectId, true) } catch (_) { /* 出空清单 */ }
      const known = outfitKnownBrief(this.outfitListOf(card.name))
      const system = await composeSystem({ specs: ['outfits.md', 'profile.md'], mustHave: ['"outfits"'], task: 'outfits' })
      const user = await composeUser('outfits.md', { name: card.name, profile: card.profile || '', known: known, shots: brief })
      dbgPrompt(TAG, '装扮清单 · 角色「' + card.name + '」', [['system', system], ['user', user]])
      const text = await window.studio.llmChat([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], { temperature: 0.3, maxTokens: 4096, json: true, stage: 'outfits', providerOverride: overrideOf('outfits'), label: TAG })
      const list = parseOutfitList(text)
      if (!list.length) throw new Error('模型没有给出任何装扮；原始返回：' + String(text || '').slice(0, 120))
      return list
    },
    /**
     * 派生装扮卡（**核心段**，唯一调用点是 runAuto 的第 ② 步）。
     *
     * 指令 = views.md 的换装行（`{装扮}` ← 装扮名、`{装束}` ← 识别出的描述）+ 换装约束 —— 两个槽都填满，
     * 所以卡建出来**没有花括号残留**、可以直接出图，用户一个字都不用写。
     * 幂等：同名卡已存在 → 保留它的指令（可能是用户手工调过的），只在指令空缺时补全。
     *
     * 🔴 只建卡、**不出图**（2026-10-16 二次拍板）：出图统一走「生成图片」（装扮卡排在它的主体卡之后，
     *    拿主体卡的定妆图当参考走编辑通道）。所以这里不再返回「要不要顺手出图」这种参数。
     *
     * @param {string} baseName 主体名（基础名）
     * @param {string} kind     'character' | 'scene'
     * @param {Array}  list     识别结果（parseOutfitList 的产物）
     * @param {string[]} picked 要派生的装扮名（不含基线）
     * @returns {{created:string[],reused:string[],kept:string[],todo:string[]}} todo = 派生完还没有图的卡名
     */
    async deriveOutfitCards(baseName, kind, list, picked) {
      const empty = { created: [], reused: [], kept: [], todo: [] }
      const card = this.cards.find(c => c.kind === kind && c.name === baseName)
      if (!card) { this.$root.toast('找不到主体卡「' + baseName + '」'); return empty }
      const picks = (list || []).filter(o => !o.base && (picked || []).indexOf(o.name) >= 0)
      if (!picks.length) return empty
      const created = [], reused = []
      for (const o of picks) {
        const name = baseName + '--' + o.name
        // 描述先过清洗（面板里用户可能手工编辑过；parseOutfitList 已清一遍，这里兜住手改）
        const desc = tidyOutfitDesc(o.desc)
        const instr = this.outfitInstrOf(o.name, desc)
        if (!instr) { this.$root.toast('读不到 views.md 的「换装」兜底行：先补上那两行（换装 / 换装约束）再派生'); return empty }
        const hit = this.cards.find(c => c.kind === kind && c.name === name)
        if (hit) {
          // 幂等：已有同名卡 → 保留它的指令（可能是用户手工调过的），只在指令空缺时补全
          if (!String(hit.prompt || '').trim()) { hit.prompt = instr; hit._varDesc = desc }
          reused.push(name)
          continue
        }
        this.cards.push({
          kind, name, role: card.role || '配角',
          profile: '', _profRevAt: 0, _profRev: 0, _profAck: 0,
          prompt: instr, negative: card.negative || DEFAULT_NEG,
          promptMs: 0, promptAt: 0, candidates: [], cur: -1,
          res: card.res || (this.ep && this.ep.res && this.ep.res.img) || '1920x1080', genMs: 0,
          _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0,
          _manual: true, _varKind: 'outfit', _varDesc: desc
        })
        created.push(name)
      }
      await this.saveAll()
      // 🔴 跨集继承：把本次结果并进**项目级**装扮清单（同名沿用旧名、描述取新、kw 取并集）。
      //    落盘失败只影响下一次识别的「已知名字」（大不了模型重起一个名字），不能拦掉已经建好的卡。
      const pid = this.ep && this.ep.projectId
      const seenBefore = new Set((this.st.outfitsOf(pid, baseName) || []).map(o => o.name))
      const kept = (list || []).filter(o => seenBefore.has(o.name)).map(o => o.name)
      try { await this.st.recordOutfits(pid, baseName, list) } catch (_) { /* 清单是辅助信息，失败不拦 */ }
      const all = picks.map(o => baseName + '--' + o.name)
      // 需要出图的 = 建出来的 + 已存在但还没图的（`saveAll` 之后 this.cards 已重建，按名字现查）
      const todo = all.filter(n => { const c = this.cards.find(x => x.name === n); return c && !(c.candidates || []).length })
      return { created, reused, kept, todo }
    },
    /* ================= 三视图（2026-10-13，Dragon） ================= */
    /**
     * 勾选框（生成3视图）变化 → 落库。
     * 🔴 v-for 里的 it.c 只是个视图引用，改动要走 liveCard 取到的实时卡，
     *    否则下一条 saveAll 会拿旧值把标记冲掉（同 2026-09-27 图生图底图标记那个坑）。
     */
    async setThreeView(c, on) {
      const card = this.liveCard(c)
      card.threeView = !!on
      await this.saveAll()
      this.$root.toast(on
        ? '「' + card.name + '」已开启三视图：下次生图会依次出 正面 / 侧面 / 背面 三张'
        : '「' + card.name + '」已关闭三视图：只出正面一张')
    },
    /**
     * 取（或建）`主体名--视角` 视角卡。
     * 🔴 一律按**名字现查**实时卡、不缓存对象引用：saveAll() 会触发「工件变化 → init 重建」，
     *    上一轮拿到的卡片 proxy 会失效（gen() 里也是靠这一点，在 saveAll 之后仍只读 c.name）。
     * 建卡字段与 doDerive 完全一致：档案留空（视角卡共用主体卡的档案）、图不复制主体卡的图、
     * `_manual: true`（视角名不会出现在分镜里，重生成分镜时 buildArchive 靠它豁免）。
     * @returns {object|null} 视角卡（实时 proxy）；主体卡不在了返回 null
     */
    ensureViewCard(parentName, view) {
      const parent = this.cards.find(c => c.name === parentName)
      if (!parent) return null
      const name = parentName + '--' + view
      const hit = this.cards.find(c => c.kind === parent.kind && c.name === name)
      if (hit) return hit
      this.cards.push({
        kind: parent.kind, name, role: parent.role || (parent.kind === 'scene' ? '场景' : '配角'),
        profile: '', _profRevAt: 0, _profRev: 0, _profAck: 0,
        prompt: parent.prompt || '', negative: parent.negative || DEFAULT_NEG,
        promptMs: 0, promptAt: 0, candidates: [], cur: -1,
        res: parent.res || (this.ep && this.ep.res && this.ep.res.img) || '1920x1080', genMs: 0,
        _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0,
        _manual: true,
        // 三视图派生的恒为**视角变体**（装扮变体只由用户在派生弹窗里建，程序不自动派生）
        _varKind: 'view',
        threeView: false   // 视角卡自己不再出三视图（它上面不显示勾选框；这里只是把字段写全）
      })
      return this.cards[this.cards.length - 1]
    },
    /**
     * 三视图的第 2、3 枪：拿刚出的正面图当参考，走 Qwen-Image 2.1 的**原生编辑通道**
     * 出侧面 / 背面，结果落到自动派生（或复用）的 `主体名--视角` 卡上。
     *
     * 🔴 为什么不是经典 i2i：2026-10-13 实测三轮（denoise 0.62~0.95）证明 i2i 转不动身体 ——
     *    参考图在 i2i 里是「采样起点」，构图被锚死，降噪再高也只转头不转身。编辑通道把参考图
     *    作为 reference_latents 注入 conditioning、采样起点仍是空 latent，视角才真能换过去
     *    （同批实测的对照组：不给该节点接 vae，画面就退化回 i2i 的表现）。
     * 🔴 每张单独 try：侧面失败不拦着背面，两张都失败也不影响已经落盘的正面图。
     * @param {string} parentName 主体卡名（按名现查，别传对象引用）
     * @param {string} refAbs 正面图的绝对路径（编辑通道的参考图）
     * @returns {Promise<{ok:number,total:number}>}
     */
    async genViews(parentName, refAbs) {
      const L = stepLog(TAG)
      let ok = 0
      for (let k = 0; k < VIEW_NAMES.length; k++) {
        // 每轮开头查切集哨兵：切集后剩余视角一律丢弃（同 runBatchI 的守卫）
        if (this._busyEpId === 'SWITCHED') break
        const view = VIEW_NAMES[k]
        const t0 = Date.now()
        const card = this.ensureViewCard(parentName, view)
        if (!card) { L.warn('三视图：找不到主体卡「' + parentName + '」，跳过' + view); continue }
        try {
          // 视角句 + 公共约束拼成一条编辑指令（两段都来自 views.md；负向词沿用该卡自己的）
          const instr = [view === '侧面' ? VIEW_TPL.side : VIEW_TPL.back, VIEW_TPL.tail].filter(Boolean).join('，')
          // 🔴 把**实际用的**这条指令落到卡片上（2026-10-13，Dragon）：视角卡在界面上收进主体卡的
          //    「视角条」后，那条指令的唯一编辑入口就是视角面板里的提示词框 —— 不写进去，
          //    面板打开时看到的是从主体卡复制来的外形提示词（既不是这一枪用的、改它也不生效）。
          card.prompt = instr
          L.start('三视图 ' + (k + 2) + '/3：生成「' + card.name + '」（以「' + parentName + '」的正面图为参考，走编辑通道）')
          const r = await window.studio.comfyGenerate({
            templateKey: 'character_edit', dir: this.dirOf(card), baseName: card.name,
            params: {
              prompt: instr,
              negative: card.negative || DEFAULT_NEG,
              image: refAbs,
              resolution: VIEW_RESOLUTION
            },
            label: TAG
          })
          card.candidates = [...card.candidates, ...r.files]
          card.cur = card.candidates.length - 1
          card._imgRev = (card._imgRev || 1) + 1
          card.genMs = Date.now() - t0
          ok++
          L.done('三视图 ' + (k + 2) + '/3：「' + card.name + '」生成完成：' + r.files.join('、'), Date.now() - t0)
        } catch (e) {
          L.fail('三视图 ' + (k + 2) + '/3：「' + parentName + '--' + view + '」生成失败', Date.now() - t0, e)
        }
        await this.saveAll()   // 每轮存一次：中途崩溃也不丢已经出好的那一张
      }
      return { ok, total: VIEW_NAMES.length }
    },
    /* ================= 主体卡内的「视角浮层」（2026-10-13 二改，Dragon） =================
       🔴 二改把「视角条 + 卡内手风琴面板」换成了**贴在大预览图下缘的浮层**：点浮层里的一张
          → 大图**就地**换成那张、右侧正向/负向提示词与抽卡记录一起跟着切，**没有「展开」这个态**。
          所以 `toggleView` / `openView` 一并删除；浮层的取数是 viewCards / hasViews / showCard。
       下面两个是按对象取数的壳（gen / importImg 这两个老方法签名是按下标取卡）。 */
    /** 某张卡在 cards 里的下标（gen / importImg 这两个老方法都是按下标取卡） */
    idxOf(c) { return this.cards.indexOf(c) },
    /** 视角面板里的「从本地导入」：给老 importImg(i) 包一层按对象的壳（面板里拿不到稳定下标） */
    async importImgOf(c) { await this.importImg(this.idxOf(c)) },
    /**
     * 视角面板的「重出这一视角」：以**主体卡当前选中的图**为参考，用面板里可编辑的视角指令
     * 走 Qwen-Image 2.1 的原生编辑通道重出这一张（与三视图第二、三枪同一个模板、同一个快档）。
     * 🔴 刻意不复用 gen(i)：gen 对角色卡是**文生图**，拿一条视角指令去文生图会出一个全新的正面人像
     *    （视角卡不会出现在分镜里，这条支路只可能从本面板发起，所以单独实现更安全）。
     * 🔴 参考图优先取主体卡**当前选中**的那张；一张都没选时退回最新一张（这里不像 gen 那样
     *    要求用户先点缩略图 —— 视角图的参考就是主体卡的正面图，语义唯一、没有歧义）。
     */
    async regenView(c0) {
      const c = this.liveCard(c0)
      if (!c) return
      const parentName = baseOf(c.name)
      const parent = this.cards.find(x => x.name === parentName)
      // 日志 / 提示里的说法随变体类型走（装扮变体说「装扮图」，与按钮文案同一口径）
      const what = this.isOutfitVar(c) ? '装扮图' : '视角图'
      if (!parent) { this.$root.toast('找不到主体卡「' + parentName + '」——' + what + '必须拿主体卡的图当参考'); return }
      const refF = this.selFile(parent) || parent.candidates[parent.candidates.length - 1]
      if (!refF) { this.$root.toast('主体卡「' + parentName + '」还没有图：先给它出一张，再用它当参考'); return }
      const instr = String(c.prompt || '').trim()
      if (!instr) { this.$root.toast('请先填「变体指令」'); return }
      // 🔴 装扮变体的指令里有 `{…}` 槽（要用户补这套装扮的服装描述）：还留着花括号就=把模板原样
      //    发给生图模型（出来的是「没换装」或乱画的图）→ 拦在提交前，并说清要补什么。
      if (/[{}]/.test(instr)) {
        this.$root.toast('指令里还留着「{装束}」占位符：请先把这套装扮的服装 / 配饰 / 头饰描述补进去，再点「重出这一装扮」')
        return
      }
      this.busy = true
      c._gen = true; c._genAt = Date.now()
      const t0 = Date.now()
      this.pl.beginGen(3)
      const L = stepLog(TAG)
      L.start('重出' + what + '：' + c.name + '（以「' + parentName + '」的 ' + refF + ' 为参考，走编辑通道 1024 快档）')
      try {
        const r = await window.studio.comfyGenerate({
          templateKey: 'character_edit', dir: this.dirOf(c), baseName: c.name,
          params: {
            prompt: instr, negative: c.negative || DEFAULT_NEG,
            image: this.absOf(parent, refF), resolution: VIEW_RESOLUTION
          },
          label: TAG
        })
        // await 期间存盘可能触发 init 重建 → 取实时卡再写（同 gen 的收尾写法）
        const self = this.liveCard(c)
        self.candidates = [...self.candidates, ...r.files]
        self.cur = self.candidates.length - 1
        self.genMs = Date.now() - t0
        self._imgRev = (self._imgRev || 1) + 1
        delete self._genAt
        await this.saveAll()
        this.pl.markGen(3, Date.now() - t0)
        this.st.invalidateMedia(this.ep.projectId, 'characters')
        L.done(what + '「' + c.name + '」重出完成：' + r.files.join('、'), Date.now() - t0)
        this.$root.toast('「' + c.name + '」已重出：' + r.files.join('、'))
        return true
      } catch (e) {
        const self = this.liveCard(c)
        if (self) delete self._genAt
        L.fail(what + '「' + c.name + '」重出失败', Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        const self = this.liveCard(c)
        delete self._genAt; self._gen = false
        this.busy = false; this.pl.endGen(3)
      }
    },
    openImportLib() {
      if (!this.libAll.length) { this.$root.toast('项目角色场景库还是空的'); return }
      this.askImport = { t: Date.now() }
    },
    /** 从库导入一条 → 建一张只读副本卡（本集副本仍在，只是不可改） */
    async doImport(e) {
      this.askImport = null
      if (this.cards.some(c => c.kind === e.kind && c.name === e.name)) {
        this.$root.toast('本集已有「' + e.name + '」'); return
      }
      this.cards.push({
        kind: e.kind, name: e.name, role: e.role || (e.kind === 'scene' ? '场景' : '配角'),
        profile: normalizeProfile(e.profile || ''),
        _profRevAt: 0, _profRev: 0, _profAck: 0,
        prompt: e.prompt || '', negative: e.negative || DEFAULT_NEG,
        promptMs: e.promptMs || 0, promptAt: e.promptAt || 0,
        candidates: Array.isArray(e.images) ? e.images.slice() : [],
        cur: (typeof e.cur === 'number' && e.cur >= 0) ? e.cur : -1,
        res: e.res || (this.ep && this.ep.res && this.ep.res.img) || '1920x1080', genMs: e.genMs || 0,
        _imgRev: 1, libId: e.id, libRevAt: e.libRev || 1, libReadonly: true,
        _libAck: e.libRev || 1, _libRevNow: e.libRev || 1
      })
      await this.saveAll()
      this.$root.toast('已从项目库导入「' + e.name + '」（本集为只读副本）')
    },
    /** 分镜的 chars 字段里是否已含某名字 */
    shotHasStr(s, name) {
      const raw = String((s && s.chars) || '')
      return raw.split(/[、,，/]/).map(x => x.trim()).includes(name)
    },
    openWriteShots(c) {
      const card = this.liveCard(c)
      const sel = {}
      const shots = (this.ep && this.ep.shots) || []
      // 默认勾上「还没含这个名字」的镜头，方便一次补齐（用户可再手动调整）
      shots.forEach((s, i) => { sel[i] = !this.shotHasStr(s, card.name) })
      this.askWrite = { kind: card.kind, name: card.name, sel }
    },
    writePickAll(on) {
      const a = this.askWrite
      if (!a) return
      const shots = (this.ep && this.ep.shots) || []
      shots.forEach((_, i) => { a.sel[i] = !!on })
    },
    /** 把名字写进选定镜头的 chars 字段（角色）/ scene 字段（场景） */
    async doWriteShots() {
      const a = this.askWrite
      const ep = this.ep
      if (!a || !ep) return
      const picked = Object.keys(a.sel).filter(k => a.sel[k]).map(k => +k)
      this.askWrite = null
      if (!picked.length) { this.$root.toast('没有勾选任何镜头'); return }
      const shots = JSON.parse(JSON.stringify(ep.shots || []))
      let n = 0
      for (const i of picked) {
        const s = shots[i]
        if (!s) continue
        if (a.kind === 'scene') {
          if (String(s.scene || '').trim() !== a.name) { s.scene = a.name; n++ }
        } else {
          const parts = String(s.chars || '').split(/[、,，/]/).map(x => x.trim()).filter(Boolean)
          if (parts.indexOf(a.name) < 0) { parts.push(a.name); s.chars = parts.join('、'); n++ }
        }
      }
      if (!n) { this.$root.toast('选中的镜头里已经有这个名字了'); return }
      try {
        await this.st.saveArtifact('shots', shots)
        ep.shotsSyncAt = Date.now()     // 通知常驻的分镜块按最新工件重建
        this.$root.toast('已把「' + a.name + '」写进 ' + n + ' 个镜头；可回到分镜块重新生成提示词')
      } catch (e) { this.st.fail(e) }
    },
    /** 整块生成完 → 一次性询问本集新增的卡是否入库（默认全选；**整批只问一次**） */
    maybeAskLibSave() {
      const ep = this.ep
      if (!ep || this.busy) return
      const news = this.cards.filter(c => !c.libId && !c._libAsked)
      if (!news.length) return
      // 弹出即整批标记（含点了「稍后（不保存）」的），并立刻落库：
      // 🔴 不持久化的话，重开项目 / 重新进块又会弹一遍 —— 用户上次已经答复过了；
      //    而这个弹窗不关会一直压在全页面最上层（stage 组件常驻挂载），把其他弹窗全挡住（e2e 实测踩到）
      news.forEach(c => { c._libAsked = true })
      this.saveAll()
      const key = ep.id + '@' + this.cards.length
      this._libAskFor = key
      const sel = {}
      for (const c of news) sel[c.name] = true
      this.askLibSave = {
        chars: news.filter(c => c.kind === 'character').map(c => c.name),
        scenes: news.filter(c => c.kind === 'scene').map(c => c.name),
        sel
      }
    },
    /** 批量入库：把勾选的本集新增卡逐张保存到项目库 */
    async doBatchLibSave() {
      const a = this.askLibSave
      const ep = this.ep
      if (!a || !ep) return
      this.askLibSave = null
      const names = [...a.chars, ...a.scenes].filter(n => a.sel[n] !== false)
      if (!names.length) { this.$root.toast('没有勾选要保存的条目'); return }
      let ok = 0
      for (const n of names) {
        const card = this.cards.find(c => c.name === n)
        if (!card || card.libId) continue
        try {
          const r = await this.st.saveLibrary(ep.projectId, this.libPayload(card))
          if (r && r.entry) {
            card.libId = r.entry.id
            card.libRevAt = r.entry.libRev || 1
            card._libRevNow = card.libRevAt
            card.libReadonly = false
            if (r.renamed) card.name = r.entry.name
            ok++
          }
        } catch (_) { /* 单条失败不影响其余 */ }
      }
      if (ok) {
        await this.saveAll()
        this.st.invalidateMedia(ep.projectId, 'library')
      }
      this.$root.toast('已保存 ' + ok + ' 个条目到项目角色场景库')
    },
    /**
     * 由上一阶段的产出构建卡片：已有档案优先，分镜里出现但档案缺失的名字用兜底模板补。
     * 🔴 同时做「项目角色场景库命中」：分镜里出现的名字若在项目库里存在**精确同名条目** → 这张卡
     *    自动从库加载（只读）：
     *      - 本集记录里已有 `libRevAt`（以前对齐过）→ 保留本集副本，只标只读；库版本更高则亮黄标
     *      - 没有（首次命中）→ 用库的档案 / 提示词 / 图片覆盖本集副本并落库 —— 必须落库，否则
     *        下次打开又当首次命中，「库已更新」永远检不出来
     */
    async init(ep) {
      // 加载态：只在「一张卡都还没有」的首次构建里才看得见（重建时 cards 非空，不会闪）
      this.loadPending = true
      // 兜底：init 里若有异常导致没走到下面的 `loadPending=false`，也不要把「正在加载」永久挂住
      clearTimeout(this._lpT)
      this._lpT = setTimeout(() => { this.loadPending = false }, 8000)
      const olds = []
      for (const o of ep.chars || []) olds.push({ ...o, kind: 'character' })
      for (const o of ep.scenes || []) olds.push({ ...o, kind: 'scene' })
      const byKey = new Map(olds.filter(o => o.name).map(o => [o.kind + '|' + o.name, o]))

      // 分镜里出现的角色名与场景名（保序）
      const names = { character: [], scene: [] }
      for (const s of ep.shots || []) {
        for (const n of String(s.chars || '').split(/[、,，/]/)) {
          const t = n.trim()
          if (t && names.character.indexOf(t) < 0) names.character.push(t)
        }
        const sc = String(s.scene || '').trim()
        if (sc && names.scene.indexOf(sc) < 0) names.scene.push(sc)
      }
      // 已有档案但分镜没提到的名字也保留（可能用户手动加过图）
      for (const o of olds) if (names[o.kind].indexOf(o.name) < 0) names[o.kind].push(o.name)

      // 🔴 2026-10-19（Dragon：「打开软件时角色&场景空白一会才显示」）：
      //    这两件事原来是**串行等待**，而且都挡在 `this.cards = out` 之前 —— 实测冷启动第一趟
      //    `readPrompt`（要播种内置 md）≈ 1.4s、`loadLibrary`（要迁移老项目）≈ 1.1s，
      //    这 2.5s 里网格中一张卡都没有，只剩顶部一条细进度条 → 看起来就是「空白」。
      //    现在改成：① 两个 IPC **并行**发起；② 卡片先用本集已有数据上屏；③ 模板与库在之后增量补齐。
      //    这两个数据都不影响「有哪些卡」：模板只决定生图时的空镜句 / 负向默认，库只决定只读标记与图源。
      //    `_initSeq` 是竞态哨兵：并发 init（保存 → watch → 150ms 重建）时，旧的那次不再回写。
      const seq = (this._initSeq = (this._initSeq || 0) + 1)
      const deps = Promise.all([
        fallbackTemplates().catch(() => null),
        this.st.loadLibrary(ep.projectId).catch(() => null)
      ])

      const out = []
      for (const kind of ['character', 'scene']) {
        names[kind].forEach((name, idx) => {
          const old = byKey.get(kind + '|' + name) || {}
          const role = kind === 'scene' ? '场景' : (old.role || (idx === 0 ? '主人公' : '配角'))
          out.push({
            kind,
            name,
            role,
            // 档案（提示词的依据）：来自分镜提取，用户可手改；_profRev/_profRevAt/_profAck 是脏标记依据
            profile: normalizeProfile(old.profile || ''),
            _profRevAt: old._profRevAt || 0,
            _profRev: old._profRev || 0,
            _profAck: old._profAck || 0,
            // 🔴 2026-10-16（Dragon：「角色档案根本没有进入提示词」）：**不再用兜底模板填 prompt**。
            //    旧行为 = `old.prompt || 兜底模板.replace('{name}', name)`，后果是「还没按档案生成提示词」
            //    这件事被一个通用模板掩盖住：用户看到五张卡的提示词长得一模一样（连主人公模板里写死的
            //    「一名年轻男主角」也套在女性角色上），直接批量出图就是全员一张脸。
            //    现在 prompt 为空就是空 —— 由「生成分镜后的一条龙」自动按档案逐张生成；
            //    真生成不出来时卡片上是空的（能看到「还没有提示词」），而不是悄悄用模板顶替。
            //    ⚠️ 兜底模板本身仍留在 chars.md 的「## 兜底默认」里（程序用途），只是不再当默认值。
            prompt: old.prompt || '',
            negative: old.negative || DEFAULT_NEG,
            promptMs: old.promptMs || 0,
            promptAt: old.promptAt || 0,
            candidates: Array.isArray(old.candidates) ? old.candidates.slice() : [],
            cur: typeof old.cur === 'number' ? old.cur : -1,
            // 🔴 图生图底图标记随卡落库（2026-09-27）：以前是运行时字段，点选后 pick() 的 saveAll
            //    会触发「工件变化 → 150ms 后 init 重建」把标记冲掉 → 按钮闪回「文生图」、参考图从未真正用过。
            //    显式点选才置 true、每次生成完 gen() 都会置 false，所以落库不会造成自动继承上一张
            refAsBase: old.refAsBase === true,
            // 🔴 「生成3视图」开关随卡落库（2026-10-14）：**与上面 refAsBase 是完全同一个坑** ——
            //    字段漏进这份白名单 → 每次保存后 150ms 的 init 重建都会把它丢掉 → 卡片值退回 undefined，
            //    而模板当时按 `!== false` 判缺省 → 勾选框「闪一下又自己变回勾上」，看起来像**无法切换**。
            //    ⚠️ verify3 当年测不出来：它断言的是 **store**（saveAll 写对了），而丢字段的是**重建出来的组件副本**；
            //       而且旧断言是直接改 `input.checked` 再派发 change，绕过了「重建后 DOM 会不会自己变回去」这一环。
            //    👉 以后往卡片加任何持久化字段，必须同时加进这份白名单（本文件已因此踩两次）。
            //    缺省 = **false**（2026-10-14 Dragon：默认关闭，要用再勾）
            threeView: old.threeView === true,
            // 🔴 变体卡类型随卡落库（2026-10-16，装扮变体）：同一份白名单的**第三个坑位**
            //    （前两个：refAsBase 09-27 / threeView 10-14）—— 漏了它 → 保存后 150ms 的 init 重建
            //    把标记丢掉 → 装扮卡「重出这一装扮」的文案与整组填充的排除判定一起退回视角口径。
            //    缺省 = 'view'（视角变体，三视图派生那一路），只有派生弹窗里选了「装扮变体」才是 'outfit'。
            _varKind: old._varKind === 'outfit' ? 'outfit' : 'view',
            // 🔴 装扮变体的「装束描述」（2026-10-16）—— 同一份白名单的**第四个坑位**（前三个：
            //    refAsBase 09-27 / threeView 10-14 / _varKind 10-16 同日）。它存的是装扮清单环节
            //    识别出来的那句话（服装 + 配饰 + 头饰的款式 / 颜色 / 材质），也是换装指令里
            //    `{装束}` 槽的来源。落库理由：用户改装扮名、或把指令清空之后要能重算回来（第 2 步的
            //    「重出这一装扮」与第 3 步的跨集复用都读它）。漏了它 = 识别完一存盘描述就没了。
            _varDesc: String(old._varDesc || ''),
            res: old.res || '',
            genMs: old.genMs || 0,
            // 脏标记依据：图片版本号（重生成/换图自增）——分镜行的素材签名按它判断「上游已变化」
            _imgRev: old._imgRev || 1,
            // 库来源标记：libId=库条目 id（空=本集新增，可自由编辑）；libRevAt=对齐时的库版本
            libId: old.libId || '',
            libRevAt: old.libRevAt || 0,
            // libReadonly=true 表示这张卡是「从项目库加载」的只读副本（编辑入口全禁，改要去库编辑区）；
            // 本集新增后入库的卡 libId 也有值，但 libReadonly=false（改的是本集副本）
            libReadonly: old.libReadonly === true,
            _libAck: old._libAck || 0,
            // 批量入库询问的「已答复」标记（弹框整批只问一次，持久化；见 maybeAskLibSave）
            _libAsked: old._libAsked === true,
            _libRevNow: 0
          })
        })
      }
      // 逐张卡分辨率默认值（未单独设置过 → 取剧集配置）；清掉上次会话的运行态字段
      const defRes = (ep.res && ep.res.img) || '1920x1080'
      this.cards = out
      // 卡片数据已就绪 → 加载态到此结束（下面只剩模板/库的增量补齐）
      this.loadPending = false
      // 🔴 这里**不能**清 viewSel（2026-10-13 e2e 实测）：init 是由「保存 → watch → 150ms 后重建」
      //    常规触发的，用户刚点开某个视角查看、右栏任何一次保存都会触发它 → 预览会自己跳回正面。
      //    清理只放在真正该清的两处：切集（watch 'st.current'）与删卡（doDelCard）。
      this.cards.forEach(c => {
        delete c._gen; delete c._genAt; delete c._pgGen; delete c._pgAt
        if (!c.res) c.res = defRes
      })

      // ---- 等上面并行发起的两件事（卡片此时已经上屏，这里只做增量补齐）----
      const [tpl, lib] = await deps
      if (this._initSeq !== seq) return        // 期间又跑了一次 init → 本次结果作废，别覆盖新的
      if (tpl) {
        this._keeper = tpl.keeper || SCENE_KEEPER_DEFAULT   // 场景图的空镜必备句（来自 scenes.md）
        // 模板晚到：上面建卡时用的 `DEFAULT_NEG` 还是模块级初值（空串）→ 空负向按新模板补一次
        for (const c of this.cards) if (!String(c.negative || '').trim()) c.negative = DEFAULT_NEG
      }

      // 项目角色场景库（命中即只读加载；主进程首次访问会自动迁移老项目）
      const byName = new Map()
      for (const e of ((lib && lib.entries) || [])) byName.set(e.kind + '|' + e.name, e)
      if (!byName.size) return
      const aligned = []

      // 🔴 库对齐会改写「只读标记 / 档案 / 提示词 / 图片 / 当前图」——这零点几秒里**禁掉编辑入口**，
      //    否则用户抢先改完的内容会被紧接着的对齐覆盖（卡片已经可见，这个窗口是真实存在的）
      const wasBusy = this.busy
      this.busy = true
      try {
        for (const c of this.cards) {
          // ---- 库命中判定 ----
          const e = byName.get(c.kind + '|' + c.name)
          if (!e) continue
          c.libId = e.id
          c._libRevNow = e.libRev || 1
          if (c.libRevAt) continue            // 以前对齐过：保留本集副本，只读；版本落后则亮黄标
          c.libRevAt = e.libRev || 1          // 首次命中：整卡从库加载
          c.libReadonly = true                // 且是只读副本（要改去库编辑区，别在本集改）
          if (e.role) c.role = e.role
          if (e.profile) c.profile = normalizeProfile(e.profile)
          if (e.prompt) c.prompt = e.prompt
          if (e.negative) c.negative = e.negative
          if (e.res) c.res = e.res
          if (Array.isArray(e.images) && e.images.length) c.candidates = e.images.slice()
          if (typeof e.cur === 'number' && e.cur >= 0) c.cur = e.cur
          c._imgRev = (c._imgRev || 1) + 1    // 素材来自库 → 引用它的镜头提示词会亮 ⚠（预期行为）
          aligned.push(c.name)
        }
      } finally {
        this.busy = wasBusy
      }
      if (this._initSeq !== seq) return
      if (aligned.length) {
        await this.saveAll()
        this.$root.toast('已从项目角色场景库加载：' + aligned.join('、'))
      }
    },
    /**
     * 该类型的图根目录。按卡片的归属分两处：
     *   - 库条目的只读视图（libReadonly === true）→ 项目共享素材 <项目>/assets/{characters,scenes}
     *   - 本集自己的卡（手动新增的、入库后本集仍可编辑的）→ 集私有素材 <项目>/assets/episodes/<集>/{characters,scenes}
     * 🔴 分开的理由：这两者以前是**同一个目录**，于是 A 集给某角色出图会连带改掉库与其它集同名角色的图，
     *    永久删图也是连坐，删集留下的图更是没人清。分开后各集互不污染。
     */
    rootOf(c) {
      const ep = this.ep
      if (!ep) return ''
      const base = (c.libReadonly === true) ? ep.assetsDir : (ep.epAssetsDir || ep.assetsDir)
      if (!base) return ''
      return joinPath(base, c.kind === 'scene' ? 'scenes' : 'characters')
    },
    /** 某张卡的图目录：<图根>/<名称>（图根见 rootOf：库只读卡用共享目录，本集卡用集私有目录） */
    dirOf(c) { return joinPath(this.rootOf(c), seg(c.name)) },
    /** 某张图的绝对路径 */
    absOf(c, f) { return joinPath(this.dirOf(c), f) },
    /** 点大预览图 → 打开 App.vue 的媒体预览弹窗（大图查看，带「所在文件夹」入口）。
     *  🔴 收**卡对象**或 ordered 里的 `{ c, i }` 两种形态：视角浮层切换后，大图上显示的是那一张视角图，
     *     放大预览必须跟着放大**同一张**（传 it 会把主体卡那张放大，与屏幕所见不符）。 */
    previewImg(x) {
      const c = (x && x.c) ? x.c : x
      const f = c && this.selFile(c)
      if (!f) return
      this.$root.openPreview({ file: f, path: this.absOf(c, f) }, 'image', c.name)
    },
    /** 卡片上的耗时文案：生成中实时计时 / 完成后显示本次生成耗时 */
    genText(c) {
      void this.live
      if (c._genAt) return '生成中 已用 ' + fmtMs(Date.now() - c._genAt)
      return c.genMs ? fmtMs(c.genMs) : ''
    },
    /** 档案区的时间文案：正在生成提示词 / 上次生成提示词的时间 */
    pgText(c) {
      void this.live
      if (c._pgAt) return '生成提示词 已用 ' + fmtMs(Date.now() - c._pgAt)
      return c.promptAt ? '提示词 ' + agoText(c.promptAt) : ''
    },
    /** 该卡当前生效的分辨率（2026-10-21 起锁定 = 档位推荐画布，不再取每卡独立值） */
    resOf(c) {
      const locked = this.st.lockedRes && this.st.lockedRes()
      if (locked && locked.img) return locked.img
      return c.res || (this.ep && this.ep.res && this.ep.res.img) || '1920x1080'
    },
    /** 档位按当前底模过滤；该卡已保存的值不在档位里时补进去（保证显示正确） */
    optsFor(c) { return optsWith((this.st.resOptions || {}).img, this.resOf(c)) },
    /** 大预览当前图片的实际分辨率（读到为止显示空） */
    dimOf(c) {
      const f = this.selFile(c)
      if (!f) return ''
      return this._dims[this.absOf(c, f)] || ''
    },
    /** 图片载入后读真实尺寸（用于分辨率角标） */
    readDims(abs, src) {
      if (this._dims[abs]) return
      const im = new Image()
      im.onload = () => { this._dims[abs] = im.naturalWidth + '×' + im.naturalHeight }
      im.src = src
    },
    selFile(c) { return c.cur >= 0 ? (c.candidates[c.cur] || null) : null },
    /** 视角变体卡的按钮行是否该整行收起（2026-10-08，Dragon）：
     *  一键填充 / 存到项目 / 写入镜头 都只对主体卡有意义，视角子卡上一个都不给；
     *  唯一的例外是只读库卡的「同名多张」切换下拉（那是系统判错时的纠正出口），它还在就留着这一行。 */
    fillRowEmpty(c) {
      if (!this.isVariantCard(c)) return false
      return !(this.isLibRo(c) && this.libVariantsOf(c).length > 1)
    },
    /** 抽卡区只渲染最新 SHOW_MAX 张，返回时带上真实下标 */
    shown(c) { return c.candidates.map((f, i) => ({ f, i })).slice(-SHOW_MAX) },
    imgSrc(abs) {
      // 绝对路径 → base64（IPC 只能拿 base64，浏览器不能直接读本地文件）
      if (!abs) return ''
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''   // 占位，避免同一张图被重复读盘
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) {
          this._b64[abs] = 'data:image/png;base64,' + b64
          this.readDims(abs, this._b64[abs])   // 顺带读真实尺寸（大预览角标）
        }
        else delete this._b64[abs]   // 读取失败不缓存空串，下次渲染重试（文件可能稍后才落盘）
      })
      return ''
    },
    /** 点缩略图：选中并放大到主预览，同时把它指定为「图生图」底图；再点同一张 → 取消选中（回到文生图） */
    pick(c, i) {
  c = this.liveCard(c)   // 缩略图点击可能来自重建前的旧卡对象
  if (c.cur === i) { c.cur = -1; c.refAsBase = false }
  else {
    c.cur = i
    // 当前生图方案声明了「不支持图生图」时，点缩略图只当预览，不当底图
    c.refAsBase = this.capsI2i
  }
  this.saveAll()
},
    askDel(c, i) { this.ask = { c, i, f: c.candidates[i] } },

    /* ================= 整张卡的删除 / 场景档案错挂修复 ================= */
    /** 场景档案体检文案（空串 = 没问题）；只对场景卡有意义 */
    scNote(c) { return (c && c.kind === 'scene' && (this.scIssues.byName || {})[c.name]) || '' },
    /** 档案挂错名字时的建议目标名（镜头真正在用的那个拼法） */
    scAdviceOf(c) { return (c && c.kind === 'scene' && (this.scIssues.advice || {})[c.name]) || '' },
    /**
     * 把「档案挂错名字」的那张卡的档案搬到镜头真正在用的那张卡上，并删掉这张空卡。
     * 图片不动（各卡候选图仍指向自己名字的目录，不搬文件、不断链）。
     */
    async mergeSceneInto(c, to) {
      const card = this.liveCard(c)
      const target = this.cards.find(x => x.kind === 'scene' && x.name === to)
      if (!card || !target) return
      const L = stepLog(TAG)
      const moved = []
      if (!String(target.profile || '').trim() && String(card.profile || '').trim()) {
        target.profile = card.profile; target._profRev = (target._profRev || 0) + 1; moved.push('档案')
      }
      if (!String(target.prompt || '').trim() && String(card.prompt || '').trim()) { target.prompt = card.prompt; moved.push('提示词') }
      if (!String(target.negative || '').trim() && String(card.negative || '').trim()) target.negative = card.negative
      const idx = this.cards.indexOf(card)
      if (idx >= 0) this.cards.splice(idx, 1)
      await this.saveAll()
      this.st.invalidateMedia(this.ep.projectId, 'characters')
      L.done('场景档案「' + card.name + '」→「' + to + '」（' + (moved.length ? '搬入 ' + moved.join(' / ') : '目标卡已有内容，只删空卡') + '）')
      this.$root.toast('已把档案搬到「' + to + '」，请点该卡的「刷新提示词」重算')
    },
    /** 该主体卡名下的**全部视角变体卡**（按卡片显示顺序）。独立主体 / 没有子卡时返回 [] */
    groupChildren(c) {
      if (!c) return []
      const g = this.grpMap[baseOf(c.name)]
      if (!g || g.items.length < 2) return []
      return g.items.filter(o => isVariant(o.c && o.c.name)).map(o => o.c)
    },
    /* ---- 主体卡内「视角浮层」的取数（2026-10-13 二改，Dragon）----
       🔴 这三个都必须是 methods 而不是 computed：它们**都带参数**（要算的是「这一张卡」的视角），
          computed 是取值不调用的，模板里写 `viewCards(it.c)` 会变成「拿数组当函数调」→
          TypeError: i.viewCards is not a function（第 2 块整页 API 全挂，verify3 一上来就红一片）。 */
    /** 浮层里的卡片列表：本组全部卡（**主体卡排第一**），独立主体 / 单卡组 → [自己] */
    viewCards(c) {
      if (!c) return []
      const g = this.grpMap[baseOf(c.name)]
      if (!g || g.items.length < 2) return [c]
      const items = g.items.map(o => o.c)
      const p = items.find(x => x.name === baseOf(c.name))
      if (!p) return items
      return [p].concat(items.filter(x => x !== p))
    },
    /** 这一格要不要渲染视角浮层：只有一张卡（没有视角变体）时整层不渲染，不留一条空浮层 */
    hasViews(c) { return this.viewCards(c).length > 1 },
    /** 当前**正在看**的那张卡：viewSel 命中本组某张卡 → 返回它；否则返回 c 自己（= 看主体卡那张）。
     *  🔴 必须比对主体名：viewSel 是全局的，不比对的话每一组都会跟着切过去。
     *  🔴 纯查看：不动 c.cur、不改 this.cards —— 下游（填充 / 入库 / 写入镜头）一个字节都不变。 */
    showCard(c) {
      if (!c || !this.viewSel) return c
      const v = this.cards.find(x => x.name === this.viewSel)
      if (!v) return c
      return (v.name === c.name || baseOf(v.name) === String(c.name || '').trim()) ? v : c
    },
    /** 打开删卡确认（统计有多少镜头在用它，提示里说清后果；主体卡还要把子卡名单摆出来） */
    askDelCard(c) {
      const card = this.liveCard(c)
      if (!card) return
      let used = 0
      for (const s of ((this.ep && this.ep.shots) || [])) {
        const hit = card.kind === 'scene'
          ? String(s.scene || '').trim() === card.name
          : String(s.chars || '').split(/[、,，/]/).map(x => x.trim()).indexOf(card.name) >= 0
        if (hit) used++
      }
      // 🔴 删主体卡 = 连子卡一起删（2026-10-08，Dragon）：视角卡离开主体就没有任何意义
      //    （档案取主体那份、分镜只写主体名、组色也按主体算），留着只会变成一组没有依据的孤儿。
      const kids = this.isParentCard(card) ? this.groupChildren(card) : []
      this.askCard = { c: card, used, kids }
    },
    /** 删除整张卡（主体卡则连子卡一起删）：卡片数组移除 → 落库 → **同时摘掉分镜里的引用**
     *  （否则 init 重建会把它复活） */
    async doDelCard() {
      const a = this.askCard
      if (!a) return
      const card = this.liveCard(a.c)
      this.askCard = null
      if (!card) return
      const i = this.cards.indexOf(card)
      if (i < 0) return
      // 同一主体组的全部视角变体卡：一并删除（2026-10-08，Dragon）
      const kids = (a.kids || []).map(k => this.liveCard(k)).filter(k => k && k !== card)
      // saveAll 之后 cards 可能被 rebuildSoon 整体替换，后面只用快照里的「类型 + 名字」办事
      const snap = { kind: card.kind, name: card.name }
      const kidSnaps = kids.map(k => ({ kind: k.kind, name: k.name }))
      const L = stepLog(TAG)
      try {
        // 先删子卡再删主体卡（索引从大到小倒着删，避免前面的 splice 让后面的下标漂移）
        for (const k of kids) { const j = this.cards.indexOf(k); if (j >= 0) this.cards.splice(j, 1) }
        { const j = this.cards.indexOf(card); if (j >= 0) this.cards.splice(j, 1) }
        await this.saveAll()
        // 🔴 必须把名字从分镜里一起摘掉：init(ep) 是按「分镜里出现过的名字」建卡的（本意是重生成分镜后
        //    新角色自动冒卡），只删 chars.json 的话 150ms 后 rebuildSoon→init 又照着分镜名字把它建回来
        //    （连图一起）→ 表现就是「删了立刻又出现」。
        const n = await this.purgeFromShots(snap)
        // 子卡名正常不在分镜里（分镜只写主体名），但用户可能手写过 → 一并摘掉，避免 init 复活
        let kn = 0
        for (const ks of kidSnaps) kn += await this.purgeFromShots(ks)
        this.st.invalidateMedia(this.ep.projectId, 'characters')
        const kidTxt = kidSnaps.length
          ? '，并连带删除 ' + kidSnaps.length + ' 张视角卡（' + kidSnaps.map(k => k.name).join('、') + '）'
          : ''
        L.done('已删除' + (snap.kind === 'scene' ? '场景' : '角色') + '卡：「' + snap.name + '」' +
          (n ? '（同时从 ' + n + ' 个镜头里摘掉了这个名字）' : '') + kidTxt + '（图片文件保留在磁盘）')
        // 视角浮层若正停在被删掉的卡上（主体卡或它的某张视角卡）→ 预览退回「看主体卡那张」，
        // 否则 viewSel 会留一个已不存在的名字（showCard 找不到会静默退回自己，但留着是脏数据）
        if (this.viewSel === snap.name || kidSnaps.some(k => k.name === this.viewSel)) this.viewSel = ''
        this.$root.toast('已删除「' + snap.name + '」' +
          (n ? '，并从 ' + n + ' 个镜头里摘掉' : '') + kidTxt + '（图片文件仍在磁盘）')
      } catch (e) {
        L.fail('删除卡片失败', null, e)
        this.st.fail(e)
      }
    },
    /**
     * 摘掉分镜里对某个名字的引用：角色从 chars 字段里去掉这一项、场景清空 scene 字段。
     * 不做这件事的话 `init()` 会照分镜里的名字把卡重建回来 —— 卡片删了立刻复活。
     * @returns 被改动的镜头数（0 = 分镜里本来就没这个名字，不用写盘）
     */
    async purgeFromShots(snap) {
      const ep = this.ep
      if (!ep) return 0
      const shots = JSON.parse(JSON.stringify(ep.shots || []))
      let n = 0
      for (const s of shots) {
        if (snap.kind === 'scene') {
          if (String(s.scene || '').trim() === snap.name) { s.scene = ''; n++ }
        } else {
          const parts = String(s.chars || '').split(/[、,，/]/).map(x => x.trim()).filter(Boolean)
          const j = parts.indexOf(snap.name)
          if (j >= 0) { parts.splice(j, 1); s.chars = parts.join('、'); n++ }
        }
      }
      if (!n) return 0
      await this.st.saveArtifact('shots', shots)
      ep.shotsSyncAt = Date.now()   // 常驻的分镜块按最新工件重建（与 doWriteShots 同款）
      return n
    },
    /** 🔴 卡片可能因 rebuildSoon 被整体替换（保存→watch→150ms 后 init 重建），
     *  弹窗/异步回调里持有的旧对象已脱离 this.cards —— 任何写操作前先按
     *  「类型+名字」重新解析当前活卡，文件名是稳定标识，用它找回下标 */
    liveCard(c) { return this.cards.find(x => x.kind === c.kind && x.name === c.name) || c },
    async doDel(permanent) {
      const f = this.ask.f
      let c = this.liveCard(this.ask.c)
      this.ask = null
      if (c.candidates.indexOf(f) < 0) return
      const L = stepLog(TAG)
      try {
        if (permanent) {
          const abs = this.absOf(c, f)
          await window.studio.deleteFile(abs)
          delete this._b64[abs]
          L.done('已永久删除图片：' + c.name + '/' + f)
        } else {
          L.done('已从列表移除（磁盘保留）：' + c.name + '/' + f)
        }
        // 🔴 deleteFile 是异步 IPC，等待期间「上一次保存 → watch → 150ms 后的 init 重建」可能已经跑完：
        //    那会把整批卡换成新对象，上面持有的 c 随即脱离 this.cards —— 继续改它等于改一个没人看的孤儿
        //    （落库时又被重建结果覆盖），表现就是「磁盘文件真删了、列表里却还在，且再也不消失」
        //    （2026-10-13 e2e 实测踩到：文件已删、候选仍是 5 张、cur 卡住）。所以删除动作完成后
        //    **必须重新取活卡**，再按文件名找回下标（文件名是稳定标识，重建后依然在）。
        c = this.liveCard(c)
        const i = c.candidates.indexOf(f)
        if (i < 0) return
        c.candidates.splice(i, 1)
        if (c.cur === i) { c.cur = -1; c.refAsBase = false }   // 删掉的正是底图 → 图生图标记一并撤掉
        else if (c.cur > i) c.cur -= 1
        c._imgRev = (c._imgRev || 1) + 1   // 图片集合变化 → 下游签名失配即提示
        this.st.invalidateMedia(this.ep.projectId, 'characters')
        await this.saveAll()
      } catch (e) {
        L.fail('删除图片失败', null, e)
        this.st.fail(e)
      } finally { this.ask = null }
    },
    /** 落库守卫：生成在跑时切了集（_busyEpId = 'SWITCHED'）→ 在途任务的收尾写库直接丢弃，
     *  防止旧集的 chars/scenes 被写进新切换的集（st.saveArtifact 写的是 this.current.id） */
    canSave() {
      return !(this._busyEpId && this.st.current && this._busyEpId !== this.st.current.id)
    },
    /** 落库：拆成 chars.json（角色）与 scenes.json（场景）两个工件 */
    async saveAll() {
      if (!this.canSave()) return
      const clean = (kind) => this.cards.filter(c => c.kind === kind).map(o => {
        const c = { ...o }                  // _gen / _genAt / _pgGen / _pgAt / _libRevNow 是运行时字段，不落库
        delete c._gen; delete c._genAt; delete c._pgGen; delete c._pgAt; delete c.kind
        delete c._libRevNow
        return c
      })
      await this.st.saveArtifact('chars', clean('character'))
      await this.st.saveArtifact('scenes', clean('scene'))
    },
    /* ================= 档案（提示词的依据） ================= */
    /** 档案是否落后于提示词（纯函数，读取用；不修改任何响应式数据） */
    profStale(c) { return profileDirty(c) },
    /** 用户编辑档案：档案版本 +1 → 卡片出现「档案已改 · 提示词待更新」并立即落库 */
    async touchProfile(c) {
      const card = this.liveCard(c)
      card._profRev = (card._profRev || 0) + 1
      card._profAck = 0
      await this.saveAll()
    },
    /** 点掉档案脏标记：先不动提示词（只记下「这个版本我看过了」） */
    async ackProfile(i) {
      const c = this.cards[i]
      if (!c) return
      c._profAck = c._profRev || 0
      await this.saveAll()
    },
    /** 同类其它条目的档案（生成提示词时下发，保证与已有角色/场景在外观维度上错开） */
    othersOf(c) { return this.cards.filter(x => x.kind === c.kind && x.name !== c.name) },
    /**
     * 档案 → 提示词（单卡「生成提示词」按钮；批量也走这里）：
     * 读 profile.md + chars.md / scenes.md 组装 system，把本卡档案与同类其它档案一起下发，
     * 模型返回 {prompt, negative} 覆盖当前提示词（之后仍可手改）。
     */
    async genPromptFromProfile(i, ctx) {
      const c = this.cards[i]
      if (!c) return false
      if (!String(c.profile || '').trim()) {
        this.$root.toast('「' + c.name + '」还没有档案，先填写档案或重新生成分镜')
        return false
      }
      // 2026-10-19：单卡点刷新 = 接受重算 → 琥珀色立刻收掉（批量传了 ctx，逐卡靠生成完成自然清除）
      if (!ctx && profileDirty(c)) { c._profAck = c._profRev || 0; await this.saveAll() }
      const isScene = c.kind === 'scene'
      const what = isScene ? '场景提示词' : '角色提示词'
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.busy = true
      c._pgGen = true
      c._pgAt = Date.now()
      const t0 = Date.now()
      this.pl.beginGen(3)
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在按档案生成' + what + '：' + c.name + prog)
      try {
        const system = await composeSystem({
          specs: ['promptgen.md', 'profile.md', isScene ? 'scenes.md' : 'chars.md'],
          mustHave: ['"prompt"', '"negative"'],
          task: isScene ? 'scene' : 'char'
        })
        const others = profileBrief(this.othersOf(c), c.name)
        // user 消息的文案同样来自规范 md（promptgen.md 的「## 素材格式」），这里只提供素材本身
        const user = await composeUser('promptgen.md', {
          kind: isScene ? '场景' : '角色', profile: c.profile, others, name: c.name
        })
        dbgPrompt(TAG, '档案 → 提示词 · ' + (isScene ? '场景' : '角色') + '「' + c.name + '」', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 1024, json: true, stage: 'chars', providerOverride: overrideOf('chars'), label: TAG })
        const out = parsePcOut(text)
        if (!out.prompt) throw new Error('LLM 未返回正向提示词')
        c.prompt = out.prompt
        c.negative = out.negative || c.negative || DEFAULT_NEG
        c.promptMs = Date.now() - t0
        c.promptAt = Date.now()
        c._profRevAt = c._profRev || 0     // 提示词已对齐当前档案 → 脏标记消失
        c._profAck = c._profRev || 0
        await this.saveAll()
        L.done(what + '「' + c.name + '」生成完成：' + out.prompt.length + ' 字' + (out.negative ? '（含负向）' : '（未返回负向，沿用原值）'), c.promptMs)
        return true
      } catch (e) {
        L.fail(what + '「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        delete c._pgAt; c._pgGen = false; this.busy = false; this.pl.endGen(3)
        if (!this.batchI && !this.batchP) this._busyEpId = null
      }
    },
    /**
     * 这张卡现在能不能出图（2026-10-16）。
     *
     * 🔴 起因：`init()` 不再用兜底模板顶替空提示词（Dragon：「角色档案根本没有进入提示词」）
     *    → 卡片**可以合法地没有提示词**了 —— 这是以前不存在的一条路，而它一路通到主进程的
     *    占位符护栏：`applyParams` 对空串是 `continue`（跳过替换），模板里的 `"__PROMPT__"` 原样留下，
     *    于是 `findPlaceholders` 命中 → 抛「工作流占位符未解析：__PROMPT__ → 缺少…请到 设置 → 模型管家 看」。
     *    那条错误**指向模型管家**，而模型一切正常，用户只能去猜。所以：出图前就地拦住，说清是提示词的问题。
     *    场景卡例外：正向会被补上「空镜必备句」，只要那句话在（scenes.md 可改）就照常出图。
     */
    genReady(c) {
      if (!c) return false
      const pos = c.kind === 'scene' ? ensureSceneKeeper(c.prompt, this._keeper) : String(c.prompt || '')
      return !!String(pos || '').trim()
    },
    /** 生成某张卡的图（逐张分辨率取该卡自己的配置）；角色与场景走同一套流程 */
    async gen(i, ctx) {
      const c = this.cards[i]
      if (!c) return false
      const isScene = c.kind === 'scene'
      const what = isScene ? '场景图' : '角色图'
      // 🔴 空提示词不许往下走（见 genReady 的说明：否则会撞上主进程占位符护栏、报出一条指向模型管家的假错误）
      //    放在这里而不是后面：不用先置 busy / _gen / beginGen 再回滚。ctx.quiet 供批量与一条龙静默调用。
      if (!this.genReady(c)) {
        const m = '「' + c.name + '」还没有提示词，本次跳过了出图 —— 先按档案生成提示词：' +
          '卡片右上角的刷新按钮 / 模块标题行的「批量生成提示词」（生成分镜时会自动做这一步）'
        stepLog(TAG).warn(m)
        if (!ctx || ctx.quiet !== true) this.$root.toast('⚠ ' + m)
        return false
      }
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.busy = true
      c._gen = true
      c._genAt = Date.now()      // 卡片上「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(3)
      const L = stepLog(TAG)
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      // 🔴 只有用户显式点选缩略图（refAsBase）才走图生图：生成完成后自动选中的「最新图」只用于预览，
      //    否则每次重生成都会拿上一张当底图，把上一次画面里的人物/瑕疵一并继承下来（场景出「人」的元凶之一）
      const fromRef = !!c.refAsBase && c.cur >= 0
      // 三视图（2026-10-13，Dragon）：本卡勾选框**勾上**（`=== true`，2026-10-14 起默认关闭）
      //   **且** 是角色主体卡 **且** views.md 读到了侧面/背面两条视角句 —— 三个条件缺一不可。
      //   任一不满足就退回「只出一张」的老行为（宁可少出，也不发一句残缺的编辑指令）
      //   🔴 判据必须与模板勾选框的 `!!sc.threeView` 同口径：勾选框显示为关、这里却照旧出三张，
      //      就是「界面骗人」—— 以后改默认值两处一起改。
      const threeView = !isScene && !isVariant(c.name) && !c.libReadonly && c.threeView === true
        && !!VIEW_TPL.side && !!VIEW_TPL.back
      // 场景图强制空镜：正向里缺空镜陈述时补上「空镜必备句」（取自 scenes.md，可随时改）；
      // 发送前再剥掉命中器材词的短语（存量老提示词里的「单反相机拍摄」防器材被画进画面）
      const positive = stripEquipmentWords(isScene ? ensureSceneKeeper(c.prompt, this._keeper) : c.prompt, EQ_WORDS)
      const [rw, rh] = parseRes(this.resOf(c))
      L.start('正在生成' + what + '：' + c.name + prog + '（' + rw + 'x' + rh +
        ' · ' + resLabel(this.optsFor(c), this.resOf(c)) +
        (fromRef ? ' · 图生图，参考：' + c.candidates[c.cur] : ' · 文生图') +
        (threeView ? ' · 三视图：本张为正面，随后自动出侧面 / 背面' : '') + '）')
      try {
        const dir = this.dirOf(c)
        dbgPrompt(TAG, '图片模型 · ' + what + '「' + c.name + '」', [
          ['positive', positive],
          ['negative', c.negative || DEFAULT_NEG],
          ['size', rw + 'x' + rh + '（' + resLabel(this.optsFor(c), this.resOf(c)) + '）'],
          ['mode', fromRef ? '图生图 denoise 0.62，参考图 ' + c.candidates[c.cur] : '文生图' + (isScene ? '（已补空镜句）' : '')],
          ...(threeView ? [['三视图', '本张 = 正面；随后自动出 侧面 / 背面（走编辑通道，参考本张，resolution ' + VIEW_RESOLUTION + '）']] : [])
        ])
        const r = await window.studio.comfyGenerate({
          templateKey: 'character', dir, baseName: c.name,
          params: {
            prompt: positive, negative: c.negative || DEFAULT_NEG,
            width: rw, height: rh,
            // 选了缩略图 → 图生图（拿那张图当底图重绘，denoise 0.62）；没选 → 纯文生图
            ...(fromRef ? { image: this.absOf(c, c.candidates[c.cur]) } : {})
          },
          label: TAG
        })
        // 可无限重生成：磁盘与 candidates 记录全部保留，只是抽卡区最多显示最新 4 张
        c.candidates = [...c.candidates, ...r.files]
        c.cur = c.candidates.length - 1   // 自动选中最新图（只为预览）
        c.refAsBase = false               // 但不当作下一次的图生图底图（避免继承上一张画面里的人物）
        // 三视图后两枪：拿刚出的这张当参考，自动派生 `主体名--侧面 / --背面` 卡并出图
        const vr = threeView ? await this.genViews(c.name, this.absOf(c, c.candidates[c.cur])) : null
        const ms = Date.now() - t0
        // 🔴 genViews 里存过盘 → 卡片数组可能已被 init 重建，c 这个 proxy 可能已失效：
        //    重新取实时卡再写，否则 genMs / _imgRev 会写进一个没人看的旧对象
        const self = this.liveCard(c)
        self.genMs = ms               // 逐条耗时（持久化；三视图时 = 三张的总耗时）
        self._imgRev = (self._imgRev || 1) + 1   // 图片版本 +1：引用本资产图片的镜头提示词会被标 ⚠
        delete self._genAt
        await this.saveAll()
        this.pl.markGen(3, ms)
        this.st.invalidateMedia(this.ep.projectId, 'characters')   // 左侧树 assets 下次展开刷新
        L.done(what + '「' + c.name + '」生成完成：' + r.files.join('、')
          + (vr ? '；三视图 侧面 / 背面 ' + vr.ok + '/' + vr.total + ' 成功' : ''), ms)
        this.$root.toast(vr
          ? c.name + ' 已生成 ' + (r.files.length + vr.ok) + ' 张图（正面 + 侧面 / 背面 ' + vr.ok + '/' + vr.total + '）'
          : c.name + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail(what + '「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        // 同上面的理由：c 可能已失效，用实时卡收尾（_gen 不落库，重建后的卡本来就是空的）
        const self = this.liveCard(c)
        delete self._genAt; self._gen = false
        this.busy = false; this.pl.endGen(3)
        if (!this.batchI && !this.batchP) this._busyEpId = null
      }
    },
    /* ================= 批量任务（块 2 标题行的两个按钮） ================= */
    /**
     * 这张卡的正向提示词是不是「兜底模板」（2026-10-16）。
     *
     * 起因：旧版本的 `init()` 会在卡片没有提示词时**自动填兜底模板**（`old.prompt || 模板.replace('{name}', 名字)`），
     * 于是存量项目里躺着大量「看着有、其实是通用模板」的提示词 —— 它们从没按档案生成过，
     * 五张卡长得一模一样（连「一名年轻男主角」都套在女性角色上），直接出图就是全员一张脸。
     *
     * 判据 = 与当前风格下的模板**逐字相同**（`fallbackTemplates` 读的 md 已经过风格替换，
     * 所以拿到的就是卡片上那句成品的原文）。命中即当作「还没有提示词」→ 批量 / 一条龙会重算它。
     * ⚠️ 换过风格的项目，旧模板文本可能与当前模板不一致 → 判不出来，此时用「批量生成提示词 → 全部重算」。
     */
    isTplPrompt(c) {
      const t = c.kind === 'scene'
        ? FALLBACK_TPL.scene
        : (c.role === '主人公' ? FALLBACK_TPL.hero : FALLBACK_TPL.npc)
      const cur = String(c.prompt || '').trim()
      if (!t || !cur) return false
      return cur === String(t).replace(/\{name\}/g, c.name).trim()
    },
    /**
     * 「批量生成提示词」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围
     */
    batchPrompts() {
      if (this.batchP) { this.batchPStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchI) { this.$root.toast('图片批量进行中，请先等它结束或停止'); return }
      if (!this.cards.length) { this.$root.toast('还没有角色/场景，先点「生成分镜」'); return }
      this.askBatch = { kind: 'prompts' }
    },
    /** 「批量生成图片」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围（与批量提示词同款弹框，
         无论是否都已有图都弹 —— 全都有图时默认会全部跳过，弹框里说明并给出「全部重新生成」出口） */
    batchImages() {
      if (this.batchI) { this.batchIStop = true; this.$root.toast('停止中：当前条目完成后停止，剩余条目不再执行'); return }
      if (this.batchP) { this.$root.toast('提示词批量进行中，请先等它结束或停止'); return }
      if (!this.cards.length) { this.$root.toast('还没有角色/场景，先点「生成分镜」'); return }
      // 🔴 弹框里的「已有图 / 还没有图 / 共」必须与 runBatchI 的条目口径**完全一致**（2026-10-16）：
      //    现在是「主体卡 + 装扮卡、不含视角卡」—— 数字对不上就等于骗人。
      const subj = this.cards.filter(c => !this.isVariantCard(c) || this.isOutfitVar(c))
      const have = subj.filter(c => c.candidates.length).length
      this.askBatch = { kind: 'images', have, miss: subj.length - have, total: subj.length }
    },
    askBatchAll() { this.askBatch = null; this.runBatchP(true) },
    askBatchMissing() { this.askBatch = null; this.runBatchP(false) },
    askBatchImgMissing() { this.askBatch = null; this.runBatchI(false) },
    askBatchImgAll() { this.askBatch = null; this.runBatchI(true) },
    /**
     * 批量生成提示词：all=true 全部按档案重算并覆盖；false 只处理「档案已改未重算」+「还没有提示词」。
     * 逐个顺序执行，batchPStop 置位后当前条目跑完即停（剩余丢弃），结束统一统计。
     */
    async runBatchP(all) {
      const L = stepLog(TAG)
      const idx = []
      for (let i = 0; i < this.cards.length; i++) {
        const c = this.cards[i]
        if (all) {
          if (String(c.profile || '').trim()) idx.push(i)   // 没有档案的条目没法按档案生成（按钮已禁用，双保险）
          continue
        }
        // 🔴 isTplPrompt：存量项目里那些「被兜底模板填过」的卡要一起重算 —— 它们看着有提示词，
        //    其实从没按档案生成过（不判它 = 修完新数据，老数据照样是全员一张脸）。
        if (!String(c.prompt || '').trim() || this.isTplPrompt(c) || profileDirty(c)) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成提示词的条目'); return { okN: 0, badN: 0, stopped: false, total: 0 } }
      this.askBatch = null
      this.batchP = true; this.batchPStop = false; this.busy = true
      this.batchPN = 0; this.batchPTotal = idx.length
      L.start('开始批量生成提示词（' + (all ? '全部按档案重算，覆盖已有' : '只处理档案有变动 / 还没有提示词的') + '）：待生成 ' +
        idx.length + ' 个（共 ' + this.cards.length + ' 个角色/场景）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          // 🔴 每轮开头都查停止标记 + 切集哨兵：切集后剩余任务一律丢弃（旧循环持有的 index 已指向新集）
          if (this.batchPStop || this._busyEpId === 'SWITCHED') { stopped = true; break }
          this.batchPN = k + 1
          const okFlag = await this.genPromptFromProfile(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成提示词已停止' : '批量生成提示词结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各条目失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
        if (!badN) this.$root.toast(stopped ? '批量已停止（已完成部分保留）' : '全部提示词已生成')
      } finally {
        this.batchP = false; this.batchPStop = false; this.busy = false
        this.batchPN = 0; this.batchPTotal = 0
        if (!this.batchI) this._busyEpId = null
      }
      return { okN, badN, stopped, total: idx.length }
    },
    /**
     * 装扮卡**能不能出图**（编辑通道的三个前提）：主体卡在、主体卡有图、本卡指令非空且没有残留花括号。
     * @returns {string} '' = 可以出图；否则返回一句原因（批量里用它把这类卡计入「跳过」而不是「失败」）
     */
    outfitGenIssue(c) {
      if (!c) return '卡片不存在'
      const base = baseOf(c.name)
      const parent = this.cards.find(x => x.name === base)
      if (!parent) return '找不到主体卡「' + base + '」'
      if (!(this.selFile(parent) || (parent.candidates || []).length)) return '主体卡「' + parent.name + '」还没有图（先给它出一张）'
      const instr = String(c.prompt || '').trim()
      if (!instr) return '变体指令是空的'
      if (/[{}]/.test(instr)) return '指令里还留着花括号（装束描述没填全）'
      return ''
    },
    /**
     * 批量生成图片：all=false 只补还没有图的条目（已有图的跳过）；all=true 全部重出一张（完成自动选中新版）。
     *
     * 🔴 2026-10-16 二次拍板：条目集合 = **所有角色/场景主体卡 + 全部装扮派生卡**。
     *    · 装扮卡走**编辑通道**（`regenView`：以主体卡定妆图为参考、只换衣服）—— 它没有独立外形，
     *      拿去文生图会出来一张不相干的新人像（这正是以前整批跳过它的原因）。
     *    · 卡片顺序天然满足依赖：装扮卡紧跟它的主体卡之后 → 轮到它时主体卡刚出好图、参考图现成。
     *    · 视角卡（三视图）**仍不参与**（2026-10-13 的口径不变）：它收在主体卡的视角条里、默认不展开，
     *      属于「看不见的卡被批量刷成错图」。
     */
    async runBatchI(all) {
      const L = stepLog(TAG)
      const idx = []
      for (let i = 0; i < this.cards.length; i++) {
        // 🔴 **视角卡**不参与批量（2026-10-13 口径不变）：它没有独立外形、收在主体卡的视角条里、
        //    默认不展开 —— 属于「看不见的卡被批量刷成错图」。
        //    ⚠️ 装扮卡**要参与**（2026-10-16 二次拍板）：那是用户明确要的换装图（走编辑通道，见方法头）。
        const c0 = this.cards[i]
        if (this.isVariantCard(c0) && !this.isOutfitVar(c0)) continue
        if (all || !c0.candidates.length) idx.push(i)
      }
      if (!idx.length) {
        this.$root.toast('没有需要生成的条目')
        return { okN: 0, badN: 0, stopped: false, total: 0 }
      }
      this.batchI = true; this.batchIStop = false; this.busy = true
      this.batchIN = 0; this.batchITotal = idx.length
      L.start('开始批量生成图片（' + (all ? '全部重新生成，完成后自动选中新版本' : '只补还没有图的，跳过已有图') + '）：待生成 ' +
        idx.length + ' 个（共 ' + this.cards.length + ' 张卡，含装扮卡）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      // skipN（2026-10-16）：还没有提示词的条目 —— 出图必被主进程占位符护栏拦下（见 genReady），
      // 所以在这里先筛掉并计数，末尾如实汇报。否则它们会以 gen() 返回 false 的身份混进「失败」里。
      let okN = 0, badN = 0, skipN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchIStop || this._busyEpId === 'SWITCHED') { stopped = true; break }
          this.batchIN = k + 1
          const card = this.cards[idx[k]]
          if (!card) { skipN++; continue }
          // 🔴 装扮卡走**编辑通道**（以主体卡定妆图为参考、只换衣服）：它没有独立外形，不能文生图。
          //    前提是主体卡已经有图 —— 卡片顺序保证主体卡先跑（装扮卡紧跟主体卡之后）。
          if (this.isOutfitVar(card)) {
            const issue = this.outfitGenIssue(card)
            if (issue) { skipN++; L.warn('跳过装扮卡「' + card.name + '」：' + issue); continue }
            const okImg = await this.regenView(card)
            okImg ? okN++ : badN++
            continue
          }
          if (!this.genReady(card)) {
            skipN++
            L.warn('跳过「' + card.name + '」：还没有提示词 —— 先按档案生成提示词（刷新按钮 / 批量生成提示词），再回来出图')
            continue
          }
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN - skipN
        const sum = (stopped ? '批量生成图片已停止' : '批量生成图片结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (skipN ? '，跳过 ' + skipN + ' 个（提示词没就绪 / 装扮缺参考图，见日志）' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN && !skipN) L.fail(sum, null, new Error('全部失败，请到日志面板看各自失败原因'))
        else if (badN || stopped || skipN) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchI = false; this.batchIStop = false; this.busy = false
        this.batchIN = 0; this.batchITotal = 0
        if (!this.batchP) this._busyEpId = null
      }
      return { okN, badN, stopped, total: idx.length }
    },

    /* ================= 自动流程：生成分镜之后自动建卡（2026-10-16 · Dragon 拍板） =================
     * 「不需要用户点『识别装扮』；你自动识别出来并且建卡」—— 分镜是原料，所以票由分镜环节置
     * （StageShots.generate 末尾 `st.requestAuto`），执行落在这里：两个阶段是两个组件，票走 store 中转。
     * 🔴 只做**建卡链**（图片提示词 → 识别装扮 → 建派生卡）；出图与填镜头是用户手点的两个按钮
     *    （「生成图片」「一键填充」）—— 这是 2026-10-16 二次拍板的收缩结果，上一版的五步一条龙已作废。 */
    /** 自动流程该不该停：用户点了「停止」/ 切了集 */
    _autoStop() {
      return this.auto.stop === true || this._busyEpId === 'SWITCHED'
    },
    /**
     * 「停止」按钮：除了自己的标记，还要置**批量停止位** —— 流程内部就是靠 `runBatchP` 那位在
     * 「当前条目跑完」的边界收尾的，只置 auto.stop 的话它不会看一眼，用户得等整批跑完（N 次模型调用）。
     * （当前那一次调用本身没法中断，这是模型侧的限制。）
     */
    stopAuto() {
      this.auto.stop = true
      this.batchPStop = true
      this.batchIStop = true
    },
    /** 收到「分镜已生成」的票 → 跑一条龙（票的形状与置票理由见 project.js 的 requestAuto） */
    async onAutoReq(v) {
      if (!v || !v.epId) return
      const cur = this.st.current
      if (!cur || cur.id !== v.epId) return          // 票是别的集（用户在生成完之前切走了）→ 不跑
      await this.runAuto()
    },
    /**
     * 自动流程（**两步**，顺序不能换）：
     *   ① 按档案生成**图片提示词** —— 只补「还没有 / 档案已改」的条目，已有且最新的绝不覆盖
     *   ② 逐角色：从本集分镜的服装记录里识别装扮 → 幂等派生 `主体--装扮名` 卡
     *      （原料是分镜的 `continuity` / `change`：「谁在第几镜换了哪套」是**已有事实**，不重读剧本）
     *
     * 🔴 到此为止 —— **不出图、不填镜头**：那两件事由用户在「生成图片」「一键填充」里做
     *    （2026-10-16 二次拍板；装扮卡在「生成图片」里排在它的主体卡之后，天然拿得到定妆图当参考）。
     * 🔴 随时可打断：切集（`_busyEpId === 'SWITCHED'`）或点「停止」就地收尾，已完成的部分全部保留
     *    （每一步都是逐卡落盘的）。切集那条路会让 `_busyEpId` 变成哨兵，后面的循环逐个查它。
     * 🔴 提示词**一张都没生成成功**时直接停在原地：后面的识别全靠「按档案」匹配，没有提示词说明
     *    模型 / Key 那边有问题，报出原因比硬跑有用。
     */
    async runAuto() {
      if (this.auto.on) return
      const ep = this.ep
      if (!ep || !this.cards.length || !(ep.shots || []).length) return
      const L = stepLog(TAG)
      const tAll = Date.now()
      this.auto = { on: true, step: '准备中', detail: '', n: 0, total: 2, stop: false }
      const r = { prompts: null, bases: 0, cards: 0, todo: 0, fail: 0 }
      L.start('分镜已生成 → 自动流程开始：按档案生成图片提示词 → 识别装扮并建派生卡（中途可点进度条上的「停止」，切集也会停）')
      try {
        // 🔴 先按**最新工件**重建卡片：分镜刚写完 chars / scenes，组件里的 cards 可能还是旧的
        //    （`st.current.chars` 的 watcher 有 150ms 防抖，票完全可能先到）—— 不重建就会漏掉本集新出现的角色。
        await this.init(ep)
        if (this._autoStop()) return

        // ---- ① 图片提示词 ----
        this.auto.n = 1; this.auto.step = '按档案生成图片提示词'; this.auto.detail = ''
        r.prompts = await this.runBatchP(false)
        if (this._autoStop()) return
        if (r.prompts.total && !r.prompts.okN) {
          L.warn('自动流程：图片提示词一张都没生成成功 → 装扮识别已跳过（先解决提示词生成的问题，见上面各条的失败原因）')
          this.$root.toast('⚠ 提示词全部生成失败，自动流程停在原地（原因见日志面板）')
          return
        }

        // ---- ② 识别装扮 → 派生装扮卡 ----
        this.auto.n = 2; this.auto.step = '识别装扮并建派生卡'
        // 只处理「角色 + 主体卡」（视角/装扮变体卡不再往下派生；库只读副本不改本集）
        const bases = this.cards
          .filter(c => c.kind === 'character' && this.isParentCard(c) && !this.isLibRo(c))
          .map(c => c.name)
        for (const base of bases) {
          if (this._autoStop()) break
          const card = this.cards.find(c => c.kind === 'character' && c.name === base)
          if (!card) continue
          this.auto.detail = '「' + base + '」'
          let list = null
          try {
            list = await this.identifyOutfitsOf(card)
          } catch (e) {
            r.fail++
            L.fail('自动流程：识别「' + base + '」的装扮失败（跳过这个角色，其余照跑）', null, e)
            continue
          }
          if (!list || !list.length) continue
          r.bases++
          // 只派生「本集还没有卡」的那几套；基线装束是主体卡自己的定妆图，不建卡
          const picks = list.filter(o => !o.base
            && !this.cards.some(c => c.kind === 'character' && c.name === base + '--' + o.name))
            .map(o => o.name)
          if (!picks.length) continue
          const d = await this.deriveOutfitCards(base, 'character', list, picks)
          r.cards += d.created.length
          r.todo += d.todo.length
          if (d.created.length) {
            L.info('自动流程：为「' + base + '」派生 ' + d.created.length + ' 张装扮卡（' + d.created.join('、') + '）')
          }
        }
      } catch (e) {
        r.fail++
        L.fail('自动流程中断', Date.now() - tAll, e)
        this.st.fail(e)
      } finally {
        this.auto.on = false; this.auto.stop = false; this.auto.detail = ''
        const sum = '自动流程结束：图片提示词 ' + (r.prompts ? r.prompts.okN + '/' + r.prompts.total : '-') +
          ' · 识别装扮 ' + r.bases + ' 个角色（新建装扮卡 ' + r.cards + ' 张' +
          (r.todo ? '，其中 ' + r.todo + ' 张还没出图' : '') + '）' +
          (r.fail ? ' · 失败 ' + r.fail + ' 处（见日志）' : '') +
          '，总耗时 ' + secs(Date.now() - tAll) +
          '；出图与填镜头请在「生成图片」「一键填充」里执行'
        if (r.fail) L.warn(sum); else L.done(sum, null)
        this.$root.toast(sum)
      }
    },
    async confirm() {
      await this.saveAll()
      this.pl.confirm(3, this.ep.id)
      this.$root.toast('角色 & 场景已确认')
    },
    /* ---- 主体组（`主体名--视角` 双横杠命名，2026-10-08）----
       同一主体的视角变体卡：相邻摆放 + 同一个颜色 + 共用主体卡的档案。
       解析与归组的纯函数在 src/variant.js（两级命名说明也在那里）。 */
    /** 卡名 → 主体名（「魏牌 V9X--正面」→「魏牌 V9X」；不是变体时原样返回） */
    vBase(name) { return baseOf(name) },
    /** 卡名 → 视角名（不是视角变体时空串） */
    vVar(name) { return variantOf(name) },
    /** 是否变体卡（视角 / 装扮都算：变体卡不显示档案区、不单独下发档案） */
    isVariantCard(c) { return !!c && isVariant(c.name) },
    /**
     * 变体卡类型（2026-10-16）：'outfit' = 装扮变体（换装图）/ 'view' = 视角变体（三视图派生）。
     * 🔴 判据只认卡上落的 `_varKind`，**不从卡名猜**（「婚装」也可以叫「正面」；名字是用户自由填的）
     *    —— 缺字段就是 'view'（存量卡与三视图派生的卡都走这一支，行为与改造前逐字一致）。
     * ⚠️ 这个字段必须同时进 `init()` 的卡片字段白名单（漏了 → 重建丢字段 → 又会退回视角口径）。
     */
    varKindOf(c) { return (c && c._varKind === 'outfit') ? 'outfit' : 'view' },
    /** 是不是装扮变体卡（整组填充排除它、填充时按主体组整体替换、按钮与说明文案都按它分叉） */
    isOutfitVar(c) { return this.varKindOf(c) === 'outfit' },
    /**
     * 是否显示「生成3视图」勾选框（2026-10-13，Dragon）：只有**角色主体卡**该有 ——
     * 场景没有「视角」一说；视角变体卡自己不再派生视角（否则会派生出台「X--侧面--背面」
     * 这种语义不明的卡，与「派生入口只出现在主体卡」是同一条规矩）；只读库副本卡的生图按钮
     * 本来就禁用，勾选框跟着不显示。
     */
    showViewChk(c) {
      return !!c && c.kind !== 'scene' && !isVariant(c.name) && !this.isLibRo(c)
    },
    /** 该卡所在主体组的色相；只有「组内 2 张以上」的主体才上色（单张卡保持原配色，避免满屏花） */
    grpHue(c) {
      if (!c) return null
      const g = this.grpMap[baseOf(c.name)]
      return (g && g.items.length > 1) ? GROUP_HUES[hashName(g.base) % GROUP_HUES.length] : null
    },
    /** 组色 → CSS 变量（落到卡片**边框**；同一个主体的所有卡共用同一个色相，不同组色差拉满） */
    grpStyle(c) {
      const h = this.grpHue(c)
      return h == null ? {} : { '--grp-h': String(h) }
    },
    /** 组色 → 名称徽标（同一个主体的卡一眼可辨） */
    grpTagStyle(c) {
      const h = this.grpHue(c)
      return h == null ? {} : { color: 'hsl(' + h + ' 90% 86%)', borderColor: 'hsl(' + h + ' 65% 55%)' }
    },
    /** 这一组有视角变体卡、却没有名字正好等于主体名的「主体卡」→ 黄标（档案没有对外依据） */
    grpNoParent(c) {
      if (!c || !isVariant(c.name)) return false
      const g = this.grpMap[baseOf(c.name)]
      return !!(g && !g.parent)
    },
    /** 一键补建主体卡：名字取主体名，档案/提示词从组内现有内容复制（非破坏性，原变体卡不动） */
    async makeParent(c0) {
      const base = baseOf(c0.name)
      const kind = c0.kind
      if (this.cards.some(x => x.kind === kind && x.name === base)) {
        this.$root.toast('已经有一张叫「' + base + '」的卡了'); return
      }
      const g = this.grpMap[base]
      const cards = g ? g.items.map(o => o.c) : [c0]
      const nonEmpty = (x) => !!(String(x.profile || '').trim() || String(x.prompt || '').trim())
      const src = cards.find(nonEmpty) || c0
      const defRes = (this.ep && this.ep.res && this.ep.res.img) || '1920x1080'
      this.cards.push({
        kind, name: base, role: src.role || (kind === 'scene' ? '场景' : '配角'),
        profile: src.profile || '', _profRevAt: 0, _profRev: 0, _profAck: 0,
        prompt: src.prompt || '', negative: src.negative || DEFAULT_NEG,
        promptMs: 0, promptAt: 0, candidates: [], cur: -1, res: src.res || defRes, genMs: 0,
        _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0,
        _manual: true
      })
      await this.saveAll()
      this.$root.toast('已补建主体卡「' + base + '」（档案从本组复制，可直接改）；发给视频模型的档案只取它这一份')
    },
    /* ---- 一键填充：把当前选中的这张图批量填进「包含该角色/该场景」的镜头的参考图区 ---- */
    /**
     * 该镜头是否包含这张卡（角色比对 shots[].chars，场景比对 shots[].scene）。
     * 🔴 2026-10-08：视角变体卡（`主体名--视角`）按**主体名**匹配 —— 分镜里只会写主体名。
     *    这样「魏牌 V9X--正面」的一键填充能命中所有含「魏牌 V9X」的镜头，而且**不必**用「写入镜头」
     *    把 5 个视角名塞进 chars（塞进去会让模型以为片子里有 5 个产品）。
     */
    shotHas(c, s) {
      const key = baseOf(c.name)
      const raw = String((c.kind === 'scene' ? s.scene : s.chars) || '')
      if (!raw) return false
      if (c.kind === 'scene') return raw.trim() === key || raw.includes(key)
      // 角色比对准入口统一收进 promptlib.shotHasChar（2026-10-16）：出场判据在识别素材 /
      // 逐镜装扮计划 / 一键填充三处都要用，写在三处迟早分叉。loose=true 保持本处历史口径
      // （先按分隔符精确比对，不中再退回子串），场景侧不适用（场景名自己可能含顿号外的间隔号）。
      return shotHasChar(s.chars, key, true)
    },
    /**
     * 从本地导入图片当本卡的参考图（2026-10-08）：
     * - **支持多选**（2026-10-08 二次改）：原来只取 files[0]，导 4 张视角图要点 4 次「+」
     * - 每张都由主进程把它**复制**进本卡素材目录，并按卡名唯一命名（卡名.png / 卡名_02.png…）
     * - 全部并入 candidates 并自动选中最后一张（只为预览）；_imgRev +1 → 引用本资产的镜头提示词标 ⚠
     * - 只读的库副本卡不允许（与「生图」「删除卡」一致：改要去库编辑区）
     */
    async importImg(i) {
      const c0 = this.cards[i]
      if (!c0 || this.isLibRo(c0)) return
      const files = await window.studio.pickFiles('image')
      if (!files || !files.length) return
      this.busy = true
      const L = stepLog(TAG)
      const t0 = Date.now()
      try {
        const dir = this.dirOf(c0)
        const added = []
        for (let k = 0; k < files.length; k++) {
          added.push(await window.studio.importImage(dir, c0.name, files[k]))
        }
        // await 期间本地 cards 可能被 saveAll 触发的重建整体换掉 → 按 kind+name 重新解析活对象再改
        const c = this.liveCard(c0)
        c.candidates = [...c.candidates, ...added]
        c.cur = c.candidates.length - 1   // 自动选中刚导入的最后一张（只为预览）
        c.refAsBase = false               // 不当作下次图生图的底图；要图生图请显式点选缩略图
        c._imgRev = (c._imgRev || 1) + 1
        await this.saveAll()
        L.done('「' + c.name + '」已导入 ' + added.length + ' 张图片：' + added.join('、'), Date.now() - t0)
        this.$root.toast('已导入到「' + c.name + '」' + added.length + ' 张：' + added.join('、') + '（引用这些图的镜头提示词已标 ⚠，记得重新生成）')
      } catch (e) {
        L.fail('「' + c0.name + '」导入图片失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false }
    },
    /**
     * 一键填充：把图写入所有命中镜头的 refs.images。
     * - **父卡**按钮：整组（父卡自己那张 + 全部**视角**变体，父卡排第一）一次写入；
     *   **视角变体卡**按钮：只写自己那一张（用于单独替换某个视角）。
     *   🔴 **装扮变体卡**按钮：只写自己那一张，但按**主体组整体替换**（`wipe`）—— 命中同主体组
     *      的其它图（父卡标准照 + 各视角图）一并折叠成这一张，位置沿用第一条。理由：几套装扮互斥，
     *      同镜同时挂两套 = 参考图自相矛盾、H3 还会并进同一个 `<Subject N>`。独立主体组内只有自己，
     *      等价于旧行为。
     * - 判重按**同名文件 / 同卡名**（2026-10-08 起；原来按完整路径比，同名不同路径就会越填越多）：
     *   镜头里已有同名图 → 新图**替换第一条**（位置不变），其余同名条删除（「覆盖」不「追加」）
     * - 没有同名图 → 追加到末尾；参考图已满 9 张 → 跳过
     * - 只填参考图（不动首帧/尾帧/参考视频）
     * - 结束后 toast 分开报「覆盖 / 新增 / 清理重复 / 跳过」及原因
     * - 命中的镜头会因此亮 ⚠（素材签名变了 → 提示词应重新生成），这是预期行为
     */
    /** 参考图路径 → 「基础名」：去目录、去扩展名，再去掉结尾的 _02 这类重生成编号后缀。
     *  一键填充按它判「同名」（2026-10-08）：同名 = 同一张卡，与扩展名 / 重生成编号无关。 */
    refBaseOf(p) {
      const base = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
      return base.replace(/\.[^.]+$/, '').replace(/_\d+$/, '')
    },
    /** 父卡 = 名字**正好等于**主体名的那张（视角变体卡的 baseOf(name) 是别人）。独立主体也算父卡。 */
    isParentCard(c) { return !!c && baseOf(c.name) === String(c.name || '').trim() },
    /** 该卡所属主体组的张数：只有**父卡**且组内 >1 才返回真实张数（→ 按钮显示「一键填充整组」），否则 1 */
    grpSize(c) {
      const g = this.grpMap[baseOf(c.name)]
      return (this.isParentCard(c) && g) ? this.groupMembers(c).length : 1
    },
    /**
     * 该卡所属**主体组**的成员，按卡片显示顺序排列（父卡排组内第一，与 ordered() 一致）。
     * 顺序有意义：它决定「一键填充整组」写进参考图区的先后 →
     * 即 H3 提示词里 `<Picture N>` 的编号顺序（先父卡标准照，再各视角）。
     * 组内只有自己时返回 `[c]`，所以独立主体（「驾驶者」）走这里行为不变。
     * 🔴 **装扮变体不进整组**（2026-10-16）：同一角色的几套装扮是**互斥**的 —— 一次把
     *    婚装 + 月白 + 视角图全填进同一个镜头，参考图就自相矛盾（H3 还会把它们并进同一个
     *    `<Subject N>`）。装扮图只能单卡填（在该卡上点「填到镜头」），而单卡填时按**主体组整体替换**
     *    （见 fillRefs），所以「这一段戏穿这套」= 在那张装扮卡上填一次即可。
     */
    groupMembers(c) {
      const base = baseOf(c.name)
      const g = groupCards(this.cards).find(x => x.base === base)
      if (!g || g.items.length < 2) return [c]
      const items = g.items.filter(o => !this.isOutfitVar(o.c))
      if (items.length < 2) return [c]
      if (g.parent) {
        const at = items.findIndex(o => o.i === g.parent.i)
        if (at > 0) items.unshift(items.splice(at, 1)[0])
      }
      return items.map(o => o.c).filter(Boolean)
    },
    /**
     * 把**一张图**写进某个镜头的参考图数组（「一键填充」的整组口径与逐镜口径、变体卡的「填到镜头」共用这一段）。
     * 抽出来的理由：两处的判重口径必须完全一致 —— 一旦分叉，同一张图经两个入口填进去的结果不一样，
     * 用户看到的「填了却又多出一张」永远解释不清。
     * 规则：
     *   · 命中同名（文件名键 / 卡名键；装扮变体再并上「同主体组的其它变体图」）→ **覆盖第一条**（原位替换，
     *     不打乱 `<Picture N>` 的编号顺序）+ 删掉其余同名条（从后往前删，索引不漂移）
     *   · 没命中 → 追加到末尾；参考图已满 MAX_REF_IMG 张 → 跳过
     * @param {string[]} imgs 某个镜头 p.refs.images（**原地改**）
     * @param {{keys:string[], abs:string, wipe:string}} pk 一张待填的图
     * @returns {{covered:number, added:number, cleaned:number, dup:number, full:number}} 各分支处数（全 0 = 没动）
     */
    applyRef(imgs, pk) {
      const r = { covered: 0, added: 0, cleaned: 0, dup: 0, full: 0 }
      // 找出所有同名项（命中任一键 = 同一张卡）；装扮变体再并上「同主体组的其它变体图」（pk.wipe）
      const hits = []
      imgs.forEach((im, idx) => {
        const b = this.refBaseOf(im)
        if (pk.keys.indexOf(b) >= 0 || (pk.wipe && baseOf(b) === pk.wipe)) hits.push(idx)
      })
      if (hits.length) {
        // 覆盖第一条（原位替换，不打乱 <Picture N> 的编号顺序）
        if (imgs[hits[0]] !== pk.abs) { imgs[hits[0]] = pk.abs; r.covered++ }
        // 其余同名条就地删除（从后往前删，索引不漂移）
        for (let j = hits.length - 1; j >= 1; j--) { imgs.splice(hits[j], 1); r.cleaned++ }
        if (!r.covered && !r.cleaned) r.dup++
        return r
      }
      if (imgs.length >= MAX_REF_IMG) { r.full++; return r }
      imgs.push(pk.abs)
      r.added++
      return r
    },
    /**
     * 一个主体的**整组参考图**（父卡 + 各视角卡；装扮变体不在其中）→ `applyRef` 的 pick 列表。
     *
     * 🔴 抽出来的理由（2026-10-16 二次拍板）：「一键填充」与「按装扮填镜头」的**基线镜**用的是同一份名单 ——
     *    分叉就会让「穿常服的那些镜」经两个入口填出不一样的结果，用户看到的「填了却又多一张」永远解释不清。
     * @param {object} c 主体卡（父卡）；传入变体卡 → 按「单卡填充」返回它自己那一个坑位
     * @returns {{picks:Array, noImg:number, sameName:number}} noImg = 没选图的卡数；sameName = 图名重复被折叠的卡数
     */
    refPicksOf(c) {
      const picks = []
      const seen = []
      let noImg = 0, sameName = 0
      for (const m of (this.isParentCard(c) ? this.groupMembers(c) : [c])) {
        const f = this.selFile(m)
        if (!f) { noImg++; continue }              // 纯档案卡（比如父卡还没出图）→ 跳过，不报错
        const abs = this.absOf(m, f)
        // 判同名的两个键：①这张图的文件名（去扩展名与 _02 编号后缀）②卡名本身。
        // 正常情况二者相同（图按卡名命名）；但卡图也可能叫别的名字（历史数据/测试工作区），
        // 所以两个都认 —— 只要镜头里的图命中任一键，就视为「同一张卡」。
        const keys = [this.refBaseOf(abs), m.name]
        // 组内先按文件名键去重：两张卡放了同名图时，后者会**覆盖**前者 → 静默少一张。
        if (seen.indexOf(keys[0]) >= 0) { sameName++; continue }
        seen.push(keys[0])
        // 🔴 装扮变体单卡填（2026-10-16）：wipe = 主体名 —— 命中该主体的**任何**变体图（父卡 / 各视角，
        //    按 baseOf 归类，全角横杠也认）都算同一个坑位，折叠成这一张（见 applyRef 的说明）。
        picks.push({ keys: keys, abs: abs, wipe: this.isOutfitVar(m) ? baseOf(m.name) : '' })
      }
      return { picks, noImg, sameName }
    },
    /**
     * 把某张卡的图填进「包含它的所有镜头」的参考图区。
     * @param {number} i 卡片下标
     * @param {{quiet?:boolean}} [opt] quiet=true 时不弹单卡 toast（批量填充用，最后只报一条汇总）
     */
    async fillRefs(i, opt) {
      const quiet = !!(opt && opt.quiet)
      const say = (m) => { if (!quiet) this.$root.toast(m) }
      const c = this.liveCard(this.cards[i])
      if (!c) return
      // 🔴 2026-10-16 二次拍板（Dragon）：**主体卡 + 本集已识别过装扮** → 「一键填充」改走**逐镜**口径
      //    —— 穿常服的镜填主体卡整组图、换装的镜填那套装扮卡（见 fillByOutfits）。
      //    没有装扮清单 / 点的是变体卡的单卡填充 → 走下面的原整组/单卡逻辑，行为与改造前逐字一致。
      // 2026-10-20 加固：必须**有基线装束（base:true）**才走逐镜口径 —— 只认清单/卡的「有没有装扮」不够：
      //    清单若缺基线，fillByOutfits 只会提示「没有标出基线装束」然后一个镜头都不填（用户看到的就是
      //    「一键填充整组总是失败」）。这种情况退回整组口径，至少能把图填进去。
      if (this.isParentCard(c) && this.outfitListOf(baseOf(c.name)).some(o => o.base)) return this.fillByOutfits(i, opt)
      // 🔴 整组填充只挂在**父卡**按钮上（2026-10-08 Dragon 拍板）：
      //    父卡（名字正好等于主体名，如「魏牌 V9X」）的「一键填充整组」把**整组**的图一次写入
      //    —— 父卡自己那张 + 全部视角变体，父卡排第一（与 ordered() 显示顺序、<Picture N> 编号一致）；
      //    视角变体卡（「魏牌 V9X--正面」）的按钮仍是单卡单图，用于单独替换某一个视角。
      //    独立主体（名字里没有 `--`，如「驾驶者」）组内只有自己 → 行为与改造前**逐字一致**。
      const g = this.refPicksOf(c)
      const picks = g.picks
      const noImg = g.noImg, sameName = g.sameName
      if (!picks.length) { say('请先在小预览图里选中一张，再点「一键填充」'); return }
      const ep = this.ep
      const shots = (ep && ep.shots) || []
      if (!shots.length) { say('还没有镜头；先在第 4 块生成分镜再填充'); return }
      // 🔴 工件在 store 里，必须整份复制出来改完再落库（改同引用会漏存）
      const prompts = JSON.parse(JSON.stringify(ep.prompts || []))
      while (prompts.length < shots.length) prompts.push({ text: '', refs: EMPTY_REFS() })
      let covered = 0, added = 0, cleaned = 0, dup = 0, full = 0
      shots.forEach((s, k) => {
        if (!this.shotHas(c, s)) return
        if (!prompts[k]) prompts[k] = { text: '', refs: EMPTY_REFS() }
        const p = prompts[k]
        if (!p.refs) p.refs = EMPTY_REFS()
        if (!Array.isArray(p.refs.images)) p.refs.images = []
        const imgs = p.refs.images
        // 整组按顺序逐张处理：同一镜头里 <Picture N> 的次序就是 picks 的次序
        for (const pk of picks) {
          const r = this.applyRef(imgs, pk)
          covered += r.covered; added += r.added; cleaned += r.cleaned; dup += r.dup; full += r.full
        }
      })
      const changed = covered + added + cleaned
      const who = picks.length > 1
        ? '「' + baseOf(c.name) + '」整组 ' + picks.length + ' 张'
        : '「' + c.name + '」的这张图'
      if (!changed) {
        const why = []
        if (dup) why.push(dup + ' 处已有这些图')
        if (full) why.push(full + ' 处参考图已满 ' + MAX_REF_IMG + ' 张')
        say(why.length ? '没有可填充的位置（' + why.join('、') + '）'
          : '没有镜头包含「' + baseOf(c.name) + '」，未填充')
        return
      }
      try {
        await this.st.saveArtifact('prompts', prompts)
        // 通知常驻挂载的「分镜脚本」块按最新工件重建表单（否则它的本地副本会把这次填充覆盖回去）
        ep.promptsSyncAt = Date.now()
      } catch (e) { this.st.fail(e); return }
      const what = []
      if (covered) what.push('覆盖同名 ' + covered + ' 处')
      if (added) what.push('新增 ' + added + ' 处')
      if (cleaned) what.push('清理多余同名 ' + cleaned + ' 处')
      const skip = []
      if (dup) skip.push(dup + ' 处已是这些图')
      if (full) skip.push(full + ' 处已满 ' + MAX_REF_IMG + ' 张')
      if (noImg) skip.push(noImg + ' 张卡没选图')
      if (sameName) skip.push(sameName + ' 张卡图名重复')
      say('已把' + who + '写入参考图区（' + what.join('、') + '）' +
        (skip.length ? '，跳过 ' + skip.join('、') : '') + '；相关镜头提示词已标 ⚠，记得重新生成')
    },
    /**
     * 批量填充角色图（2026-10-19 Dragon）：一次把所有**已生成的图**（角色 + 场景）按每镜分镜行里的
     * 「角色 / 场景」匹配好，填进全部镜头的参考图区。
     * 🔴 复用单卡「一键填充」的整套口径（整组 / 装扮逐镜 / applyRef 判重 / 参考图区上限），
     *    只是把逐卡 toast 静音，最后报一条汇总 —— 这样批量行为与单卡行为**永远一致**，
     *    不会出现两套填充规则。只填参考图，不动首尾帧与参考视频。
     * 只跑**父卡 / 场景主体卡**：视角变体由父卡的「整组」一并带入，避免同一主体被写两遍。
     */
    async batchFillRefs() {
      const ep = this.ep
      const shots = (ep && ep.shots) || []
      if (!shots.length) { this.$root.toast('还没有镜头；先在第 3 块生成分镜再填充'); return }
      const targets = this.cards.filter(c => this.isParentCard(c) && this.selFile(this.liveCard(c)))
      if (!targets.length) {
        this.$root.toast('还没有可用的图：先「批量生成图片」，或在小预览图里选中一张再填充')
        return
      }
      const before = JSON.stringify(ep.prompts || [])
      const noShot = []          // 一个镜头都没匹配上的主体（如实报出来，不静默）
      this.batchFill = true
      try {
        for (const c of targets) {
          const i = this.cards.indexOf(c)
          if (i < 0) continue
          if (!this.hitShotCount(this.liveCard(c))) noShot.push(baseOf(c.name))
          await this.fillRefs(i, { quiet: true })
        }
      } finally { this.batchFill = false }
      const changed = JSON.stringify(ep.prompts || []) !== before
      const skip = noShot.length ? '；这些主体没有出现在任何镜头里：' + [...new Set(noShot)].join('、') : ''
      this.$root.toast(changed
        ? '已把 ' + targets.length + ' 个主体的图按镜头填进参考图区' + skip
          + '；相关镜头提示词已标 ⚠，记得重新生成'
        : '没有发生填充：这些图已经填好了（或参考图区已满 ' + MAX_REF_IMG + ' 张）' + skip)
    },
    /** 某个主体卡在本集分镜里出现了几个镜头（批量填充的汇总提示用） */
    hitShotCount(c) {
      let n = 0
      for (const s of ((this.ep && this.ep.shots) || [])) if (this.shotHas(c, s)) n++
      return n
    },
    /* ================= 按装扮把参考图填进每一镜（2026-10-16，Dragon） =================
       「有哪几套装扮、每套长什么样」由生成分镜时的自动识别解决；这一块解决「哪一镜穿哪套」。
       🔴 唯一入口是**主体卡上的「一键填充」**（2026-10-16 二次拍板：不再有独立的「按装扮填镜头」按钮 ——
          fillRefs 判断「主体卡 + 本集有装扮清单」就转到这里）。变体卡的单卡填充仍走原整组口径。
       逐镜口径：按分镜里记着的服装状态判断该穿哪套，再把那套装扮的图写进那一镜的参考图区。
       基线装束的那些镜用**主体卡的整组图**（定妆图 + 各视角，即原来的整组口径 —— 多视角参考不误伤）。 */
    /**
     * 按装扮逐镜填参考图。三段：
     *   ① `outfitListOf(主体名)` —— 项目清单（带 kw）+ 本集装扮卡；kw 是判「这一镜穿哪套」的唯一依据
     *   ② `outfitPlan(shots, 主体名, 清单)` —— 逐镜得出该穿哪套（只含他出现的镜；change 定换装点、continuity 校正）
     *   ③ 每镜取那套装扮卡当前选中的图 → 走 `applyRef`（与「一键填充」同一套判重/上限/同组折叠口径）
     * 该装扮还没建卡或还没出图 → 跳过该装扮的镜头，并在 toast 里**如实报出来**（不静默）。
     * @returns {number} 填充到的镜数（0 = 一处都没填）
     */
    async fillByOutfits(i, opt) {
      const quiet = !!(opt && opt.quiet)
      const say = (m) => { if (!quiet) this.$root.toast(m) }
      const root = this.liveCard(this.cards[i])
      if (!root) return 0
      const base = baseOf(root.name)
      const outfits = this.outfitListOf(base)
      if (!outfits.length) {
        say('这个人物在本集还没有装扮清单（分镜里没读出他换过装）—— 生成分镜时会自动识别')
        return 0
      }
      // 基线装束没有卡 —— 它就是主体卡那张定妆图。所以清单里必须标得出基线（识别过的项目一定有）。
      const baseName = (outfits.find(o => o.base) || {}).name || ''
      if (!baseName) { say('装扮清单里没有标出基线装束（重新生成分镜会自动补齐）'); return 0 }
      const ep = this.ep
      const shots = (ep && ep.shots) || []
      if (!shots.length) { say('还没有镜头；先在第 3 块生成分镜再填充'); return 0 }
      const plan = outfitPlan(shots, base, outfits)
      if (!plan.length) { say('分镜里没有「' + base + '」的镜头，或没读出这些镜头该穿哪套'); return 0 }
      // 装扮名 → 要填进该镜的图（**一律是数组**：基线那套是多张 —— 主体卡 + 各视角，即原来的整组口径）
      const picks = new Map()
      const noCard = [], noImg = []
      for (const nm of new Set(plan.map(p => p.outfit))) {
        if (nm === baseName) continue                     // 基线单独处理（见下面 refPicksOf 那一段）
        const card = this.cards.find(c => c.kind === 'character' && c.name === base + '--' + nm)
        if (!card) { noCard.push(nm); continue }
        const f = this.selFile(card)
        if (!f) { noImg.push(nm); continue }
        const abs = this.absOf(card, f)
        // wipe = 主体名：同一镜里这个主体的其它图（定妆照 / 各视角 / 别的装扮）全部折叠成这一张 ——
        // 一个镜头里他只能穿一套，同镜挂两套 = 参考图自相矛盾（H3 还会并进同一个 <Subject N>）。
        picks.set(nm, [{ keys: [this.refBaseOf(abs), card.name], abs: abs, wipe: base }])
      }
      // 🔴 基线镜（穿常服的那些）走**原来的一键填充整组口径**：主体卡 + 各视角卡都填（多视角参考不误伤）；
      //    换装的镜只填那一套（上面那条），同一镜里该主体的其它图靠 wipe 折叠掉。
      const g = this.refPicksOf(root)
      picks.set(baseName, g.picks)
      if (!g.picks.length) noImg.push(baseName)
      const mkName = nm => (nm === baseName ? '基线装束（本卡定妆图）' : nm)
      if (![...picks.values()].some(a => a.length)) {
        const why = []
        if (noCard.length) why.push(noCard.map(mkName).join('、') + ' 还没建卡')
        if (noImg.length) why.push(noImg.map(mkName).join('、') + ' 还没出图')
        say('没有能填的图：' + why.join('；'))
        return 0
      }
      // 🔴 工件在 store 里，必须整份复制出来改完再落库（改同引用会漏存）
      const prompts = JSON.parse(JSON.stringify(ep.prompts || []))
      while (prompts.length < shots.length) prompts.push({ text: '', refs: EMPTY_REFS() })
      const stat = { covered: 0, added: 0, cleaned: 0, dup: 0, full: 0, filled: 0, skipped: 0 }
      const per = {}
      for (const pl of plan) {
        const pkList = picks.get(pl.outfit) || []
        if (!pkList.length) { stat.skipped++; continue }    // 这套还没图（原因已记进上面 noCard / noImg）
        if (!prompts[pl.i]) prompts[pl.i] = { text: '', refs: EMPTY_REFS() }
        const p = prompts[pl.i]
        if (!p.refs) p.refs = EMPTY_REFS()
        if (!Array.isArray(p.refs.images)) p.refs.images = []
        // 一套可能是多张（基线 = 主体卡 + 各视角）→ 按顺序逐张写入，<Picture N> 的次序就是这里的次序
        let hit = 0
        for (const pk of pkList) {
          const r = this.applyRef(p.refs.images, pk)
          stat.covered += r.covered; stat.added += r.added; stat.cleaned += r.cleaned
          stat.dup += r.dup; stat.full += r.full
          hit += r.covered + r.added + r.cleaned
        }
        if (hit) {
          stat.filled++
          per[pl.outfit] = (per[pl.outfit] || 0) + 1
        }
      }
      const changed = stat.covered + stat.added + stat.cleaned
      if (!changed) {
        const why = []
        if (stat.dup) why.push(stat.dup + ' 镜已经是这套图')
        if (stat.full) why.push(stat.full + ' 镜参考图已满 ' + MAX_REF_IMG + ' 张')
        say(why.length ? '没有可填充的位置（' + why.join('、') + '）'
          : '没有「' + base + '」出现的镜头，未填充')
        return 0
      }
      try {
        await this.st.saveArtifact('prompts', prompts)
        // 通知常驻挂载的「分镜脚本」块按最新工件重建表单（否则它的本地副本会把这次填充覆盖回去）
        ep.promptsSyncAt = Date.now()
      } catch (e) { this.st.fail(e); return 0 }
      const what = []
      if (stat.covered) what.push('覆盖同名 ' + stat.covered + ' 处')
      if (stat.added) what.push('新增 ' + stat.added + ' 处')
      if (stat.cleaned) what.push('清理多余同名 ' + stat.cleaned + ' 处')
      const by = Object.keys(per).map(nm => mkName(nm) + ' ' + per[nm] + ' 镜').join('、')
      const skip = []
      if (noCard.length) skip.push(noCard.map(mkName).join('、') + ' 还没建卡')
      if (noImg.length) skip.push(noImg.map(mkName).join('、') + ' 还没出图')
      if (stat.dup) skip.push(stat.dup + ' 处已是对的图')
      if (stat.full) skip.push(stat.full + ' 处已满 ' + MAX_REF_IMG + ' 张')
      if (stat.skipped) skip.push(stat.skipped + ' 镜没排上装扮')
      say('已按装扮填 ' + stat.filled + ' 镜（' + by + '）：' + what.join('、') +
        (skip.length ? '；跳过 ' + skip.join('、') : '') + '；相关镜头提示词已标 ⚠，记得重新生成')
      return stat.filled
    }
  }
}
</script>
