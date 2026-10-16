<template>
  <div>
    <div v-if="busy || pBusy || vBusy" class="progress"><div class="bar indeterminate"></div></div>

    <llm-source-tag :stages="['shots', 'prompt', 'split']" where="分镜页" />

    <div v-if="!shots.length && !adapted && !busy" class="placeholder" style="margin-bottom:8px">尚无分镜。先在第 2 块完成改编稿再点「生成分镜」，或直接手动添加镜头。</div>

    <!-- 分镜自检横幅（2026-10-09）：规范写了镜头量上限（广告 = 段落数 × 1.5 / 总时长 ±20%），
         但从前程序侧零校验 —— V9X-4 出 12 镜（上限 6）时界面一声不响。这里常驻显示，并提供一键合并。
         上限由体裁声明（this.limits）；剧集没声明 → 这里恒不渲染。
         🔴 2026-10-09（Dragon）：**生成后超限一律自动合并**（见 generate 末尾），不再弹窗问用户；
         横幅只负责「事后仍不达标」的常驻提醒 + 一个手动补合入口（点一下直接执行）。 -->
    <div v-if="shotCheckInfo.issues.length" class="shot-check">
      <span class="sc-ico">⚠</span>
      <span class="sc-txt">分镜自检：{{ shotCheckInfo.issues.map(x => x.text).join('；') }}
        <b v-if="shotCheckInfo.units">（脚本 {{ shotCheckInfo.units }} 个段落 · 当前 {{ shotCheckInfo.shots }} 镜 / {{ shotCheckInfo.total }}s）</b>
      </span>
      <button v-if="mergePlan.count" class="btn sm sc-btn" @click="mergeShotsAll()"
              title="立即把行内标出「可与上一镜合并」的相邻镜头并掉（判据与黄标同一套：场景一致 + 角色集合一致 + 只有一方有台词 + 合计≤15s）">
        合并 {{ mergePlan.count }} 处 → {{ mergePlan.shots.length }} 镜
      </button>
      <!-- 自动补镜（2026-10-12）：时长容量类自检的一键修复 —— **只做加法**。
           生成时已自动做过一次（见 generate 的 fitShotCount），这里服务「手动增删镜头 / 手改时长
           之后又不达标」的场景：把装不下的长段落按声明秒数拆成多镜。绝不含合并。 -->
      <button v-if="capPlan.added" class="btn sm sc-btn" @click="fixShotCount()"
              title="按各段落声明的秒数自动补镜：把「声明秒数装不下的段落」拆成多镜。只做加法（绝不合并），拆出的画面可点「AI 重写」补写">
        自动补镜 +{{ capPlan.added }} → {{ capPlan.shots.length }} 镜
      </button>
    </div>

    <!-- 节奏体检卡（2026-10-13 建；当晚 Dragon 要求**搬到「剧本创作」卡右栏「AI 优化稿」右边**）：
         目标时长 T 是**上游输入**（它决定镜数 N），该在写剧本时就设 —— 原先只挂在分镜页，
         得先跑一次生成才知道该填多少。落点 = App.vue 的 #adapt-pace（在「AI 优化稿」小字区标右边）。
         🔴 Teleport 延迟挂载：块 1 的 <section :key> 与块 3 同随换集重建 → 必须等 DOM 真插入文档后
            再渲染，否则落点找不到（与 #shots-batch 同款，tpReady 在 mounted + $nextTick 置位）。
            两个块的 key 都是 `集id:后缀`（App.vue 的 stageKey），换集时**同时**重建 → 不会出现
            「目标在、内容没了」的半挂状态。
         🔴 镜数 N 由「目标时长 T × 画面单元 B」推导，而不是由改编稿的字数推（基座那条「每 1000 字 8-15 镜」
            是给短剧快节奏写的，会把古装正剧这种高画面密度文案估短：真人剧 350 字被估成 5 镜 / 24 秒，而目标是 1 分钟）。
            只在体裁声明了 limits.pacing 时渲染（广告不声明 → 恒不渲染，一个像素都不影响它）。
         🔴 这里填的是「本集要铺多长」，**不是**「把每个镜头拉长」—— 时长驱动**镜数**，不是拉长单镜。 -->
    <Teleport v-if="tpReady" to="#adapt-pace">
      <div v-if="paceCard" class="pace-card">
        <span class="pc-ico">🎬</span>
        <span class="pc-txt">
          节奏：<template v-if="paceCard.on">{{ paceCard.B }} 个画面单元 · </template>目标
          <input class="pc-in" type="number" min="0" max="1800" step="5" v-model.number="targetSec"
                 :disabled="busy" @change="saveTarget()"
                 title="本集要铺多长（秒）：生成分镜时镜数由它 × 画面单元数推导；0 = 不启用。改它加的是镜头数，不是把每个镜头拉长" />
          秒<template v-if="paceCard.on"> → <b>{{ paceCard.Nstar }}</b> 镜（均 {{ paceCard.asl }}s / 现 {{ paceCard.N }} 镜）· {{ paceCard.R }} 秒/单元（舒适 {{ paceCard.lo }}~{{ paceCard.hi }}）</template>
          <i v-else class="pc-note">（0 = 不启用，时长按镜头内容走）</i>
        </span>
      </div>
    </Teleport>

    <!-- 场景三方一致性横幅（2026-10-10）：改编稿 §三 声明 → scenes.json 落地 → 镜头引用。
         此前这三方从未比对过，导致「座舱·内 丢了」「四季被并成一条」这类事故程序全绿灯。
         与上面 .shot-check 分开：那个只判镜头量/时长（广告体裁专属），这个是场景档案的结构问题（所有体裁都可能）。 -->
    <div v-if="sceneDeclInfo.issues.length" class="scene-check">
      <span class="sc-ico">⚠</span>
      <span class="sc-txt">场景对不上：{{ sceneDeclInfo.issues.map(x => x.text).join('；') }}
        <b v-if="sceneDeclInfo.declared.length">（声明 {{ sceneDeclInfo.declared.length }} 条 · 落地 {{ sceneDeclInfo.landed.length }} 条 · 镜头用到 {{ sceneDeclInfo.used.length }} 个名字）</b>
      </span>
    </div>

    <!-- 脏标记（改编稿改过 → 分镜需重新生成）统一显示在本模块标题后面，见 App.vue 的 stage-head -->

    <!-- 列表视图：每行 = 该镜头的分镜编辑 | H3 提示词（含分辨率+生成视频） | 视频预览。
         🔴 无锁定：所有分区随时可编辑；上游变化由 ⚠ 脏标记提示。 -->
    <div class="shot-list">
      <div v-for="(s, i) in shots" :key="i" class="shot-row" :class="{ sel: sel === i }" @click="sel = i">
        <!-- 分区1：分镜（原阶段3 字段；只读展示入口，本区只保留删除；「生成提示词」已移到提示词区）
             🔴 无锁定：所有分区随时可编辑；上游变化由 ⚠ 脏标记提示。 -->
        <div class="zone-1">
          <div class="row-head">
            <!-- 🔴 2026-10-13（Dragon）：原来这里还挂着一颗单镜秒数（span.dur，行头显示「8s」那种），
                 已删 —— 单镜时长在下面的分镜编辑区里能看能改，行头再挂一份是冗余；
                 整体时长改为在**模块标题后面**汇总显示（见 App.vue 的 #shots-total）。
                 ⚠️ 这条注释刻意**回避**那个已删类名的字面量：测试拿它做反面断言，注释里出现它会把
                    断言直接打红（同一坑：反面断言别用裸子串，见记忆「铁律」）。 -->
            <b class="shot-tag">分镜 {{ i + 1 }}</b>
            <span v-if="contWarn(i).length" class="dur-warn"
              :title="contWarn(i).join('\n')">⚠ 连续性 {{ contWarn(i).length }}</span>
            <span v-if="contTip(i)" class="cont-tag" :class="{ chg: !!s.change }"
              title="连续性状态快照（点击编辑）：跨镜头必须保持一致的元素" @click.stop="openCont(i)">
              {{ s.change ? '状态变化' : '状态' }}
            </span>
            <span v-if="scWarnOf(s.scene)" class="dur-warn"
              :title="scWarnOf(s.scene) + ' —— 到「角色与场景」块补档案（档案是场景图的唯一依据，缺了会生成与剧本无关的通用空镜）'">
              ⚠ 场景档案
            </span>
            <span style="flex:1"></span>
            <button class="del-btn head-x" title="删除此镜头" @click="askDelShot(i)">✕</button>
          </div>
          <!-- 第二行提示区（2026-09-27，Dragon：时长建议 + 可合并提示不挤行头；都无时整行不渲染不占位）。
               可合并提示可点击 → 打开合并确认弹窗 -->
          <div v-if="durWarn(i).length || mergeWarn(i) || splitTag(i)" class="shot-sub">
            <span v-if="durWarn(i).length" class="dur-warn" :title="durWarn(i).join('\n')">{{ durTag(i) }}</span>
            <span v-if="mergeWarn(i)" class="dur-warn mrg" :title="mergeWarn(i) + '：点击查看并确认合并'"
              @click.stop="openMerge(i)">⚠ {{ mergeWarn(i) }}</span>
            <!-- 拆镜黄标（第 2 批）：本镜由程序按台词边界拆开而来。台词/场景/角色/时长已算定；
                 画面是程序按标点粗切的（各段镜头语言相同）→ 组头挂「AI 重写 / 撤回」两个动作 -->
            <span v-if="splitTag(i)" class="dur-warn spl" :title="splitTip(i)">
              {{ splitBusy(i) ? '✂ 正在重写画面…' : splitTag(i) }}
            </span>
            <button v-if="splitHead(i) && !splitBusy(i)" class="btn sm tiny" :disabled="!!rewriting"
              title="让 AI 为拆出来的每一段重写「画面动作 / 镜头语言」（只改这两个字段，台词与时长一律以程序值为准）"
              @click.stop="rewriteSplit(i)">AI 重写</button>
            <button v-if="splitHead(i) && !splitBusy(i)" class="btn sm tiny ghost" :disabled="!!rewriting"
              title="撤回拆分，恢复成拆之前的那个镜头（该镜头的视频记录会清空，文件仍在磁盘）"
              @click.stop="undoSplit(i)">撤回</button>
          </div>
          <div class="f"><label>场景</label><input v-model="s.scene" @change="touchShot(s)" /></div>
          <div class="f"><label>角色</label><input v-model="s.chars" @change="touchShot(s)" /></div>
          <div class="f"><label>画面动作</label><textarea v-model="s.action" rows="3" @change="touchShot(s)"></textarea></div>
          <div class="f"><label>对白</label><textarea v-model="s.dialogue" rows="2" @change="touchShot(s)"></textarea></div>
          <div class="row2">
            <div class="f"><label>镜头语言</label><input v-model="s.camera" @change="touchShot(s)" /></div>
            <div class="f"><label>时长/秒</label><input v-model.number="s.dur" type="number" min="4" max="15" step="1"
              @change="s.dur = clampDur(s.dur); touchShot(s)" /></div>
          </div>
        </div>

        <!-- 分区2：H3 提示词。自上而下固定顺序：
             ① 标题行（H3 提示词 · 耗时 · 脏标） ② 提示行（角色 · 时长 · 动作摘要）
             ③ 素材区（单行） ④ 提示词文本框 ⑤ 「生成提示词」按钮（靠左）
             ⑥ 视频分辨率 ⑦ 路线提示靠左 + 「生成视频」靠右 -->
        <div class="zone-2">
          <div class="row-head">
            <span class="zone-tag">{{ promptZoneName() }}</span>
            <span v-if="genTextP(i)" class="gen-ms" :class="{ live: prompts[i] && prompts[i]._genAt }">{{ genTextP(i) }}</span>
            <span style="flex:1"></span>
            <span v-if="promptStale(i)" class="stale" @click="ackPrompt(i)" title="点击消除提示">
              {{ staleWhatPrompt(i) }} · <b>生成</b>后消失
            </span>
          </div>
          <!-- 2026-10-10（Dragon）：本区标题下方的文案整块移除 ——
               原来还有「角色 · 时长 · 动作/对白摘要」摘要行与「正在生成提示词…」；
               标题行右侧的耗时胶囊已经在做「生成中 / 本次耗时」的反馈，摘要行只是重复信息。 -->

          <!-- 参考素材：都可不选（什么都不选＝纯文字）。全部素材排在**同一行**（不换行，放不下就横向滚动）：
               参考图1、参考图2…（＋参考图）｜ 视频1、视频2…（＋参考视频）｜ 首帧 ｜ 尾帧。
               图片类 3:4 竖框 64×85、视频类 4:3 横框 113×85，三类等高 85；
               左侧文字标签已去掉 —— 改到每张图左上角显示角标（参考图 / 视频 / 首帧 / 尾帧） -->
          <div class="refs" v-if="prompts[i]">
            <div class="ref-row">
              <!-- 参考图可拖动改顺序（2026-10-08）：顺序决定提示词里 <Picture N> 的编号，
                   松手才重排（拖动中只高亮目标位，避免 key 抖动导致图片闪一下） -->
              <div v-for="(f, k) in prompts[i].refs.images" :key="'ri' + k" class="ref-thumb"
                   draggable="true"
                   :class="{ 'drag-src': dragFrom && dragFrom.i === i && dragFrom.k === k,
                             'drag-to': dragTo && dragTo.i === i && dragTo.k === k,
                             unused: refUnused(i, 'images', k) }"
                   @dragstart="refDragStart(i, k)" @dragover.prevent="refDragOver(i, k)"
                   @drop.prevent="refDragDrop(i, k)" @dragend="refDragEnd()">
                <img :src="refSrc(f)" :title="refTitle(i, 'images', k, f)" />
                <span class="rtag">参考图</span>
                <button class="img-x" title="移除" @click.stop="delRef(i, 'images', k)">✕</button>
              </div>
              <button v-if="caps.refImage !== false && prompts[i].refs.images.length < maxRefImg" class="ref-add" :title="'从本地选参考图（最多 ' + maxRefImg + ' 张）'" @click="addRef(i, 'images')">参考图</button>

              <div v-for="(f, k) in prompts[i].refs.videos" :key="'rv' + k" class="ref-thumb vid"
                   :class="{ unused: refUnused(i, 'videos', k) }" :title="refTitle(i, 'videos', k, f)">
                <video v-if="refVidSrc(f)" :src="refVidSrc(f)" controls preload="metadata"></video>
                <div v-else class="ph-mini"><i class="spin"></i>加载中…</div>
                <span class="rtag vid">视频</span>
                <button class="img-x" title="移除" @click.stop="delRef(i, 'videos', k)">✕</button>
              </div>
              <button v-if="caps.refVideo !== false && prompts[i].refs.videos.length < maxRefVid" class="ref-add wide" :title="'从本地选参考视频（最多 ' + maxRefVid + ' 个）'" @click="addRef(i, 'videos')">参考视频</button>

              <div v-if="prompts[i].refs.first" class="ref-thumb" :class="{ framestale: firstStale(i) }">
                <img :src="refSrc(prompts[i].refs.first)" :title="firstTitle(i)" />
                <span class="rtag">首帧</span>
                <button class="img-x" title="移除首帧" @click.stop="clearFrame(i, 'first')">✕</button>
                <!-- 2026-10-10（Dragon）：首帧一旦选中就不再显示「重取」按钮 —— 想重新取，点 ✕ 清掉，
                     首帧格会恢复成「首帧 / 取上镜尾帧」两个入口，重选即可。
                     接力来源（refs.firstFrom='prev-shot'）保留：过期描边 + 悬停提示仍能看出这个首帧过期了。 -->
              </div>
              <template v-else-if="caps.firstFrame !== false">
                <!-- 首帧两个入口合并进同一格（2026-10-09）：外框仍是 64×85，中间不画分隔线。
                     上半「首帧」= 手动从本地选图；下半「取上镜尾帧」= 直接拿上一镜真实的最后一帧当起始画面。
                     为什么要接力：H3 是逐镜独立生成，本镜拿不到「上一镜结束时画面长什么样」，
                     接缝只能靠模型猜 —— 这是镜头间漂移最大的来源；给一张真实起始画面，接缝就是连续的。 -->
                <div class="ref-add stack">
                  <button class="rs-main" title="从本地选一张图作为首帧（手动）" @click="pickFrame(i, 'first')">首帧</button>
                  <button class="rs-chain" :class="{ dim: !prevShotVideo(i) }"
                          :disabled="!prevShotVideo(i) || frameBusy === i || chainBusy"
                          :title="prevShotTip(i)" @click="takePrevLastFrame(i)">
                    <span v-if="frameBusy === i"><i class="spin"></i>取帧…</span>
                    <span v-else>取上镜尾帧</span>
                  </button>
                </div>
              </template>

              <div v-if="prompts[i].refs.last" class="ref-thumb">
                <img :src="refSrc(prompts[i].refs.last)" title="尾帧" />
                <span class="rtag">尾帧</span>
                <button class="img-x" title="移除尾帧" @click.stop="clearFrame(i, 'last')">✕</button>
              </div>
              <button v-else-if="caps.lastFrame !== false" class="ref-add" title="选一张图作为尾帧（与首帧配合可做首尾帧过渡）" @click="pickFrame(i, 'last')">尾帧</button>

            </div>
          </div>

          <!-- 提示词文本：高度自适应，占满本区剩余空间（内容超出在框内滚动） -->
          <div class="f ta-main"><textarea v-model="prompts[i].text" rows="6" :placeholder="promptPlaceholder()"
                                           @change="touchPrompt(i)"></textarea></div>

          <!-- 「生成提示词」（次级功能：绿色）：在提示词框下方，靠左单独一行 -->
          <div class="cops gen-p-row">
            <button class="btn sec sm"
                    :disabled="pBusy || !prompts[i]" :title="'按本行分镜与参考素材重新生成本镜头的 ' + promptZoneName()"
                    @click="genP(i)">
              <span v-if="prompts[i] && prompts[i]._gen" class="busy-txt"><i class="spin"></i>生成中…</span>
              <span v-else>生成提示词</span>
            </button>
          </div>

          <!-- 底部：生成路线提示靠左｜视频分辨率 + 生成视频按钮靠右 -->
          <div class="cops zone-foot">
            <span class="ref-mode">
              <span v-if="prompts[i]" class="mode-tag" :class="modeOf(prompts[i], i).cls">{{ modeOf(prompts[i], i).tag }}</span>
              <span v-if="prompts[i]" class="hint">{{ modeOf(prompts[i], i).text }}</span>
            </span>
            <span style="flex:1"></span>
            <!-- 视频分辨率（从提示词上方移入；宽度按内容自适应，不撑满父布局）。
                 🔴 只在批量跑动中禁用——「已采用」不算锁定（2026-09-23 起采用按钮已移除、点选即选中），
                 生成过视频后仍要能换分辨率重新生成（旧版挂在 confirmed 上是锁定工作流残留） -->
            <label class="card-res res-fit" v-if="vstate[i]">视频分辨率
              <select v-model="vstate[i].res" :disabled="vBusy" @change="saveVideos()">
                <option v-for="o in optsFor(i)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <!-- 🔴 2026-10-09：这一镜正在生成时，按钮由灰变红可点 = 强制停止（中断 ComfyUI 任务 + 释放显存）。
                 原来这里是 disabled，只能干等——一个 20 步高分辨率任务可能跑 30 分钟以上。 -->
            <button v-if="vstate[i] && vstate[i]._gen" class="btn sm danger"
                    :disabled="stopBusy"
                    :title="stopBusy ? '正在停止…' : '立刻中断这一镜的生成任务，并让 ComfyUI 释放显存（本次进度丢弃）'"
                    @click="stopVideoGen(i)">
              <span v-if="stopBusy" class="busy-txt"><i class="spin"></i>停止中…</span>
              <span v-else>停止生成</span>
            </button>
            <button v-else class="btn sm" :class="{ regen: vstate[i] && vstate[i].files.length }"
                    :disabled="vBusy || !prompts[i] || !prompts[i].text.trim()" @click="genV(i)">
              生成视频
            </button>
          </div>
        </div>

        <!-- 分区3：视频预览（生成按钮与分辨率都在左侧 H3 提示词区；已生成的视频任何状态都能播放）
             同一镜头的多个版本上下摆放，最多显示最新 2 个（两者平分上方剩余区域）；
             点击哪个哪个变当前版本（蓝框）= 即选中（生成完成自动选中最新版，无「采用」按钮） -->
        <div class="zone-3">
          <div class="row-head"><span class="zone-tag">视频生成</span></div>
          <!-- 固定 2 个等高槽位（标题 / 文案之外的空间平分），每槽一个 16:9 播放框；
               没有视频时两槽都显示占位符；只有 1 个视频时占第 1 槽、第 2 槽仍是占位符 → 行高与份高都不跳动。
               点击哪个哪个变当前版本（蓝框） -->
          <div class="vid-stack" :class="{ 'card-busy': vstate[i] && vstate[i]._gen }">
            <span v-if="vstate[i] && vstate[i]._gen" class="busy-txt"><i class="spin"></i>生成中…</span>
            <div v-for="(v, si) in slotList(i)" :key="'slot' + si" class="vslot">
            <div v-if="v" class="video-box"
                 :class="{ cur: v.k === curIdx(i), stalevid: videoStale(i) }"
                 :title="'点击画面选为当前版本（第 ' + (v.k + 1) + ' 版）'" @click="boxClick($event, i, v.k)">
              <video v-if="videoSrc(v.f)" :src="videoSrc(v.f)" controls></video>
              <div v-else class="ph">镜头 {{ i + 1 }}<br>加载中…</div>
              <span class="vid-ver">{{ v.k + 1 }}/{{ vstate[i].files.length }}</span>
              <!-- 每一版各自的生成耗时（2026-10-10）：生成时按当次实测毫秒记进 videos.json 的
                   fileMs[文件名]；老数据没有这条记录就不显示。悬浮在框右上角，与左上角版本号错开。
                   🔴 文案在 vidList 里就格式化成 msText —— fmtMs 是 import 的纯函数，
                   本组件是 Options API，模板里访问不到（探针实测 `t.fmtMs is not a function`）。 -->
              <span v-if="v.msText" class="gen-ms vid-ms" :title="'这一版生成耗时 ' + v.msText">{{ v.msText }}</span>
            </div>
              <div v-else class="video-box">
                <div class="ph">镜头 {{ i + 1 }}<br>待生成</div>
              </div>
            </div>
          </div>
          <!-- 2026-10-10（Dragon）：本区下方只留脏标记 ——
               「镜头 N · 角色 · 时长」摘要、生成耗时胶囊、本次参考素材三行文案全部移除；
               每条视频自己的生成耗时改成视频框右上角的角标（.vid-ms）。 -->
          <div class="vmeta">
            <!-- 脏标记：提示词/分镜/素材图在上次视频生成之后又变了 -->
            <div v-if="videoStale(i)" class="stale" style="margin-top:4px" @click="ackVideo(i)" title="点击消除提示">
              {{ staleWhatVideo(i) }} · <b>生成视频</b>后消失
            </div>
          </div>
        </div>
      </div>

      <!-- 手动加镜头：放在已生成镜头的最后一行（无镜头时就是唯一入口） -->
      <div class="shot-row add-row" @click="addRow">
        <span class="add-plus">＋</span>
        <span class="add-txt">手动添加镜头</span>
      </div>
    </div>

    <!-- 2026-09-23：本块底部的三行说明文字（整块生成耗时 / 角色·场景档案产出条数提示 / 分阶段操作提示）
         已按需求全部移除，产物下方不再挂任何说明行；批量入口在模块标题行 -->

    <!-- 批量按钮：Teleport 到块 3 标题行右边（App.vue 的 #shots-batch）（2026-09-27 三改，Dragon：回到标题栏、恢复普通 .btn 样式）。
         🔴 Teleport 延迟挂载：切集时 <section :key> 整棵重建，mounted 前 #shots-batch 不在文档里 → 必须 tpReady。
         空闲 = 「批量生成提示词 / 批量生成视频」；跑动中 = 「停止批量」（提示词那颗，软停：当前跑完即止）；
         视频那颗跑动中 = 「停止生成」（2026-10-09 改为硬停：点了立刻中断当前任务并结束整批）；
         已请求停止 = 「停止中…」（禁点，收尾后自动恢复） -->
    <!-- 分镜总时长（2026-10-13，Dragon）：所有镜头 dur 之和，**实时**跟随编辑 / 拆分 / 合并 / 增删。
         落点 = App.vue「分镜脚本」模块标题后面的 #shots-total（同 tpReady 机制）。
         🔴 这里只做**只读汇总**，不放输入框 —— 单镜时长在分镜编辑区里改，这里跟着变。
         🔴 2026-10-13 傍晚按实机反馈修正两处：
            ① 纯文字、不带任何 emoji 图标（原来前面挂了一颗闹钟）。
            ② `totalDur` 必须定义在 **computed** 里 —— 首版误塞进 methods，而模板写 `{{ totalDur }}`
               不带括号取值，Vue 会把这个 bind 到实例上的方法原样渲染成原生函数字符串。 -->
    <Teleport v-if="tpReady" to="#shots-total">
      <span v-if="shots.length" class="total-dur"
            :title="'本集 ' + shots.length + ' 个镜头的时长合计（单镜上限 15s；成片还含转场与片头片尾，实际会略长）'">
        总时长 {{ totalDur }}s
      </span>
    </Teleport>
    <Teleport v-if="tpReady" to="#shots-batch">
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && prompts.some(p => p.text.trim()), danger: batchP || batchPStop }"
              :disabled="batchPStop || batchV"
              :title="batchP ? '点击停止：当前镜头跑完后，剩余镜头不再执行' : '重新生成所有镜头的提示词，或只补缺失的'"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchV && !batchVStop && shots.some((_, i) => vstate[i] && vstate[i].files.length), danger: batchV || batchVStop }"
              :disabled="batchVStop || batchP || (!batchV && !prompts.some(p => p && p.text.trim()))"
              :title="batchV ? '点击立刻停止：中断当前镜头的生成任务并释放显存，剩余镜头不再执行（当前进度丢弃）' : (prompts.some(p => p && p.text.trim()) ? '重新生成所有镜头的视频，或只补没有视频的镜头' : '当前没有任何 H3 提示词：请先逐镜头生成提示词，或用左边的「批量生成提示词」')"
              @click="batchVideos">
        <span v-if="batchVStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchV">停止生成({{ batchVN }}/{{ batchVTotal }})</span>
        <span v-else>批量生成视频</span>
      </button>
      <!-- 一键合并可合并镜头（2026-10-09）：把行内黄标标出的「可与上一镜合并」一次并掉 ——
           此前只能逐镜点黄标 → 弹窗 → 确认，实测 12 镜里有 8 处可合并 = 手点 8 次。
           判据与黄标同源（promptlib.mergeAllShots），没有可合并的时按钮自动禁用。
           2026-10-09（Dragon）：**点一下直接执行**，不再弹确认框（生成后自检超限时也是同一个方法自动跑）。 -->
      <button class="btn sm" :disabled="!mergePlan.count || batchP || batchV || busy"
              :title="mergePlan.count ? '把行内标出「可与上一镜合并」的相邻镜头一次合并（共 ' + mergePlan.count + ' 处），点一下直接执行' : '没有可合并的相邻镜头'"
              @click="mergeShotsAll()">合并镜头{{ mergePlan.count ? '(' + mergePlan.count + ')' : '' }}</button>
      <!-- 首帧接力（2026-10-09）：把第 2 个及之后每个镜头的首帧设成上一镜视频的最后一帧。
           一次跑完（2..N），比逐个点快；上一镜还没出片的镜头自动跳过。
           2026-10-09（Dragon）：入口隐藏（v-if="false"），chainAllFrames / chainBusy 与弹窗逻辑原样保留 ——
           改回 v-if 即可恢复（与「整理镜头」同一手法）。 -->
      <button v-if="false" class="btn sm" :disabled="shots.length < 2 || chainBusy || batchP || batchV || vBusy"
              :title="shots.length < 2 ? '至少要有 2 个镜头才能续接首帧' : '把第 2 个及之后每个镜头的首帧设为上一镜视频的最后一帧 —— 相邻镜头画面接得上，接缝不用靠模型猜。上一镜还没出片的镜头会自动跳过'"
              @click="chainAllFrames">
        <span v-if="chainBusy" class="busy-txt"><i class="spin"></i>续接中…</span>
        <span v-else>一键续接首帧</span>
      </button>
      <!-- 整理镜头（第 2 批）：存量分镜一次性按内容重算时长 + 拆分超单镜上限的镜头。
           放在批量按钮之后，避免与「生成」类操作混在一起误触。
           2026-09-29（Dragon）：入口隐藏（v-if="false"），功能与弹窗代码原样保留 —— 改回 v-if 即可恢复 -->
      <button v-if="false" class="btn sm" :disabled="!shots.length || batchP || batchV"
              title="按内容重算所有镜头的时长，并把超过单镜 15s 上限的镜头按台词边界拆开（手改过的镜头不动）"
              @click="askTidy = true">整理镜头</button>
    </Teleport>

    <!-- 批量范围选择弹窗（全部重新生成 / 只生成缺失的） -->
    <div v-if="askBatch" class="modal-mask" @click.self="askBatch = null">
      <div class="modal">
        <div class="modal-title">批量生成{{ askBatch.kind === 'prompts' ? '提示词' : '视频' }}</div>
        <div class="modal-body">
          共 {{ shots.length }} 个镜头，请选择生成范围：
          <div style="margin-top:6px">
            <b>全部重新生成</b> —— {{ askBatch.kind === 'prompts'
              ? '覆盖所有镜头的已有提示词（已生成的视频保留，标 ⚠ 上游已更新）'
              : '所有镜头都出新视频，新版本追加、旧版本保留可切换' }}；
          </div>
          <div><b>只生成缺失的</b> —— {{ askBatch.kind === 'prompts'
            ? '只为还没有提示词的镜头生成'
            : '只为还没有任何视频文件的镜头出片（已生成但未采用的不动）' }}。</div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="askBatchAll">全部重新生成</button>
          <button class="btn" @click="askBatchMissing">只生成缺失的</button>
          <button class="btn ghost" @click="askBatch = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 连续性状态编辑（跨镜头一致性的唯一数据源：分镜环节产出，可手改；生成 H3 提示词时逐镜注入）
         2026-09-27（Dragon）：弹窗加大（modal-lg），内容要能显示全 -->
    <div v-if="contEdit !== null" class="modal-mask" @click.self="contEdit = null">
      <div class="modal modal-lg">
        <div class="modal-title">镜头 {{ contEdit + 1 }} · 连续性状态</div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:7px">
            每行一条「主体·维度：本镜的状态」。生成 H3 提示词时这是钉住服装 / 随身物的唯一依据 ——
            无论本镜是否发生变化，都要写全当前状态（上一镜披着蓑衣，本镜就还得写披着蓑衣）。
          </div>
          <label style="font-size:10.5px;color:#7c8798">状态快照 continuity</label>
          <textarea v-model="contForm.continuity" rows="9" style="width:100%;margin-top:3px"
                    placeholder="顾长风·外观：湿透粗布衣（蓑衣已解开搭在左臂）&#10;顾长风·随身物：残破灯笼（右手）"></textarea>
          <label style="display:block;font-size:10.5px;color:#7c8798;margin-top:8px">本镜发生的变化 change（无则留空）</label>
          <textarea v-model="contForm.change" rows="4" style="width:100%;margin-top:3px"
                    placeholder="顾长风·蓑衣：披在身上 → 已解开搭在左臂（解开蓑衣）"></textarea>
          <div v-if="contWarn(contEdit).length" class="modal-note" style="white-space:pre-wrap">
            <b>校验提示</b>{{ '\n' }}{{ contWarn(contEdit).join('\n') }}
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="saveCont">保存</button>
          <button class="btn ghost" @click="contEdit = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 镜头合并确认（两镜并排展示 + 合并预览；点「合并成一镜」后程序确定性处理所有字段） -->
    <div v-if="askMerge !== null && mergePreview" class="modal-mask" @click.self="askMerge = null">
      <div class="modal">
        <div class="modal-title">合并镜头 {{ askMerge }} 与 {{ askMerge + 1 }}</div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:7px">
            合并后的镜头：场景/角色不变，动作拼接、对白逐行保留、时长相加（{{ shots[askMerge - 1].dur }}+{{ shots[askMerge].dur }}={{ mergePreview.dur }}s）、
            状态快照取后镜。镜头 {{ askMerge + 1 }} 的提示词与视频记录移除（已生成的视频文件仍在磁盘），
            后续镜头自动前移、不受影响。
          </div>
          <div class="merge-cols">
            <div class="merge-col">
              <div class="merge-h">镜头 {{ askMerge }}</div>
              <div class="merge-b">{{ shots[askMerge - 1].action || '（无动作）' }}</div>
              <div class="merge-b dlg" v-if="shots[askMerge - 1].dialogue">{{ shots[askMerge - 1].dialogue }}</div>
            </div>
            <div class="merge-col">
              <div class="merge-h">镜头 {{ askMerge + 1 }}</div>
              <div class="merge-b">{{ shots[askMerge].action || '（无动作）' }}</div>
              <div class="merge-b dlg" v-if="shots[askMerge].dialogue">{{ shots[askMerge].dialogue }}</div>
            </div>
          </div>
          <div class="merge-h" style="margin-top:8px">合并预览</div>
          <div class="merge-b" style="white-space:pre-wrap">{{ mergePreview.action }}</div>
          <div class="merge-b dlg" v-if="mergePreview.dialogue" style="white-space:pre-wrap">{{ mergePreview.dialogue }}</div>
          <div class="merge-b" style="color:#7c8798">时长 {{ mergePreview.dur }}s · {{ mergePreview.camera || '镜头语言沿用' }}</div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="doMerge(askMerge)">合并成一镜</button>
          <button class="btn ghost" @click="askMerge = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 整理镜头确认（存量分镜：按内容重算时长 + 拆分超单镜上限的镜头） -->
    <div v-if="askTidy" class="modal-mask" @click.self="askTidy = false">
      <div class="modal">
        <div class="modal-title">整理镜头</div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:7px">
            按内容重算每个镜头的时长（模型填的秒数不作数），再把超过单镜 15s 上限的镜头按台词边界拆开。<br>
            本次将处理：时长重算 <b>{{ tidyPreview.durFixed }}</b> 个镜头 · 拆分 <b>{{ tidyPreview.groups.length }}</b> 组
            · 镜头数 {{ tidyPreview.from }} → <b>{{ tidyPreview.to }}</b>
          </div>
          <div class="hint" style="color:#f0b46a">
            被拆开的镜头：提示词作废、视频记录清空（已生成的视频文件仍在磁盘），素材选择沿用；
            拆出的每一段带「✂ 程序拆分」黄标，画面是程序按标点粗切的，可再点「AI 重写」让模型补写。<br>
            手改过的镜头（时长/画面动过）本次不做任何改动。
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn" @click="tidyShots">开始整理</button>
          <button class="btn ghost" @click="askTidy = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 🔴 2026-10-09（Dragon）：批量合并的**确认弹窗已删除**。
         「刚分镜完就弹一个要我点合并的框」体验很差 —— 生成后自检超限时直接自动合并（见 generate 末尾），
         横幅与标题栏的按钮也都改成点一下直接执行。判据仍是行内黄标那一套（promptlib.mergeAllShots），
         被并掉的那一镜只是槽位记录清空（磁盘文件仍在），合并后的镜带 _rev 脏标（提示词/视频自动标过期）。 -->
  </div>
</template>

<script>
import { useProject as useProjectStore } from './stores/project.js'
import { usePipeline, fmtMs } from './stores/pipeline.js'
import { stepLog, secs, dbgPrompt } from './ulog.js'
import { composeSystem, composeUser, normalizeProfile, currentStyleLimits } from './prompts.js'
import { durWarnings, durSuggest, durFit, durTag, contWarnings, mergeWarnings, mergeShotPair, mergeAllShots, fitDurs, fitShotCount, pacingPlan, shotCheck, storyUnits, sceneKey, sceneAlign, sceneCardIssues, sceneDeclIssues, charAlign, stripTailEnNote, profileBrief, splitShot, splitAll, splitTag, auditModelArchive } from './promptlib.js'
import { parseRes, resLabel, optsWith, clampDur, seg, joinPath } from './resutil.js'
import { baseOf, variantOf, groupProfiles } from './variant.js'
import { touchRevs, sigStale, staleReason, refOrderSig, SIG_V } from './stale.js'
import LlmSourceTag from './LlmSourceTag.vue'
import { overrideOf } from './llmSource.js'

// 🔴 提示词全部来自项目 prompts/ 下的规范 md：shots.md 承载任务身份与 JSON 输出契约，
//    profile.md / chars.md / scenes.md 承载档案与提示词写法；代码不再硬编码任何提示词片段

// ---- H3 提示词（原阶段5）----
// 🔴 任务身份、提示词格式（三段式/六段式）与输出契约全部由规范文件承载：h3.md（基础模式 T2VA/I2VA/FL2VA/L2VA）、
//    h3ref.md（参考模式 Ref2VA 六段），代码不硬编码任何提示词——按镜头素材分流加载。

const MAX_REF_IMG = 9
const MAX_REF_VID = 3
// 整段 mp4 的 base64 很占内存（字符串约是文件体积的 2.7 倍），多镜头累积会拖垮渲染进程，
// 因此只保留最近这几个的缓存（在生成/换集等非渲染时机清理）。
// 每行视频区最多同时显示 2 个版本 → 4 个镜头最多 8 个，留 8 个缓存避免来回重读。
const B64_KEEP = 8
// 参考视频（第 5 块里选的素材）同样按 base64 预览，另用一份小缓存（生成/换集时一起清理）
const REFV_KEEP = 6

export default {
  name: 'StageShots',
  components: { LlmSourceTag },
  data() {
    return {
      shots: [], busy: false,
      // 参考图拖动排序（运行态，不落库）：dragFrom = 拖起的起点 {i,k}；dragTo = 当前悬停的目标位
      dragFrom: null, dragTo: null,
      // H3 提示词（原 StagePrompts）
      prompts: [], pBusy: false, _autoEp: null, _ref64: {}, _refv: {},
      // 视频生成（原 StageVideos）
      vstate: {}, vBusy: false, _b64: {},
      // 首帧接力（2026-10-09）：frameBusy = 正在取帧的镜头下标（-1 = 空闲）；
      // chainBusy = 「一键续接首帧」在跑；frameStale = { 镜头下标: 'changed' | 'gone' }
      //   —— 首帧取自上一镜末帧、而上一镜后来又重新出片 → 这个首帧就过期了，行上给黄标。
      frameBusy: -1, chainBusy: false, frameStale: {},
      // 批量任务（块 3 标题行的两个按钮）：batch*=队列在跑；*Stop=已点停止等当前子任务收尾；
      // askBatch=范围选择弹窗 { kind: 'prompts' | 'videos' }
      // batch*N/Total=按钮上的进度（正在生成第 N 个 / 共 Total 个），跑完/停止归零
      batchP: false, batchPStop: false, batchV: false, batchVStop: false, askBatch: null,
      // 🔴 2026-10-09：stopBusy = 正在执行「强制停止生成」（防重复点）。
      //    注意与 batch*Stop 的区别：那些是"等当前跑完再停"的软停止，stopBusy 走的是硬停止。
      stopBusy: false,
      batchPN: 0, batchPTotal: 0, batchVN: 0, batchVTotal: 0,
      // 连续性状态编辑弹窗（contEdit = 镜头下标，null = 关闭；contForm = 弹窗里的两份草稿）
      contEdit: null, contForm: { continuity: '', change: '' },
      // 镜头合并确认弹窗（askMerge = 后镜下标 i，合并 i-1 与 i；null = 关闭）——
      // 只服务**逐镜**合并（点行内黄标）。批量合并没有弹窗：点按钮/自检超限都直接执行。
      askMerge: null,
      // 当前体裁声明的分镜自检参数（genre json 的 limits，见 prompts.currentStyleLimits）：
      // 广告 = { shotsPerUnit: 1.5, durTol: 0.2 }；剧集 = { pacing: {...} }（双轨配时，2026-10-13）；
      // 都没声明 = {} → 自检不判
      limits: {},
      // 单集目标时长（秒，项目级，见 db 的 projects.target_sec）：双轨配时的输入。
      // 0 = 未设置 → pacingPlan 整层惰性（行为与改造前逐字不变）
      targetSec: 0,
      // 「整理镜头」确认弹窗（存量分镜按内容重算时长 + 拆分超限镜头）
      askTidy: false,
      // 正在 AI 重写的拆分组的 gid（'' = 空闲）——同一组的每一段都能据此显示「正在重写画面…」
      rewriting: '',
      // 🔴 Teleport 延迟挂载开关：块 3 的 <section :key> 切集时整棵重建，Vue 在脱离文档的子树里
      // 挂载本组件时 document.querySelector('#shots-batch') 拿不到目标 → 内容被静默丢弃。
      // 必须 mounted + nextTick（DOM 已插入文档）后再渲染 Teleport
      tpReady: false,
      // 有生成在跑时 = 该次生成所属的集 id；切集时改置 'SWITCHED'（收尾写库守卫据此丢弃，防旧集数据写进新集）
      _busyEpId: null,
      // 当前点选高亮的镜头行（点击行内任意空白处高亮，点其他行切换）
      sel: -1,
      // 🔴 素材文件指纹（2026-10-16）：{ 绝对路径: "大小:修改时间" }，主进程现算（见 electron/filesig.cjs）。
      //    脏标记靠它发现「参考图被换掉了」—— 没有它，用户手工换图（覆盖同名文件）时
      //    提示词/视频明明过期了却一个字都不提示。见 stale.js 的「素材签名 v2」。
      asig: {}, asigReady: false
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    adapted() { return this.st.current ? this.st.current.adapted : '' },
    chars() { return this.st.current ? this.st.current.chars : [] },
    scenes() { return (this.st.current && this.st.current.scenes) || [] },
    epProjectId() { return this.st.current ? this.st.current.projectId : null },
    /** 依赖每秒自增的 tick，让「生成中 已用 X」实时刷新 */
    live() { return this.pl.tick },
    allPromptsFilled() { return this.prompts.length > 0 && this.prompts.every(p => p.text.trim()) },
    /** 参考素材上限（模板里显示「最多 N 张/个」用；method 里放常量不会挂到实例上，必须走 computed） */
    maxRefImg() { return MAX_REF_IMG },
    maxRefVid() { return MAX_REF_VID },
    /** 当前视频方案的能力声明：不支持的素材入口直接不出现在界面上（换模型时 UI 自动降级） */
    caps() { return (this.st.caps && this.st.caps.video) || {} },
    /** 文件名前缀（= 集名）：2026-09-24 扁平化后一个项目共用「分镜/」「成片/」目录，
     *  视频文件必须带集名前缀才不会被别的集覆盖（主进程也按此前缀归集） */
    epPrefix() {
      const ep = this.st.current
      if (!ep) return 'shot'
      return ep.prefix || String(ep.name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'shot'
    },
    /** 连续性校验结果（与 shots 等长的数组的数组）；一次算全表，避免每行重算 O(n²) */
    contAll() { return contWarnings(this.shots) },
    /** 全量合并计划（纯函数，供「一键合并」按钮与确认弹窗共用）：{ shots, count, map } */
    mergePlan() { return mergeAllShots(this.shots) },
    /**
     * 分镜自检（2026-10-09）：把「生成出多少镜 / 多长」与「改编稿里有几个叙事单元」对一遍。
     * 上限来自**体裁声明**（this.limits）—— 广告体裁是「段落数 × 1.5」与「脚本各段合计 ±20%」；
     * 剧集体裁改为 `limits.pacing`（双轨配时：镜数由目标时长 × 画面单元数推）。
     * 与规范（shots-ad.md「镜头量」）逐字对应，只是把「只有模型自己知道」变成「界面也拦一道」。
     */
    shotCheckInfo() {
      return shotCheck({ shots: this.shots, adapted: this.adapted, limits: this.limits, targetSec: this.targetSec })
    },
    /** 项目级的单集目标时长（秒）—— 与 db 的 projects.target_sec 同步，随项目配置弹窗一起改 */
    projTargetSec() {
      const p = (this.st.tree || []).find(x => x.id === this.epProjectId)
      return Math.max(0, Math.round(Number(p && p.res && p.res.targetSec) || 0))
    },
    /**
     * 节奏体检卡的数据（双轨配时，2026-10-13）。
     * 返回 null = 当前体裁**没声明** limits.pacing（广告）→ 卡片恒不渲染，一行都不影响它。
     * 声明了但没填目标时长（T=0）→ on:false，卡片只显示输入框（让用户填）。
     * 判据全部来自 pacingPlan，与模型写了什么无关：B 从改编稿逐行数、R = T/B 与镜数无关。
     */
    paceCard() {
      if (!(this.limits && this.limits.pacing)) return null
      const p = pacingPlan({ adapted: this.adapted, shots: this.shots, targetSec: this.targetSec, limits: this.limits })
      if (!p.ok) return { on: false, B: 0, units: 0 }
      return {
        on: true, B: p.B, units: p.units, T: p.T, Tfrom: p.Tfrom, N: p.N, Nstar: p.Nstar,
        R: p.R.toFixed(2), asl: (p.T / Math.max(1, p.Nstar)).toFixed(1),
        lo: p.secPerBeat[0], hi: p.secPerBeat[1]
      }
    },
    mergeAll() { return mergeWarnings(this.shots) },
    /**
     * 「本集配时」注入块（双轨配时第 2 步 · md 层，2026-10-13）：把程序算好的 T / B / 建议镜数
     * 渲染成一小段文字，塞进分镜提示词的素材格式（shots-story.md 的 {{pacingBlock}}）。
     * 🔴 为什么由程序算、不让模型自己数：`N* = clamp(⌈B÷每镜单元数⌉, ⌈T÷15⌉, ⌊T÷4⌋)` 是纯算术，
     *    而模型不做算术（基座里同款时长公式与算例，实测 10 个样本一次都没执行过）。程序算死、
     *    模型照做 —— 与「时长不采信模型填的数」同一个哲学。
     * 返回 '' 时占位符所在整段会被 fillTemplate 整块跳过（见 h3.md 的「空值整块跳过」语义），
     * 所以广告体裁（没声明 limits.pacing）与剧集未填目标时长时，提示词里不会留下悬空的一句话。
     */
    pacingBrief() {
      if (!(this.limits && this.limits.pacing)) return ''
      const p = pacingPlan({ adapted: this.adapted, shots: this.shots, targetSec: this.targetSec, limits: this.limits })
      if (!p.B) return ''                       // 数不出画面单元（没声明 beatUnit）→ 不给数字，免得它拿 0 去算
      if (!p.ok) {                              // 目标时长没声明（T = 0）→ 仍把 B 给它，让它按单元配镜
        return '· 本集**未声明目标时长**（项目配置里填「单集目标时长」即可启用配时）。\n' +
          '· 改编稿画面单元数 B = ' + p.B + ' 个 → **镜头数就取 ' + p.B + ' 个**（一个画面单元一个镜头）。\n' +
          '· 每镜 dur 按基座的时长规则由内容定（4-15 秒），不要为了凑总时长把某一镜拉长。'
      }
      const N = p.Nstar
      const lo = Math.ceil(p.T / 15)            // 单镜上限 15 秒 → 至少这么多镜才装得下 T
      const hi = Math.floor(p.T / 4)            // 单镜下限 4 秒 → 至多这么多镜才塞得进内容
      const per = (p.T / Math.max(1, N)).toFixed(1)
      const from = p.Tfrom === 'script' ? '（取自剧本稿自带的「时长：」合计）' : '（项目配置 · 单集目标时长）'
      return '· 本集目标时长 T = ' + p.T + ' 秒' + from + '\n' +
        '· 改编稿画面单元数 B = ' + p.B + ' 个（' + p.units + ' 个场次/段落）\n' +
        '· **建议镜头数 N = ' + N + ' 个** —— 必须落在 ' + lo + ' ~ ' + hi + ' 之间（少于 ' + lo + ' 装不下 T，多于 ' + hi + ' 塞不进内容）\n' +
        '· 平均每镜 ' + p.T + ' ÷ ' + N + ' ≈ ' + per + ' 秒（每镜仍须落在 4-15 秒；程序生成后会按 T 重配每个镜头的秒数，你写的 dur 只是节奏参考）\n' +
        '· 总时长自检：所有镜头 dur 之和要贴住 ' + p.T + ' 秒。不够时的正确动作是「让某个画面单元单独成一镜」，**不是**「把每个镜头都拉长」'
    },
    /** 场景档案体检（缺档案 / 空档案 / 挂错名字）→ 「场景名 → 黄标文案」，一次算全表供各行查用 */
    scIssues() {
      const ep = this.st.current
      return sceneCardIssues(this.shots, (ep && ep.scenes) || [])
    },
    /**
     * 场景三方一致性（2026-10-10）：改编稿 §三 声明 → scenes.json 落地 → shots[].scene 引用。
     * 现有护栏（sceneAlign / sceneCardIssues / scIssues）全是「分镜 → 档案」单向，
     * 「改编稿声明了什么」这条上游信息以前完全不参与比对 —— 所以三次事故（V9X-4 座舱·内丢失、
     * 溪畔新绿孤儿档案、H10 四季塌缩成一条）都是程序绿灯、用户先发现。这里补上这一环。
     * 解析不到 §三（剧集体裁走 adapt.md）→ 恒 ok，不会误报。
     */
    sceneDeclInfo() {
      const ep = this.st.current
      return sceneDeclIssues(this.adapted, (ep && ep.scenes) || [], this.shots)
    },
    /** 待合并预览（askMerge = 后镜下标 i，即合并 i 与 i+1... 实际存的是「后镜下标」，合并 i-1 与 i） */
    mergePreview() {
      const i = this.askMerge
      if (i === null || !this.shots[i] || !this.shots[i - 1]) return null
      return mergeShotPair(this.shots[i - 1], this.shots[i])
    },
    allConfirmed() {
      return this.shots.length > 0 && this.shots.every((_, i) => this.vstate[i] && this.vstate[i].confirmed)
    },
    /**
     * 🔴 分镜总时长（2026-10-13，Dragon）：所有镜头 dur 之和，实时跟随编辑 / 拆分 / 合并 / 增删。
     *  显示在 App.vue「分镜脚本」模块标题后面（落点 `#shots-total`，同 tpReady Teleport 机制）。
     *  🔴 口径必须与 `shotCheck` 的 `total` **逐字一致**（`Number(s.dur) || 0` 累加）——
     *     两处若用不同口径（一个夹取 4~15、一个不夹），同一屏上会给出两个不一样的「总时长」。
     *  🔴 必须在 computed 里、模板**不带括号**取值。若写成 methods 而模板写 `{{ totalDur }}`，
     *     Vue 会把方法 bind 到实例上，渲染出来是 `function () { [native code] }` —— 2026-10-13 实机踩到，已纠正。
     */
    totalDur() { return this.shots.reduce((a, s) => a + (Number((s || {}).dur) || 0), 0) }
  },
  watch: {
    'st.current'(ep) {
      // 生成在跑时切了集：自动请求停止（当前子任务跑完即停，剩余丢弃）；
      // 并把 _busyEpId 置哨兵，让在途子任务的收尾写库被守卫丢弃——否则旧集数据会写进新集
      if (this.batchP || this.batchV || this.pBusy || this.vBusy) {
        this.batchPStop = this.batchVStop = true
        this._busyEpId = 'SWITCHED'
        this.$root.toast('已切换剧集：当前镜头完成后批量停止，剩余任务丢弃')
      }
      if (ep) { this.initAll(ep); this.refreshAsig() }
    },
    // 别块（角色&场景的「一键填充」）写过 prompts 工件 → 用最新工件重建本块表单，
    // 否则本块的本地副本会在下次保存时把那次填充覆盖回去（同引用，watch('st.current') 不触发）
    'st.current.promptsSyncAt'() {
      if (this.st.current && !this.pBusy) this.initPrompts(this.st.current)
      // 参考素材被别块改过（角色&场景的「按装扮填镜头」「一键填充」）→ 指纹也要跟着更新
      this.refreshAsig()
    },
    // 别块（角色&场景的「写入镜头」/「切换变体」改名）写过 shots 工件 → 按最新工件重建分镜列表，
    // 否则本块的本地副本会在下次保存时把那次改动覆盖回去（同引用，watch('st.current') 不触发）
    'st.current.shotsSyncAt'() { if (this.st.current && !this.pBusy && !this.vBusy && !this.batchP && !this.batchV) this.initShots(this.st.current) },
    /** 卡片图重出 / 素材归档过（mediaSyncAt）→ 被引用的文件可能已经换了内容，指纹重取 */
    'st.current.mediaSyncAt'() { this.refreshAsig() },
    'shots.length'() { /* 分镜数量变化时同步提示词/视频槽位（保持每行三区对齐） */ this.syncSlots() },
    // 第 2 块点「生成分镜」进来 → 不需要任何操作直接开始生成
    'pl.autoShots'(v) { if (v) { this.pl.autoShots = false; this.tryAutoShots() } },
    'pl.active'(v) {
      // 进入提示词阶段：自动开始生成（只补空的镜头，不覆盖已有内容）
      if (v === 4 && !this.pl.done[4]) {
        const ep = this.st.current
        if (!ep) return
        // 先按最新分镜重建表单：各阶段组件在打开剧集时就全挂载了，那时分镜还不存在，
        // 不重建会拿空列表去生成（下游索引越界）
        this.initPrompts(ep)
        if (!this.shots.length || this._autoEp === ep.id) return
        this._autoEp = ep.id
        this.$root.toast('已自动开始生成提示词（逐镜头进行，可随时在标题行点「停止批量」）')
        this.runBatchP(false)
      }
      // 进入视频阶段：按最新分镜重建每镜头的状态槽
      if (v === 5 && !this.vBusy && this.st.current) this.initVideos(this.st.current)
    }
  },
  created() {
    if (this.st.current) this.initAll(this.st.current)
    // 组件可能晚于标记置位才挂载（换集重挂载）：挂载时兜底检查一次
    if (this.pl.autoShots) { this.pl.autoShots = false; this.tryAutoShots() }
  },
  /** 🔴 批量按钮的 Teleport 延迟挂载：mounted 后 DOM 才真正插入文档，#shots-batch 此时才可被 querySelector 命中 */
  mounted() {
    this.$nextTick(() => { this.tpReady = true })
    // 素材指纹：进页面取一次；窗口重新获得焦点时再取一次 —— 用户最常见的「手工换图」
    // 就是在资源管理器里把图覆盖掉、再切回软件，这一下正好把新指纹收进来（否则要等别处的同步事件）
    this.refreshAsig()
    this._onFocus = () => { this.refreshAsig() }
    window.addEventListener('focus', this._onFocus)
  },
  /** 卸载时立刻释放视频 base64，避免常驻内存（视频是重内存块） */
  beforeUnmount() {
    this._b64 = {}; this._refv = {}
    if (this._onFocus) { window.removeEventListener('focus', this._onFocus); this._onFocus = null }
  },
  methods: {
    clampDur,   // 模板里 @change 夹取用
    resLabel,
    /* ================= 初始化 ================= */
    initAll(ep) {
      this.initShots(ep)
      this.initPrompts(ep)
      this.initVideos(ep)
      this.targetSec = this.projTargetSec     // 单集目标时长（项目级，双轨配时的输入）
      this.loadLimits()
    },
    /** 读当前体裁声明的分镜自检参数（广告 = 段落数 × 1.5 / 时长 ±20%；剧集 = pacing 双轨配时）。
     *  风格包在 prompts.js 里按「项目|风格」缓存，所以这里每次切集调一次很便宜。 */
    async loadLimits() {
      try { this.limits = (await currentStyleLimits(this.epProjectId)) || {} }
      catch (_) { this.limits = {} }
    },
    /** 落库单集目标时长（项目级）。0 = 不启用；只写这一个字段，不做整树刷新（免得扰动正在编辑的分镜）。 */
    async saveTarget() {
      const pid = this.epProjectId
      if (!pid) return
      const v = Math.max(0, Math.min(1800, Math.round(Number(this.targetSec) || 0)))
      this.targetSec = v
      await this.st.setProjectTargetSec(pid, v)
      this.$root.toast(v ? ('已设置单集目标时长 ' + v + ' 秒 —— 生成分镜时镜数由它推导') : '已关闭目标时长（镜数回到由内容决定）')
    },
    initShots(ep) {
      this.shots = JSON.parse(JSON.stringify(ep.shots || []))
      // 2026-09-23：本块不再展示档案产出条数提示行，
      // 故不再在本地保存一份档案副本（明细只在「角色 & 场景」块维护）
    },
    /** 分镜数量变化时，同步提示词与视频槽位（补齐/裁掉，保证每行三区都有内容） */
    syncSlots() {
      const ep = this.st.current
      if (!ep) return
      while (this.prompts.length < this.shots.length) this.prompts.push({ text: '', refs: emptyRefs() })
      if (this.prompts.length > this.shots.length) this.prompts.length = this.shots.length
      ep.shots.forEach((_, i) => {
        if (!this.vstate[i]) this.vstate[i] = { files: [], cur: -1, confirmed: false, res: (ep.res && ep.res.vid) || '864x480' }
      })
    },
    /* ================= 分镜（原阶段3） ================= */
    /** 自动生成分镜入口：改编稿非空才触发（守卫防误跑） */
    tryAutoShots() {
      if (this.busy || !this.adapted.trim()) return
      this.generate()
    },
    addRow() {
      this.shots.push({ scene: '', chars: '', action: '', dialogue: '', camera: '中景', dur: 8, continuity: '', change: '' })
    },
    /** 项目里已存在的角色/场景名（项目级资产目录 + 本集档案），让 LLM 跨集沿用同名同设定 */
    async knownNames() {
      const chars = new Map(), scenes = new Set()   // chars: 名字 -> profile（跨集防撞脸用）
      const ep = this.st.current || {}
      const addChar = c => { if (c && c.name && !chars.has(c.name)) chars.set(c.name, String(c.profile || '')) }
      for (const c of ep.chars || []) addChar(c)
      for (const s of ep.scenes || []) if (s && s.name) scenes.add(s.name)
      // 项目库（跨集共享）：库条目自带档案。2026-09-27 rev21：外观摘要一并下发（knownBrief），
      // 新集建新角色时模型才知道已有角色长什么样，才能按 profile.md 设计自由区错开（防全员同一张脸）
      try { await this.st.loadLibrary(ep.projectId) } catch (_) {}
      for (const e of this.st.libEntries(ep.projectId)) {
        if (!e || !e.name) continue
        if (e.kind === 'scene') scenes.add(e.name)
        else addChar(e)
      }
      try {
        const r = await window.studio.projectAssets(this.st.workspace, ep.projectId)
        for (const g of (r && r.characters) || []) if (g && g.name && !chars.has(g.name)) chars.set(g.name, '')
        for (const g of (r && r.scenes) || []) if (g && g.name) scenes.add(g.name)
      } catch (_) { /* 拿不到资产目录就用本集档案 */ }
      const briefs = [...chars].map(([name, profile]) => ({ name, profile }))
      return { chars: [...chars.keys()], scenes: [...scenes], briefs }
    },
    async generate() {
      this.busy = true
      const t0 = Date.now()
      this.pl.beginGen(2)
      const L = stepLog('阶段3 分镜脚本')
      L.start('正在生成分镜：LLM 按改编稿拆分镜头并产出角色/场景档案（改编稿 ' + this.adapted.length + ' 字）')
      try {
        const system = await composeSystem({
          specs: ['shots.md', 'profile.md', 'chars.md', 'scenes.md'],
          mustHave: ['"shots"', '"characters"', '"scenes"'],
          task: 'shots'
        })
        // 「整部作品的综合信息」：除本集剧本稿外，带上项目里已存在的角色/场景名（跨集共享，要求沿用）。
        // user 消息的文案同样来自规范 md（shots.md 的「## 素材格式」），这里只提供素材本身
        const known = await this.knownNames()
        const user = await composeUser('shots.md', {
          script: this.adapted,
          knownChars: known.chars.join('、'),
          knownBrief: profileBrief(known.briefs, null, 16),
          knownScenes: known.scenes.join('、'),
          // 双轨配时（2026-10-13）：节目单要铺多长 → 该给几个镜头。算式在程序里算死，
          // 模型只负责「把镜头切在该切的地方」。剧集专属（shots-story.md 的 {{pacingBlock}} 位），
          // 广告体裁返回 '' → fillTemplate 整段跳过，基座 shots.md 里没有这个占位符，零影响。
          pacingBlock: this.pacingBrief
        })
        dbgPrompt('阶段3 分镜脚本', '文字模型', [['system', system], ['user', user]])
        // thinking:'low' —— **只对云端生效**（本地支路只认严格 true，见 inference.cjs）。
        // 分镜是唯一实测有增益的环节（镜头数 15→21、跨镜变化点 2→4、画面主体组合 4→7）；
        // 代价是云端首字要等 ~60s。其余环节开思考收益不可验证，保持关。
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.5, maxTokens: 12288, json: true, stage: 'shots', providerOverride: overrideOf('shots'), label: '阶段3 分镜脚本', thinking: 'low' })
        const parsed = JSON.parse(require_json(text))
        const used = new Set()
        const shots = pickArr(parsed, ['shots', '镜头', '镜头列表'], used)
        if (!shots || !shots.length) throw new Error('LLM 未返回镜头数组')
        const chars = pickArr(parsed, ['characters', 'chars', '角色档案', '角色'], used) || []
        const scenes = pickArr(parsed, ['scenes', '场景档案', '场景'], used) || []
        // 🔴 解析后形状校验（2026-10-08）：JSON 语法合法 ≠ 结构没坏。素材里的半角引号会让值提前
        //    闭合、后半段变成数组里的裸字符串碎片 —— 那种「合法但残废」的输出在旧代码里会被
        //    normArchive 的宽容分支照单全收。这里按命名契约拦一次，宁可不落盘。
        auditModelArchive(chars, '角色档案')
        auditModelArchive(scenes, '场景档案')

        // 镜头：场景名兜底（模型仍写"同上"就替换为上一镜头的场景名）+ 时长按内容重算 + 超限镜头拆分
        // 🔴 时长不采信模型填的数：它不做算术（shots.md 里给了同款公式和算例，实测 10 样本一次没执行过），
        //    只会按「一个镜头 5~8 秒好看」的节奏瞎填 → 台词念不完、界面满屏时长警告。
        //    这里直接写成程序算出的内容所需秒数（durFit，封顶 15s）；durFit=0（无台词/无发声/非复合运镜）
        //    表示内容对时长无约束，保留模型给的节奏值。
        //    内容真超过单镜上限的镜头紧接着由 splitAll 拆开（dur 拉满也念不完，只能拆，见 promptlib.splitShot）。
        //    生成之后的编辑仍按原设计：手改优先，程序只提示不覆盖。
        let prev = ''
        let durFixed = 0
        this.shots = shots.map(s => {
          const scene = fixSceneName(s.scene, prev)
          prev = scene
          const fit = durFit(s)
          const modeled = clampDur(s.dur)
          const dur = fit > 0 ? clampDur(fit) : modeled
          if (dur !== modeled) durFixed++
          return {
            scene, chars: s.chars || '', action: s.action || '',
            dialogue: s.dialogue || '', camera: s.camera || '', dur,
            continuity: String(s.continuity || '').trim(), change: String(s.change || '').trim()
          }
        })
        // 第 2 批：内容超过单镜生成上限的镜头按台词边界拆开。程序全权执行、立即出结果，不依赖 LLM；
        // 拆出来的段带「✂ 程序拆分」黄标（画面是程序按标点粗切的），用户可再点「AI 重写」让模型补写画面。
        const sp = splitAll(this.shots)
        this.shots = sp.shots

        // 🔴 时长容量闭环（2026-10-12）：**镜头数装不下脚本声明时长**时按段落秒数补镜。
        //    与 splitAll 是两件事：splitAll 治「单个镜头内容太多」（台词念不完），
        //    这里治「全片/单段时长装不下」（N×15 < T，或某段 20s 却只分到 1 条镜头）。
        //    为什么必须程序做：fitDurs 只能把 T 摊到**已有**镜头上，装不下时它会静默丢弃余量
        //    （V9X-4 实测：6 镜 × 15s = 90s vs 脚本 105s，丢 15s，而三条既有校验全部放行）。
        //    补出来的段同样带「✂ 程序拆分」标记 —— 撤回拆分 / AI 重写 走的是同一套（不需要新入口）。
        //    ⚠️ 必须在 saveArtifact('shots') 之前，否则补出来的镜头落不了盘。
        await this.loadLimits()
        const fc = fitShotCount(this.shots, this.adapted, this.limits, this.targetSec)
        if (fc.added) this.shots = fc.shots

        // 🔴 2026-10-09（Dragon）：**总时长贴回脚本各段秒数**。durFit 只管「这一镜念不念得完」，
        //    管不住全片总长 —— 单镜 dur 要按脚本段落秒数分摊。道理：脚本写「段落 1：12 秒」，
        //    全片就该是那些秒数之和（±20%），而不是模型按「5~8 秒好看」填出来的 12 镜 / 53 秒
        //    （脚本只有 28 秒）。下界永远是内容所需（台词 / 发声 / 复合运镜），所以贴回脚本
        //    不会把声音挤掉；只对**写了段落时长**的体裁生效（广告改编稿每段都有「时长：N 秒」，
        //    剧集改编稿没有 → 这里直接跳过，一个字节不动）。
        const units0 = storyUnits(this.adapted)
        if (units0.hasSec) {
          const fit = fitDurs(this.shots, units0.totalSec)
          this.shots = fit.shots
          if (fit.changed) {
            L.info('镜头时长已贴回脚本各段秒数：脚本 ' + units0.totalSec + 's 分摊到 ' + this.shots.length +
              ' 个镜头（改动 ' + fit.changed + ' 个，下界仍是内容所需时长）')
          }
        }

        // 🔴 场景档案整体缺失 = 本次结果作废（2026-10-08）：shots.md 的契约要求 `scenes[]` 与
        //    `shots[].scene` 一一对应。**空数组**不像拼写差异那样能被 sceneAlign 回填 ——
        //    后果是本集每张场景卡都没有档案，生图直接退化成通用空镜（V9X-2 就是 6 张空档案卡）。
        //    旧代码 `pickArr(...) || []` 静默接受空数组，于是「模型没干活」被当成正常结果落了盘。
        //    这里当场报错（还没落盘），让用户立刻重生成，而不是事后才发现整集画面全是空镜。
        const usedScenes = [...new Set(this.shots.map(s => s.scene).filter(n => n && n !== '未命名场景'))]
        if (!scenes.length && usedScenes.length) {
          throw new Error('模型没有返回任何场景档案（scenes 为空），但分镜用到了 ' + usedScenes.length +
            ' 个场景（' + usedScenes.slice(0, 3).join('、') + (usedScenes.length > 3 ? '…' : '') +
            '）—— 本次结果已放弃，请重新生成。若反复出现，先检查改编稿里是否混进了半角引号（"）或 JSON 示例文本。')
        }

        // 🔴 重新生成分镜 = 从零开始（2026-10-07；2026-10-09 收紧为「下游全部清空」）：
        //    本次结果就是**唯一事实来源** —— 旧档案一律不留（同名的也按本次内容重建、已出的图归零），
        //    只有用户自己造的条目豁免：手动新增的卡（_manual）与从项目库导入的只读副本卡。
        //    旧档案先做快照：下面的 saveArtifact 会把 st.current 换成新的，不能再拿它当「旧值」。
        const prevChars = JSON.parse(JSON.stringify(this.st.current.chars || []))
        const prevScenes = JSON.parse(JSON.stringify(this.st.current.scenes || []))
        const chars2 = buildArchive(normArchive(chars, 'character'), prevChars)
        // 人物名对齐（2026-09-27）：改编稿给同一人写两种名字（「人名（主角）」/「人名」）时，
        // 镜头侧剥掉定位标签、向角色卡名对齐（卡名是图片目录的 key，绝不能动卡名）；
        // 卡侧撞键（剥标签后同键的多张卡，可能是两个不同的人）绝不自动归并，只黄标。
        const charAligned = charAlign(this.shots, chars2)
        if (charAligned.fixes.length || charAligned.warnings.length) this.shots = charAligned.shots
        // 场景档案名先对齐镜头里的拼法（模型偶把同一场景写成两种拼法 → 档案挂在没人用的名字上，
        // 镜头真正在用的那张卡档案为空 → 生图退化成通用空镜。见 promptlib.sceneAlign）
        const aligned = sceneAlign(this.shots, normArchive(scenes, 'scene'))
        const scenes2 = buildArchive(aligned.scenes, prevScenes)
        const audit = sceneCardIssues(this.shots, scenes2)
        // 场景三方一致性（2026-10-10）：改编稿 §三 声明的档案名 ↔ 本次落地的 scenes2 ↔ 镜头引用。
        // 这次比对此前完全缺失 —— V9X-4「座舱·内」丢失、H10「四季并成一条」都是它才能抓出来的。
        // 只报警不拦截（与 auditScene 同档）：档案结构问题不该阻止分镜落库，但必须让用户当场看见。
        const decl = sceneDeclIssues(this.adapted, scenes2, this.shots)
        if (decl.issues.length) {
          L.warn('场景三方不一致：' + decl.issues.map(x => x.text).join('；') +
            '（改编稿 §三 声明 ' + decl.declared.length + ' 条 · 落地 ' + decl.landed.length +
            ' 条 · 镜头用到 ' + decl.used.length + ' 个名字）')
        }

        await this.st.saveArtifact('shots', this.shots)
        await this.st.saveArtifact('chars', chars2)
        await this.st.saveArtifact('scenes', scenes2)
        // 🔴 提示词与视频槽位跟着一起重建（2026-10-07）：老逻辑只按**数量**补齐/裁掉，
        //    重新生成后镜头数恰好相同（很常见）时，旧提示词/旧视频会原样挂在**内容完全不同**的
        //    新镜头上 —— 那不是「残留」，是错配。分镜既然是从零来的，槽位也归零。
        this.prompts = this.shots.map(() => ({ text: '', refs: emptyRefs() }))
        this.vstate = {}
        // 🔴 2026-10-09（Dragon）：重新生成分镜 = **下游全部清空**，一切从头再来。
        //    旧逻辑只归档「新分镜里没提到的」角色/场景（同名的连图一起留），而且下游**磁盘上的**
        //    镜头视频 / 首帧图 / 成片一个都没动 —— 用户点完发现左侧树与成片格里旧东西还在。
        //    现在一次归档三样（共用同一个 _trash/<时间戳>/，翻起来只有一个文件夹）：
        //      ① 本集旧卡片的图目录（同名也归档 → 卡片图归零，重新出图）
        //      ② <项目>/分镜/<集名>_shot_N*.mp4 与 <集名>_shot_N_first.png
        //      ③ <项目>/成片/<集名>_<时间戳>.mp4（+ 隐藏封面）
        //    都是**移动**不是删除（图与视频是花显卡时间出的，得能找回）。
        //    有没有图由后端按「目录是否存在」判断 —— 别用 candidates 猜，历史数据里它可能是空的面盘上还有图。
        const orphan = orphanAssets({ chars: prevChars, scenes: prevScenes })
        L.info('重新生成分镜：下游全部清空 —— 本集旧的 ' + prevChars.length + ' 个角色 / ' +
          prevScenes.length + ' 个场景档案与卡片重建，镜头视频、首帧图、成片一并归档')
        try {
          const r = await window.studio.archiveEpisodeOutputs(this.st.workspace, this.st.current.id, orphan)
          const mv = (r && r.moved) || []
          if (mv.length) L.info('已归档到 _trash/（未删除，可找回，共 ' + mv.length + ' 项）：' + mv.join('、'))
          else L.info('没有需要归档的旧素材（本集还没有出过图 / 生成过视频）')
          for (const f of ((r && r.failed) || [])) L.warn('归档失败：' + f)
        } catch (e) { L.warn('归档失败：' + ((e && e.message) || e)) }
        // 本集的镜头视频与成片文件已经搬走 → 让成片块重扫目录（否则成片格还挂着旧成片）、
        // 左侧树「分镜 / 成片」节点重拉计数。mediaSyncAt 是这条跨块信号的载体（同 promptsSyncAt 手法）。
        const pid = this.st.current.projectId
        this.st.current.mediaSyncAt = Date.now()
        this.st.invalidateMedia(pid, 'shots')
        this.st.invalidateMedia(pid, 'films')
        // 下游各阶段「已完成」不再成立 → done 归零（不清会出现「确认了角色&场景却不自动生成提示词」）
        this.pl.wipeFrom(2, this.st.current.id)
        // 记录「本次分镜/档案基于哪个改编稿版本」→ 改编稿再改就触发模块级脏标记
        await touchRevs(this.st, r => { r.shotsAdapted = r.adapted || 0 })
        this.syncSlots()
        await this.savePrompts()
        await this.saveVideos()
        this.pl.markGen(2, Date.now() - t0)
        const warnN = Object.keys(audit.byName).length
        if (durFixed) L.info('镜头时长已按内容重算：' + durFixed + ' 个镜头（取程序算出的内容所需秒数，模型填的秒数不作数）')
        if (sp.groups.length) {
          L.info('内容超单镜上限的镜头已按台词边界拆分：' + sp.groups.length + ' 个镜头 → ' +
            sp.groups.reduce((a, g) => a + g.n, 0) + ' 段（' +
            sp.groups.map(g => '第 ' + (g.at + 1) + ' 镜拆成 ' + g.n + ' 段').join('；') +
            '）。拆出的画面是程序按标点粗切的，可在行内点「AI 重写」让模型补写')
        }
        if (fc.groups.length) {
          L.info('时长容量补齐：脚本声明 ' + (fc.totalSec || '') + ' 秒，' + (fc.shots.length - fc.added) +
            ' 个镜头装不下 → 按各段落声明秒数补了 ' + fc.added + ' 镜（' +
            fc.groups.map(g => '第 ' + g.seg + ' 段拆成 ' + g.n + ' 条').join('；') + '），现共 ' +
            fc.shots.length + ' 镜（逐个镜头的秒数已按段落秒数贴回）。补出的画面同样是程序粗切的，可点「AI 重写」补写')
        }
        if (charAligned.fixes.length) {
          L.info('镜头人物名已向角色卡对齐（剥掉定位标签）：' + charAligned.fixes.map(f => f.from + ' → ' + f.to).join('；'))
        }
        for (const w of charAligned.warnings) L.warn(w)
        if (aligned.moves.length) {
          L.info('场景档案名已对齐到镜头里的写法：' + aligned.moves.map(m => m.from + ' → ' + m.to).join('；'))
        }
        if (warnN) {
          L.warn('场景档案有 ' + warnN + ' 处待补：' + Object.keys(audit.byName).join('、') + '（角色与场景块里有黄标）')
        }
        L.done('分镜生成完成：' + this.shots.length + ' 个镜头 · 角色档案 ' + chars2.length +
          ' 个 · 场景档案 ' + scenes2.length + ' 个', Date.now() - t0)
        this.$root.toast('已生成 ' + this.shots.length + ' 个镜头、' + chars2.length + ' 个角色、' + scenes2.length + ' 个场景' +
          (sp.groups.length ? '；' + sp.groups.length + ' 个超长镜头已自动拆分（画面可在行内点「AI 重写」补写）' : '') +
          (fc.groups.length ? '；为装下脚本 ' + fc.totalSec + 's 已自动补 ' + fc.added + ' 镜' : '') +
          (warnN ? '；有 ' + warnN + ' 个场景档案缺失，已打黄标' : '') + '，请检查编辑后确认')

        // 🔴 2026-10-09（Dragon）：生成后的**自检 → 自动合并**。
        //    「镜头量 ≤ 段落数 × 1.5」「总时长 = 脚本各段合计 ±20%」这两条一直写在 shots-ad.md 里，
        //    可规范是给模型看的、**程序侧此前零校验** —— V9X-4 实测 4 段落 / 脚本 30 秒却出 12 镜 / 53 秒。
        //    上限来自**体裁声明**（this.limits ← genre json 的 limits）：剧集体裁没有声明，
        //    这里就恒不触发（剧集的镜头量按字数算，拿段落数去卡只会刷假警报）。
        //    🔴 2026-10-09（Dragon）：超限**直接自动合并**，不再弹窗问用户「要不要合并」——
        //    合并判据与行内黄标同源、被并掉的镜只是槽位记录清空（磁盘文件仍在）、合并镜带 _rev 脏标
        //    （提示词/视频自动标过期），没有信息损失，没必要打断用户。
        //    一轮贪心可能留下新的相邻可合并对（A|B|C 里 A-B、B-C 都满足时只合掉一处）→ 循环 ≤3 轮；
        //    确实合不动了才留在自检横幅上提醒（横幅带手动补合按钮）。
        await this.loadLimits()
        let chk = this.shotCheckInfo
        // 🔴 只有「镜头数超限」才走自动合并（合并是**减法**）；时长容量类问题（装不下）恰恰要**加法**，
        //    拿它触发合并只会雪上加霜 —— 那类问题已在落盘前由 fitShotCount 补镜处理，这里只如实报告。
        if (chk.issues.some(x => x.kind === 'units')) {
          const why0 = chk.issues.map(x => x.text).join('；')
          L.warn('分镜自检不通过：' + why0 + '（上限见当前体裁的分镜规范「镜头量」一节；程序按行内同一套判据自动合并）')
          const beforeN = this.shots.length
          let rounds = 0, durN = 0
          while (rounds < 3 && this.mergePlan.count) {
            const r = await this.mergeShotsAll({ auto: true })
            if (!r) break
            durN += r.durChanged || 0
            rounds++
            if (!this.shotCheckInfo.issues.length) break
          }
          chk = this.shotCheckInfo
          if (rounds) {
            L.info('已自动合并 ' + rounds + ' 轮：镜头 ' + beforeN + ' → ' + this.shots.length +
              ' 个 · 总时长 ' + chk.total + 's' + (durN ? '（' + durN + ' 个镜头时长已贴回脚本）' : ''))
          }
          if (chk.issues.length) {
            const why1 = chk.issues.map(x => x.text).join('；')
            L.warn('自动合并后仍未达标：' + why1)
            this.$root.toast('⚠ 分镜自检：' + why1 +
              (rounds ? '（已自动合并 ' + beforeN + ' → ' + this.shots.length + ' 镜仍超限）' : '（没有可直接合并的相邻镜头）') +
              '，请手动检查每镜内容')
          } else if (rounds) {
            L.done('分镜自检通过：' + this.shots.length + ' 镜 / ' + chk.total + 's（自动合并 ' + rounds + ' 轮）')
            this.$root.toast('分镜已自动合并：' + beforeN + ' → ' + this.shots.length + ' 个镜头 · ' + chk.total + 's（自检通过；合并后的镜头提示词已标过期）')
          }
        } else if (chk.issues.length) {
          // 时长容量类（全片装不下 / 逐段不齐 / 脚本超体裁容量）：补镜已在落盘前由 fitShotCount 做过，
          // 这里只如实报告 —— 合并是减法，对这类问题只会更糟，所以绝不去合并。
          const why = chk.issues.map(x => x.text).join('；')
          L.warn('分镜自检不通过：' + why)
          this.$root.toast('⚠ 分镜自检：' + why)
        }
      } catch (e) {
        L.fail('分镜生成失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.busy = false; this.pl.endGen(2) }
    },
    async confirmShots() {
      // 确认前再兜底夹取一次（4~15s 含边界），确保下游视频生成的秒数永远合法
      this.shots.forEach(s => { s.dur = clampDur(s.dur) })
      await this.st.saveArtifact('shots', this.shots)
      this.pl.confirm(2, this.st.current.id)
      this.$root.toast('分镜已确认，共 ' + this.shots.length + ' 镜')
    },
    /* ---- 分镜编辑（脏标记数据源） ---- */
    /** 落库守卫：生成在跑时切了集（_busyEpId = 'SWITCHED'）→ 在途子任务的收尾写库直接丢弃，
     *  防止旧集的 shots/prompts/videoState 被写进新切换的集（st.saveArtifact 写的是 this.current.id） */
    canSave() {
      return !(this._busyEpId && this.st.current && this._busyEpId !== this.st.current.id)
    },
    async saveShots() {
      if (!this.canSave()) return
      await this.st.saveArtifact('shots', JSON.parse(JSON.stringify(this.shots)))
    },
    /** 分镜字段被编辑：镜头版本 +1（本行提示词的脏标记依据）并立即落库 */
    async touchShot(s) {
      s._rev = (s._rev || 1) + 1
      await this.saveShots()
    },
    askDelShot(i) {
      if (!window.confirm('删除镜头 ' + (i + 1) + '？该镜头的分镜、提示词与视频记录将一并移除（已生成的视频文件仍在磁盘）。')) return
      this.delShot(i)
    },
    async delShot(i) {
      this.shots.splice(i, 1)
      this.prompts.splice(i, 1)
      // vstate 以镜头下标为 key：删除后整体前移补位
      const vs = {}
      Object.keys(this.vstate).map(Number).sort((a, b) => a - b).forEach(k => {
        if (k === i) return
        vs[k > i ? k - 1 : k] = this.vstate[k]
      })
      this.vstate = vs
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      this.$root.toast('已删除镜头，后续镜头已前移')
    },
    /* ================= H3 提示词（原阶段5） ================= */
    initPrompts(ep) {
      const shots = ep.shots || []
      let changed = false
      if (ep.prompts && ep.prompts.length) {
        this.prompts = JSON.parse(JSON.stringify(ep.prompts))
      } else {
        this.prompts = shots.map(() => ({ text: '', refs: emptyRefs() }))
        changed = true
      }
      // 分镜数量变了（重新生成分镜）：补齐/裁掉多余，保证每个镜头都有提示词槽
      while (this.prompts.length < shots.length) { this.prompts.push({ text: '', refs: emptyRefs() }); changed = true }
      if (this.prompts.length > shots.length) { this.prompts.length = shots.length; changed = true }
      // 老数据没有 refs 字段要补；_gen/_genAt 是运行时字段，绝不能从库里读回来（否则永远转圈）
      this.prompts.forEach(p => {
        if (!p.refs) { p.refs = emptyRefs(); changed = true }
        if (p._gen || p._genAt) { delete p._gen; delete p._genAt; changed = true }
      })
      if (changed) this.savePrompts()
    },
    /** 卡片上的耗时文案：生成中实时计时 / 完成后显示本次耗时 */
    genTextP(i) {
      void this.live
      const p = this.prompts[i]
      if (!p) return ''
      if (p._genAt) return '生成中 已用 ' + fmtMs(Date.now() - p._genAt)
      return p.genMs ? '耗时 ' + fmtMs(p.genMs) : ''
    },
    /**
     * 角色 + 场景档案（阶段3 产出的设定，作为提示词的固定外观依据）。
     * 🔴 2026-10-08：改为**按主体归组**下发（groupProfiles，见 src/variant.js）——
     *    `主体名--视角` 这类视角变体卡共用主体卡那一份档案，只发一行；键用**主体名**（不是卡名），
     *    因为分镜的 chars / continuity 里写的就是主体名，两边对不上模型会当成两个主体。
     *    没有双横杠命名时，输出与改造前逐字一致（每张卡各一行）。
     */
    charProfiles() {
      return groupProfiles(this.chars)
    },
    sceneProfiles() {
      return groupProfiles(this.scenes)
    },
    /** 本镜 `chars` 里的角色名集合（顿号分隔）。`主体名--视角` 的变体卡在 groupProfiles 里按**主体名**归组，
     *  所以这里存的是主体名，下面匹配时也用 baseOf(c.name)。 */
    shotCharNames(s) {
      const out = new Set()
      for (const n of String((s && s.chars) || '').split(/[、,，/]/).map(x => x.trim()).filter(Boolean)) out.add(n)
      return out
    },
    /** 本镜「画面里出现的主体」= chars 里的角色 + 本镜场景名（参考素材过滤用） */
    shotSubjects(s) {
      const out = this.shotCharNames(s)
      const sc = String((s && s.scene) || '').trim()
      if (sc) out.add(sc)
      return out
    },
    /**
     * 下发给视频提示词模型的**角色档案块**（配套 shots.md rev25）。
     * 🔴 2026-10-14（用户拍板）：只发**本镜画面里出现**的角色 —— `chars` 里没写的角色，
     *    即使这一镜挂了它的参考图，档案也不下发。
     *    `chars` 为空（LLM 没写 / 老数据）→ 不过滤，保持老行为（宁可多发，不可漏发）。
     */
    charProfilesFor(s) {
      const names = this.shotCharNames(s)
      if (!names.size) return groupProfiles(this.chars)
      return groupProfiles((this.chars || []).filter(c => names.has(baseOf(c.name))))
    },
    /** 本镜的**场景档案块** —— 只发本镜 `scene` 那一条（宽松命中；一个都没命中则不过滤，宁可多发） */
    sceneProfilesFor(s) {
      const all = this.scenes || []
      const sc = String((s && s.scene) || '').trim()
      if (!sc) return groupProfiles(all)
      let pick = all.filter(c => baseOf(c.name) === sc)
      if (!pick.length) { const k = sceneKey(sc); pick = k ? all.filter(c => sceneKey(baseOf(c.name)) === k) : [] }
      return groupProfiles(pick.length ? pick : all)
    },
    async savePrompts() {
      if (!this.canSave()) return
      // _gen / _genAt 是纯 UI 状态（生成中），绝不能落库，否则重开就是「永远转圈」
      const clean = this.prompts.map(p => {
        const o = { ...p, refs: { ...(p.refs || emptyRefs()) } }
        delete o._gen; delete o._genAt
        return o
      })
      await this.st.saveArtifact('prompts', clean)
    },
    /* ---- 提示词 / 视频的脏标记（上游=分镜行 + 引用的素材图） ---- */
    /** 素材绝对路径 → 图片版本号（来自角色&场景档案的 _imgRev；纯读取，不改任何状态） */
    assetRevMap() {
      const m = {}
      const ep = this.st.current
      if (!ep || !ep.assetsDir) return m
      const add = (list, kind) => {
        for (const c of list || []) {
          const rev = c._imgRev || 1
          for (const f of c.candidates || []) {
            m[joinPath(joinPath(joinPath(ep.assetsDir, kind), seg(c.name)), f)] = rev
          }
        }
      }
      add(this.chars, 'characters')
      add(this.scenes, 'scenes')
      return m
    },
    /** 本行当前引用的素材的版本签名（老字段：路径 → 该卡的第几版图） */
    sigAssets(refs) {
      const map = this.assetRevMap()
      const out = {}
      for (const p of [...(refs.images || []), ...(refs.videos || []), refs.first, refs.last]) {
        if (p && map[p] != null) out[p] = map[p]
      }
      return out
    },
    /**
     * 本集需要指纹的素材路径（所有镜头 refs 里的参考图/参考视频/首帧/尾帧，去重）。
     * 只统计**被引用**的（不是卡片候选池的全部）：签名只需回答「这一镜现在用的这几张还是原来那几张吗」。
     */
    refPathsAll() {
      const set = new Set()
      for (const p of this.prompts || []) {
        const r = (p && p.refs) || {}
        for (const kind of ['images', 'videos']) for (const f of (r[kind] || [])) if (f) set.add(f)
        for (const k of ['first', 'last']) if (r[k]) set.add(r[k])
      }
      return [...set]
    },
    /**
     * 刷新素材指纹（走主进程 files:sig；只 stat 不读内容，很便宜）。
     * 🔴 失败时**不置 asigReady**：宁可让内容维度「比不出来」（不算变、不放假 ⚠），
     *    也不能拿一堆空指纹去比 → 会把自己刚生成的签名比成过期，全屏假警报。
     */
    async refreshAsig() {
      const paths = this.refPathsAll()
      if (!paths.length) { this.asig = {}; this.asigReady = true; return }
      try {
        const r = await window.studio.fileSigs(paths)
        this.asig = (r && typeof r === 'object') ? r : {}
        this.asigReady = true
      } catch (_) { /* 保持 asigReady=false：这一轮不做内容维度的判定 */ }
    },
    /** 素材绝对路径 → 文件指纹（指纹表里没有 → 空串，签名里以「无指纹」参与比较） */
    asigOf(p) { return (p && this.asig[p]) || '' },
    /** 提示词「应该」匹配的上游签名（分镜版本 + 素材版本 + 素材构成 + 素材顺序/内容，见 stale.js） */
    curPromptSig(i) {
      const refs = (this.prompts[i] && this.prompts[i].refs) || {}
      return {
        v: SIG_V,
        shotRev: (this.shots[i] && this.shots[i]._rev) || 1,
        assets: this.sigAssets(refs),
        // 素材构成（数量/有无）决定官方任务类型与规范文件 → 变了提示词就过期
        refs: { img: (refs.images || []).length, vid: (refs.videos || []).length, first: refs.first ? 1 : 0, last: refs.last ? 1 : 0 },
        // 素材顺序 + 文件内容（v2 新增）：拖动排序、换图、素材被删都算「变了」。
        // 指纹还没取回来 → null（sigSame 见到 null 就不比这一项，绝不放假 ⚠）
        order: this.asigReady ? refOrderSig(refs, p => this.asigOf(p)) : null
      }
    },
    /** 提示词是否过期：生成后分镜/素材变过，且用户没有点掉提示 */
    promptStale(i) {
      const p = this.prompts[i]
      if (!p || !p._sig || !p.text || !p.text.trim()) return false
      return sigStale(p._sig, this.curPromptSig(i), p._ack)
    },
    /** ⚠ 里说清哪里变了（分镜 / 参考素材 / 都有）—— 只在确实要显示提示时取值 */
    staleWhatPrompt(i) {
      const p = this.prompts[i]
      return staleReason(p && p._sig, this.curPromptSig(i))
    },
    staleWhatVideo(i) {
      const v = this.vstate[i]
      return staleReason(v && v._sig, this.curVideoSig(i))
    },
    async ackPrompt(i) {
      const p = this.prompts[i]
      p._ack = this.curPromptSig(i)
      await this.savePrompts()
      this.$root.toast('提示已消除')
    },
    /** 手动编辑提示词：版本 +1（已生成的视频随之过期） */
    async touchPrompt(i) {
      const p = this.prompts[i]
      p._rev = (p._rev || 1) + 1
      await this.savePrompts()
    },
    /** 视频「应该」匹配的上游签名（提示词版本 + 分镜版本 + 素材版本 + 素材顺序/内容） */
    curVideoSig(i) {
      const p = this.prompts[i] || {}
      const refs = p.refs || {}
      return {
        v: SIG_V,
        promptRev: p._rev || 1,
        shotRev: (this.shots[i] && this.shots[i]._rev) || 1,
        assets: this.sigAssets(refs),
        order: this.asigReady ? refOrderSig(refs, x => this.asigOf(x)) : null
      }
    },
    videoStale(i) {
      const v = this.vstate[i]
      if (!v || !v._sig || !v.files.length) return false
      return sigStale(v._sig, this.curVideoSig(i), v._ack)
    },
    async ackVideo(i) {
      const v = this.vstate[i]
      v._ack = this.curVideoSig(i)
      await this.saveVideos()
      this.$root.toast('提示已消除')
    },
    /** 模块级脏标记（改编稿在分镜生成之后又被改过）统一显示在模块标题行，见 App.vue 的 stage-head */
    /* ---- 参考素材（都可不选；选什么用什么） ---- */
    /** 本镜头参考素材 → 官方任务类型（提示词规范分流与 UI 路线标签共用同一判定） */
    h3ModeOf(r) {
      const refs = r || {}
      if ((refs.images || []).length || (refs.videos || []).length) return 'Ref2VA'
      if (refs.first && refs.last) return 'FL2VA'
      if (refs.first) return 'I2VA'
      if (refs.last) return 'L2VA'
      return 'T2VA'
    },
    /**
     * 当前视频方案用的提示词规范文件名 —— 由方案自己声明（electron/profiles/*.json 的 prompt.files 段，
     * 经 st.promptFiles 透传）：H3 = { base:'h3.md', ref:'h3ref.md' }，LTX-2.5 = { base:'ltx.md' }。
     * 拿不到声明时回落 H3 老约定（保证旧库 / 老方案照常工作）。
     * @param {boolean} isRef 是否参考支路（只有声明了 ref 的方案才有第二份规范）
     */
    videoSpecFile(isRef) {
      const vf = (this.st.promptFiles && this.st.promptFiles.video) || {}
      return (isRef && vf.ref) ? vf.ref : (vf.base || (isRef ? 'h3ref.md' : 'h3.md'))
    },
    /** 当前视频方案是否走 H3 系规范（决定路线标签用「三段/六段」还是「整段散文」措辞） */
    isH3Spec() { return /^h3/i.test(this.videoSpecFile(false)) },
    /** 提示词分区的标题（2026-10-10 Dragon：改为固定文案「视频提示词」——
        原来跟着底层规范文件名走（H3 提示词 / LTX 提示词），用户并不关心用的是哪套规范） */
    promptZoneName() { return '视频提示词' },
    /** 提示词输入框的占位文案（H3 是字段化三段/六段，LTX-2.5 是整段散文） */
    promptPlaceholder() {
      return this.promptZoneName() + (this.isH3Spec() ? '（英文结构化）…' : '（英文整段散文）…')
    },
    /**
     * 参考素材绝对路径 → 所属档案（{ label, name, base, variant }）；不属于任何卡则 null。
     * 认领判据是**路径前缀**（以该卡的素材目录开头），所以卡目录里的任意文件都能认回来。
     */
    refOwnerInfo(abs) {
      const ep = this.st.current
      if (!ep || !ep.assetsDir || !abs) return null
      const box = [[this.chars, 'characters', 'character sheet'], [this.scenes, 'scenes', 'scene sheet']]
      for (const [list, kind, label] of box) {
        for (const c of list || []) {
          const dir = joinPath(joinPath(ep.assetsDir, kind), seg(c.name))
          if (abs.indexOf(dir) === 0) {
            return { label: label, name: c.name, base: baseOf(c.name), variant: variantOf(c.name) }
          }
        }
      }
      return null
    },
    /**
     * 参考素材绝对路径 → 提示词里标注 <Picture N> 的来源（帮模型定义 Subject）。
     * 视角变体（`主体名--视角`）写成「主体名 / 视角」：既点明属于哪个主体，又保留这一张的视角信息，
     * 模型据此把同一主体的多张图归成一个 <Subject N>（规则见 skills/prompts/h3ref.md 的「参考标签」）。
     */
    refOwner(abs) {
      const o = this.refOwnerInfo(abs)
      if (!o) return ''
      return ' (' + o.label + ': ' + (o.variant ? (o.base + ' / ' + o.variant) : o.name) + ')'
    },
    /** 参考素材绝对路径 → 所属**主体基名**（说话人锁图用精确基名比较，不用子串包含） */
    refOwnerBase(abs) {
      const o = this.refOwnerInfo(abs)
      return o ? o.base : ''
    },
    /** 分镜 dialogue → 逐条「说话人 + 台词」，随任务一起发给模型钉死说话人（换行分隔，兼容全角冒号与「名（备注）」） */
    dialogueLines(s) {
      const raw = String((s && s.dialogue) || '').trim()
      if (!raw) return []
      const out = []
      for (const ln of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        const m = ln.match(/^([^：:]{1,24})[：:]\s*([\s\S]+)$/)
        if (!m) { out.push({ name: '', note: '', text: ln }); continue }
        let name = m[1].trim(), note = ''
        const pm = name.match(/^(.*?)[（(]([^）)]*)[）)]$/)
        if (pm) { name = pm[1].trim(); note = pm[2].trim() }
        // 句尾英文括注剥掉（存量改编稿把画外音英文说明带进了台词；H3 任务与时长计算都不该看到它）
        out.push({ name: name, note: note, text: stripTailEnNote(m[2].trim()) })
      }
      return out
    },
    /**
     * 本镜头当前选择的素材 → 将走哪条生成路线（始终显示）。
     * 🔴 2026-10-14：显示的是**实际生效**的素材 —— 传了 `i` 就按本镜 chars/scene 过滤（`effRefs`），
     *    免得界面写着「参考模式」而真正生成时一张图都没发。
     */
    modeOf(p, i) {
      const r = (typeof i === 'number') ? this.effRefs(i) : (p.refs || {})
      const nImg = (r.images || []).length
      const nVid = (r.videos || []).length
      const mode = this.h3ModeOf(r)
      // 措辞跟着「当前方案声明的规范文件」走：H3 是字段化的三段/六段，LTX-2.5 是整段散文
      const spec = this.videoSpecFile(mode === 'Ref2VA')
      const h3 = this.isH3Spec()
      if (mode === 'Ref2VA') {
        const parts = []
        if (nImg) parts.push('参考图×' + nImg)
        if (nVid) parts.push('参考视频×' + nVid)
        return { cls: 'ref', tag: 'Ref2VA',
          text: '已选 ' + parts.join(' + ') + ' → 参考模式 ref2va（官方六段提示词，规范文件 ' + spec + '）' }
      }
      if (mode === 'FL2VA') {
        return { cls: 'flf', tag: 'FL2VA', text: h3
          ? '首帧 + 尾帧 → 官方首尾帧模式（三段提示词 · fl2va）'
          : '首帧 + 尾帧 → 首尾帧过渡（整段散文提示词 · ' + spec + '）' }
      }
      if (mode === 'I2VA') {
        return { cls: 'flf', tag: 'I2VA', text: h3
          ? '仅首帧 → 官方首帧模式（三段提示词 · fl2va）'
          : '仅首帧 → 图生视频（整段散文提示词 · ' + spec + '）' }
      }
      if (mode === 'L2VA') {
        return { cls: 'flf', tag: 'L2VA', text: h3
          ? '仅尾帧 → 官方尾帧模式（三段提示词 · fl2va）'
          : '仅尾帧 → 尾帧引导（整段散文提示词 · ' + spec + '）' }
      }
      return { cls: 't2v', tag: 'T2VA', text: h3
        ? '未选素材 → 纯文字生成（官方三段提示词 · fl2va）'
        : '未选素材 → 纯文字生成（整段散文提示词 · ' + spec + '）' }
    },
    refSrc(abs) {
      if (!abs) return ''
      if (this._ref64[abs] !== undefined) return this._ref64[abs]
      this._ref64[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) this._ref64[abs] = 'data:image/png;base64,' + b64
        else delete this._ref64[abs]
      })
      return ''
    },
    /** 参考视频（第 5 块素材）：与镜头视频一样带播放控件预览，同样走 base64（含小缓存上限） */
    refVidSrc(abs) {
      if (!abs) return ''
      if (this._refv[abs] !== undefined) return this._refv[abs]
      this._refv[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        if (b64) this._refv[abs] = 'data:video/mp4;base64,' + b64
        else delete this._refv[abs]
      })
      return ''
    },
    async addRef(i, kind) {
      const files = await window.studio.pickFiles(kind === 'videos' ? 'video' : 'image')
      if (!files || !files.length) return
      const r = this.prompts[i].refs
      const max = kind === 'videos' ? MAX_REF_VID : MAX_REF_IMG
      let added = 0
      for (const f of files) {
        if (r[kind].length >= max) break
        r[kind].push(f); added++
      }
      await this.savePrompts()
      if (added < files.length) this.$root.toast('已达上限，本次只加入 ' + added + ' 个')
    },
    async delRef(i, kind, k) {
      this.prompts[i].refs[kind].splice(k, 1)
      await this.savePrompts()
    },
    /**
     * 本镜**实际生效**的参考素材 —— 与 UI 上挂的素材（prompts[i].refs）可能不同。
     * 🔴 2026-10-14（用户拍板）：按本镜 `chars` / `scene` 过滤 —— `chars` 里没写的主体，
     *    即使这一镜挂了它的参考图/参考视频，也**不写进提示词、不送去生成**。
     * - 认不出归属的素材（用户从素材目录外选的图）判断不了是谁的 → 一律保留。
     * - 本镜 `chars` 与 `scene` 都为空 → 不做过滤（老数据兜底，宁可多发）。
     * - 首帧 / 尾帧是**构图锚点**不是主体参考，不参与过滤。
     * 🔴 提示词里的 <Picture N> 编号与实际注入的素材**必须同源**（genP 与 genV 都取这一份），
     *    否则模型看到的第一张图不是它以为的那张。
     * @param {number} i 镜头下标
     * @param {object} [src] 素材来源 refs；**不传 = 组件本地副本**（UI 所见，模板/角标/路线提示用）。
     *   🔴 genV 必须显式传 store 那份（`pr.refs`）—— 视频生成一直以**库里的权威副本**为准
     *   （就连 `prompt` 文本也是从 `st.current.prompts` 取的），UI 副本只是编辑态；两者在生产环境同步，
     *   但「别块直接写库」时只有 store 是新的。
     */
    effRefs(i, src) {
      const r = (src && typeof src === 'object') ? src : ((this.prompts[i] && this.prompts[i].refs) || {})
      const raw = { images: r.images || [], videos: r.videos || [], first: r.first || null, last: r.last || null }
      const names = this.shotSubjects(this.shots[i])
      if (!names.size) return raw
      const keep = (abs) => { const o = this.refOwnerInfo(abs); return !o || names.has(o.base) }
      return { images: raw.images.filter(keep), videos: raw.videos.filter(keep), first: raw.first, last: raw.last }
    },
    /** 挂了、但（因本镜 chars/scene 不含该主体而）不会被用到的素材 → 缩略图标「未使用」 */
    refUnused(i, kind, k) {
      const r = (this.prompts[i] && this.prompts[i].refs) || {}
      const abs = ((kind === 'videos' ? r.videos : r.images) || [])[k]
      if (!abs) return false
      const names = this.shotSubjects(this.shots[i])
      if (!names.size) return false
      const o = this.refOwnerInfo(abs)
      return !!(o && !names.has(o.base))
    },
    /** 参考素材缩略图的悬停提示：被过滤掉时说明原因，否则就是文件名 */
    refTitle(i, kind, k, fallback) {
      if (!this.refUnused(i, kind, k)) return fallback
      return fallback + '\n\n⚠ 本镜未使用：分镜行「角色」里没有这个主体 —— 它不写进提示词，也不送去生成。'
    },
    /* ---- 参考图拖动排序（2026-10-08）----
       只在同一镜头的参考图之间排序（素材属于本镜头，不跨行搬运）。
       顺序会改变提示词里 <Picture N> 的编号（genP 按 refs.images 顺序标注来源），
       所以重排后该镜头的提示词会自然标 ⚠ 提醒重新生成——由素材签名比对得出，无需额外代码。 */
    refDragStart(i, k) { this.dragFrom = { i, k } },
    refDragOver(i, k) {
      if (!this.dragFrom || this.dragFrom.i !== i) return
      this.dragTo = { i, k }   // 只记目标位；松手才真正重排（避免拖动中 key 抖动让图片闪）
    },
    async refDragDrop(i, k) {
      const d = this.dragFrom
      this.dragFrom = null; this.dragTo = null
      if (!d || d.i !== i || d.k === k) return
      const p = this.prompts[i]
      const arr = p && p.refs && p.refs.images
      if (!arr || d.k >= arr.length || k >= arr.length) return
      const [m] = arr.splice(d.k, 1)
      arr.splice(k, 0, m)
      await this.savePrompts()
    },
    refDragEnd() { this.dragFrom = null; this.dragTo = null },
    async pickFrame(i, which) {
      const files = await window.studio.pickFiles('image')
      if (!files || !files.length) return
      this.prompts[i].refs[which] = files[0]
      await this.savePrompts()
    },
    async clearFrame(i, which) {
      this.prompts[i].refs[which] = null
      // 首帧接力的来源信息跟着首帧一起清（留着会让下次手动选图被误判成「来自上一镜」）
      if (which === 'first') {
        delete this.prompts[i].refs.firstFrom
        delete this.prompts[i].refs.firstSrc
        if (this.frameStale) delete this.frameStale[i]
      }
      await this.savePrompts()
    },
    /* ==== 首帧接力：把上一镜的最后一帧作为本镜首帧（2026-10-09）====
       为什么这么做：H3 是逐镜独立生成，本镜拿不到「上一镜结束时画面长什么样」这个信息，
       接缝处只能靠模型猜 —— 这是镜头间人物/画面漂移最大的来源。给一张真实的起始画面，
       等价于把「首帧模式（I2VA / fl2va）」用起来，接缝就是连续的。
       边界：上一镜没出片 → 按钮禁用；ffmpeg 没找到 → 明确指引去设置（不是一句看不懂的报错）。 */
    /** 上一镜**当前采用的那一版**视频文件名（没有则 null）；cur 未选时退回最后一版 */
    prevShotFile(i) {
      if (i <= 0) return null
      const prev = this.vstate[i - 1]
      const files = (prev && prev.files) || []
      if (!files.length) return null
      const k = Number.isInteger(prev.cur) && prev.cur >= 0 && prev.cur < files.length ? prev.cur : files.length - 1
      const f = files[k]
      return (f && f.f) || f || null
    },
    /** 上一镜视频的绝对路径（无 → null）；`!!prevShotVideo(i)` 就是「能不能取帧」的判据 */
    prevShotVideo(i) {
      const f = this.prevShotFile(i)
      const dir = (this.st.current && this.st.current.shotDir) || ''
      return f && dir ? joinPath(dir, f) : null
    },
    /** 取帧按钮的 hover 说明：把「为什么不能点」直接说清楚 */
    prevShotTip(i) {
      if (i <= 0) return '这是第 1 个镜头，前面没有镜头可以接 —— 请手动选一张图作为首帧'
      const abs = this.prevShotVideo(i)
      if (!abs) return '上一镜（镜头 ' + i + '）还没有视频：先在上一行生成视频，再来取它的末帧'
      return '取「镜头 ' + i + '」视频的最后一帧作为本镜首帧（' + this.baseName(abs) + '）\n' +
        '生成出来的帧图存到分镜目录（' + this.epPrefix + '_shot_' + (i + 1) + '_first.png），可随时重取'
    },
    /** 该镜首帧是否已过期（'' / undefined = 正常；'changed' = 上一镜重新出片了；'gone' = 源视频没了） */
    firstStale(i) { return (this.frameStale && this.frameStale[i]) || '' },
    firstTitle(i) {
      const r = this.prompts[i] && this.prompts[i].refs
      if (!r || !r.first) return '首帧'
      const base = this.baseName(r.first)
      if (r.firstFrom === 'prev-shot') {
        const src = (r.firstSrc && r.firstSrc.video) ? this.baseName(r.firstSrc.video) : '上一镜视频'
        const st = this.firstStale(i)
        const warn = st === 'changed' ? '⚠ 上一镜的视频已重新生成，这个末帧过期了，建议点「重取」'
          : st === 'gone' ? '⚠ 上一镜的视频文件已经找不到了，建议点「重取」或改用手动选图'
            : ''
        return '首帧：' + base + '\n来源：' + src + ' 的最后一帧' + (warn ? '\n' + warn : '')
      }
      return '首帧：' + base + '（手动选择）'
    },
    /** 取上一镜末帧 → 落盘 → 写进本镜 refs.first。quiet=true 时不出提示（批量用） */
    async takePrevLastFrame(i, quiet) {
      const abs = this.prevShotVideo(i)
      if (!abs) {
        if (!quiet) this.$root.toast('镜头 ' + i + ' 还没有视频，先生成它再来取末帧')
        return false
      }
      if (this.frameBusy !== -1) return false
      this.frameBusy = i
      try {
        // 帧图落盘位置：与镜头视频同目录、同一套命名规律（<集>_shot_<序号>_first.png），
        // 这样 refs.first 指向的是一个稳定存在的文件，跨会话/重启后缩略图照样能显示。
        const dir = (this.st.current && this.st.current.shotDir) || ''
        const out = joinPath(dir, this.epPrefix + '_shot_' + (i + 1) + '_first.png')
        const r = await window.studio.videoLastFrame({ video: abs, out })
        if (!r || !r.ok) {
          const err = (r && r.error) || '未知原因'
          if (err === 'NOPATH') {
            if (!quiet) this.st.fail(new Error('没有找到 ffmpeg，无法从视频里抽帧。请到「设置」里填写 ffmpeg 路径（或把 ffmpeg.exe 放到工作区的 tools/ 目录下），然后重试。'))
          } else if (!quiet) {
            this.st.fail(new Error('取上一镜末帧失败：' + err))
          }
          return false
        }
        const st = await window.studio.fileStat(abs)
        const refs = this.prompts[i].refs || (this.prompts[i].refs = emptyRefs())
        refs.first = r.out
        refs.firstFrom = 'prev-shot'
        // 记住「这帧是从哪个文件的哪个版本取的」——上一镜之后重新出片时靠它算过期
        refs.firstSrc = { video: abs, mtime: (st && st.mtime) || 0, size: (st && st.size) || 0 }
        await this.savePrompts()
        if (this.frameStale) delete this.frameStale[i]
        if (!quiet) this.$root.toast('已取镜头 ' + i + ' 的末帧作为镜头 ' + (i + 1) + ' 的首帧')
        return true
      } catch (e) {
        if (!quiet) this.st.fail(e)
        return false
      } finally { this.frameBusy = -1 }
    },
    /** 一键续接：2..N 逐镜取上一镜末帧（上一镜没出片的跳过） */
    async chainAllFrames() {
      const n = this.shots.length
      if (n < 2) { this.$root.toast('只有 1 个镜头，没有可以续接的上一镜'); return }
      this.chainBusy = true
      let ok = 0, skip = 0
      const L = stepLog('阶段6 H3视频')
      try {
        L.start('开始续接首帧：把每个镜头的首帧设为上一镜末帧（共 ' + (n - 1) + ' 个）')
        for (let i = 1; i < n; i++) {
          if (!this.prevShotVideo(i)) { skip++; continue }
          L.start('正在续接首帧：镜头 ' + (i + 1) + '/' + n + '（取镜头 ' + i + ' 的末帧）')
          const fine = await this.takePrevLastFrame(i, true)
          if (fine) ok++
        }
        await this.refreshFrameStale()
        const msg = '首帧续接完成：' + ok + ' 个镜头已接上上一镜末帧'
          + (skip ? '，' + skip + ' 个因上一镜还没出片而跳过' : '')
        L.done(msg)
        this.$root.toast(msg)
      } finally { this.chainBusy = false }
    },
    /**
     * 重算「首帧是否过期」。只比对签名（源路径 + mtime + 大小），不读图片内容。
     * 🔴 只在非渲染路径调用（切集 / 出片后 / 续接后）—— 在模板函数里改响应式数据会
     *    触发「渲染 → 改数据 → 再渲染」的死循环（同 pruneB64 那条教训）。
     * only = 只查这一个镜头下标（出片后只影响下一个镜头，避免批量时 O(n²) 次查盘）
     */
    async refreshFrameStale(only) {
      const out = only === undefined ? {} : { ...this.frameStale }
      const from = only === undefined ? 0 : only
      const to = only === undefined ? this.prompts.length - 1 : only
      for (let i = from; i <= to; i++) {
        delete out[i]
        const r = (this.prompts[i] && this.prompts[i].refs) || null
        if (!r || r.firstFrom !== 'prev-shot' || !r.firstSrc) continue
        const now = this.prevShotVideo(i)
        if (!now || now !== r.firstSrc.video) { out[i] = 'changed'; continue }
        const st = await window.studio.fileStat(now)
        if (!st || !st.exists) out[i] = 'gone'
        else if (st.mtime !== r.firstSrc.mtime || st.size !== r.firstSrc.size) out[i] = 'changed'
      }
      this.frameStale = out
    },
    /* ---- 生成提示词 ---- */
    async genP(i, ctx) {
      const s = this.shots[i]
      if (!s) return false
      const p = this.prompts[i]
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.pBusy = true
      p._gen = true
      p._genAt = Date.now()   // 「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(4)
      const L = stepLog('阶段5 H3提示词')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      L.start('正在生成第' + (i + 1) + '个镜头的提示词' + prog)
      try {
        const refs = p.refs || {}
        // 🔴 2026-10-14：本镜**实际生效**的素材（按 chars / scene 过滤过）。
        //    下面的 <Picture N> 清单、说话人锁图，以及阶段 6 真正注入 ComfyUI 的素材，
        //    全部取自这一份，保证「提示词里的编号」与「实际附上的图」一致。
        //    这里显式传 `p.refs`（组件本地副本，编辑态）—— 与改造前 `p.refs` 同源。
        const eff = this.effRefs(i, p.refs)
        const mode = this.h3ModeOf(eff)
        // 规范文件由「当前视频方案」声明（st.promptFiles.video，来自 electron/profiles/*.json 的
        // prompt.files 段）：H3 声明 { base:'h3.md', ref:'h3ref.md' }（基础三段式 / 参考六段式），
        // LTX-2.5 声明 { base:'ltx.md' }（无参考支路，整段散文）。拿不到声明时回落 H3 老约定。
        const vf = (this.st.promptFiles && this.st.promptFiles.video) || {}
        const specFile = (mode === 'Ref2VA' && vf.ref) ? vf.ref : (vf.base || (mode === 'Ref2VA' ? 'h3ref.md' : 'h3.md'))
        // 格式细节全部在该 md 里：system（角色与任务 + 规则 + 输出契约）与 user（素材格式）同源
        const system = await composeSystem({
          specs: [specFile],
          mustHave: ['## 输出格式'],
          // 用途：成品覆写按它生效（提示词页里「视频提示词 · 基础 / 参考」各一篇）
          task: mode === 'Ref2VA' ? 'video-ref' : 'video-base'
        })
        // ---- user 消息：结构、标签与所有指令文字都来自规范 md（h3.md / h3ref.md 的「## 素材格式」），
        //      这里只负责准备素材本身（档案文本、镜头 JSON、对白行、连续性状态、资产清单）----
        // 对白锁人：把「谁说哪句」逐条列清随任务下发，模型不必猜（说话人漂移是本模块最大回归源）
        const dlg = this.dialogueLines(s)
        const who = (n) => {
          if (!n) return '(speaker name missing in the shot text)'
          const hit = (this.chars || []).find(c => c.name === n) || (this.scenes || []).find(c => c.name === n)
          let pic = ''
          if (hit && mode === 'Ref2VA') {
            // 🔴 2026-10-08：改**精确主体基名比较**。原来是拿 refOwner 的返回串做子串包含判断，
            //    有了 `主体名--视角` 这种带后缀的卡名后会误命中（而且短名会命中长名），
            //    可能把台词挂到错的 <Picture N> 上。
            const k = eff.images.findIndex(f => this.refOwnerBase(f) === n)
            if (k >= 0) pic = ' → <Picture ' + (k + 1) + '>'
          }
          return n + pic
        }
        const dlgText = dlg.length
          ? dlg.map((l, k) => (k + 1) + '. ' + who(l.name) + (l.note ? ' [' + l.note + ']' : '') + ' says: ' + l.text).join('\n')
          : ''
        // 连续性状态：本镜必须呈现的状态快照 + 本镜发生的变化（每镜独立生成、模型没有跨镜记忆，
        // 服装/随身物只靠这一块钉住，见 promptlib.contWarnings）
        const cont = String(s.continuity || '').trim()
        const chg = String(s.change || '').trim()
        // 资产清单：参考模式按注入顺序编号（模型据此写 <Subject N> 定义）；首/尾帧另给一组对齐句标签。
        // 🔴 2026-10-10（方案 A）：**参考模式下首尾帧同样会注入工作流**（inference.injectMedia 里
        //    hasRef 分支之后仍跑 guide 段，用 AddGuide 把首帧钉在 0 秒、尾帧钉在结尾），所以提示词里
        //    也必须表达出来 —— 否则模型只把它当"看不见的图"，接缝连续性等于白设（H10 实测：设了首帧
        //    却走 Ref2VA 时，提示词 3746 字里零 first frame）。编号接在参考图之后继续排，避免与参考图的
        //    <Picture N> 撞号；基础模式下参考图恒为空 → 编号仍从 1 起（仅尾帧时是 <Picture 1>，
        //    与 h3.md 的 L2VA 对齐句写法一致）。
        let refAssets = '', frames = ''
        let picN = (mode === 'Ref2VA') ? eff.images.length : 0
        const frameSrc = []
        if (eff.first) frameSrc.push('<Picture ' + (++picN) + '> = the first frame image attached to the model')
        if (eff.last) frameSrc.push('<Picture ' + (++picN) + '> = the last frame image attached to the model')
        frames = frameSrc.join('\n')
        if (mode === 'Ref2VA') {
          const inv = []
          eff.images.forEach((f, k) => inv.push('<Picture ' + (k + 1) + '> = ' + this.baseName(f) + this.refOwner(f)))
          eff.videos.forEach((f, k) => inv.push('<Video ' + (k + 1) + '> = ' + this.baseName(f)))
          refAssets = inv.join('\n')
        }
        const user = await composeUser(specFile, {
          characters: this.charProfilesFor(s) || '(none)',
          scenes: this.sceneProfilesFor(s) || '(none)',
          n: i + 1,
          dur: s.dur,
          shot: JSON.stringify(s, null, 2),
          mode,
          dialogue: dlgText,
          continuity: (cont || chg) ? (cont || '(none)') : '',
          change: chg,
          refAssets,
          frames
        })
        dbgPrompt('阶段5 H3提示词', '文字模型 · 第' + (i + 1) + '镜 · ' + mode, [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.6, maxTokens: 2048, stage: 'prompt', providerOverride: overrideOf('prompt'), label: '阶段5 H3提示词' })
        p.text = text.trim()
        const ms = Date.now() - t0
        p.genMs = ms                  // 逐条耗时（持久化在 prompts.json，显示在该镜头行上）
        p._rev = (p._rev || 1) + 1    // 内容变了：已生成的视频随之标 ⚠
        // 🔴 记签名前先取一次最新指纹：签名要留的是「生成这一版时磁盘上那几张图」，
        //    拿一份可能过时的指纹表去写，等于给未来埋一个查不出来的假阴性。
        await this.refreshAsig()
        p._sig = this.curPromptSig(i) // 记录生成时的上游签名（分镜 + 素材版本 + 素材顺序/内容）
        delete p._genAt
        await this.savePrompts()
        this.pl.markGen(4, ms)
        L.done('第' + (i + 1) + '个镜头的提示词生成完成：' + text.trim().length + ' 字', ms)
        return true
      } catch (e) {
        L.fail('第' + (i + 1) + '个镜头的提示词生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { delete p._genAt; p._gen = false; this.pBusy = false; this.pl.endGen(4); if (!this.vBusy) this._busyEpId = null }
    },
    /* ================= 批量任务（块 3 标题行的两个按钮） ================= */
    /** 「批量生成提示词」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围 */
    batchPrompts() {
      if (this.batchP) { this.batchPStop = true; this.$root.toast('停止中：当前镜头完成后停止，剩余镜头不再执行'); return }
      if (this.batchV) { this.$root.toast('视频批量进行中，请先等它结束或停止'); return }
      if (!this.shots.length) { this.$root.toast('还没有镜头，先点「生成分镜」'); return }
      this.askBatch = { kind: 'prompts' }
    },
    /** 「批量生成视频」：跑动中点击 = 强制停止（立刻中断当前任务并结束整批）；空闲先校验提示词齐全（缺哪个全列出）再弹框 */
    batchVideos() {
      if (this.batchV) { this.stopVideoGen(); return }
      if (this.batchP) { this.$root.toast('提示词批量进行中，请先等它结束或停止'); return }
      if (!this.shots.length) { this.$root.toast('还没有镜头，先点「生成分镜」'); return }
      const missing = []
      for (let i = 0; i < this.shots.length; i++) if (!(this.prompts[i] && this.prompts[i].text.trim())) missing.push(i + 1)
      if (missing.length) { this.$root.toast('镜头 ' + missing.join('、') + ' 没有提示词，请先生成提示词'); return }
      this.askBatch = { kind: 'videos' }
    },
    /**
     * 强制停止生成（2026-10-09）：立刻中断 ComfyUI 正在跑的任务 + 清掉排队 + 释放显存。
     * 两个入口都走这里：单镜「停止生成」（停这一镜）、标题行批量「停止生成」（停当前并结束整批）。
     * 与「停止批量」那种"等当前跑完再停"的软停不同——这里是硬停，当前进度直接丢弃。
     */
    async stopVideoGen(i) {
      if (this.stopBusy) return
      if (!this.batchV && !this.vBusy) return          // 没有任务在跑，别发空指令
      this.stopBusy = true
      // 批量在跑：先置停止位，等 genV 拿到"已取消"返回后整批跳出（runBatchV 的 finally 会复位）
      if (this.batchV) this.batchVStop = true
      const L = stepLog('阶段6 H3视频')
      const who = (i != null && this.shots[i]) ? '镜头 ' + (i + 1) + ' ' : ''
      this.$root.toast('正在停止生成并释放显存…')
      try {
        const r = await window.studio.comfyCancel()
        const bits = []
        if (r && r.interrupted) bits.push('已中断当前任务')
        if (r && r.cleared) bits.push('已清掉 ' + r.cleared + ' 个排队任务')
        if (r && r.freed) bits.push('已释放显存')
        const msg = bits.length ? bits.join('，') : '已发送停止指令'
        L.warn('停止生成：' + who + msg + (r && r.errors && r.errors.length ? '（' + r.errors.join('；') + '）' : ''))
        this.$root.toast('已停止生成：' + msg)
      } catch (e) {
        // ComfyUI 彻底无响应时这里会失败：给明确出路，别让用户以为按钮没生效
        L.fail('停止生成失败' + (who ? '：' + who : ''), null, e)
        this.$root.toast('停止生成失败：ComfyUI 可能已无响应，可到「设置 → 引擎」重启 ComfyUI')
      } finally {
        this.stopBusy = false
      }
    },
    askBatchAll() {
      const k = this.askBatch && this.askBatch.kind
      this.askBatch = null
      if (k === 'prompts') this.runBatchP(true)
      else if (k === 'videos') this.runBatchV(true)
    },
    askBatchMissing() {
      const k = this.askBatch && this.askBatch.kind
      this.askBatch = null
      if (k === 'prompts') this.runBatchP(false)
      else if (k === 'videos') this.runBatchV(false)
    },
    /** 批量生成提示词：all=true 全部重生成并覆盖；false 只补没有提示词的镜头。
     *  逐个顺序执行，batchPStop 置位后当前子任务跑完即停（剩余丢弃），结束统一统计 */
    async runBatchP(all) {
      const L = stepLog('阶段5 H3提示词')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (all || !(this.prompts[i] && this.prompts[i].text.trim())) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成的镜头'); return }
      this.batchP = true; this.batchPStop = false; this.pBusy = true
      this.batchPN = 0; this.batchPTotal = idx.length
      L.start('开始批量生成提示词（' + (all ? '全部重生成，覆盖已有' : '只补缺失') + '）：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头）；可随时点「停止批量」，当前镜头跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchPStop) { stopped = true; break }
          this.batchPN = k + 1
          const okFlag = await this.genP(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成提示词已停止' : '批量生成提示词结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
        if (!badN) this.$root.toast(stopped ? '批量已停止（已完成部分保留）' : '全部提示词已生成')
      } finally {
        this.batchP = false; this.batchPStop = false; this.pBusy = false
        this.batchPN = 0; this.batchPTotal = 0
        if (!this.vBusy) this._busyEpId = null
      }
    },
    async confirmPrompts() {
      await this.savePrompts()
      this.pl.confirm(4, this.st.current.id)
      this.$root.toast('提示词已确认，可在本行生成视频')
    },
    /* ================= 视频生成（原阶段6） ================= */
    initVideos(ep) {
      this._b64 = {}   // 换集必须清缓存，否则会命中上一集的同名镜头视频
      const s = ep.videoState && Object.keys(ep.videoState).length ? JSON.parse(JSON.stringify(ep.videoState)) : {}
      // 迁移：shots 数量变化时补齐；顺手清掉运行时字段
      ep.shots.forEach((_, i) => {
        if (!s[i]) s[i] = { files: [], cur: -1, confirmed: false }
        // 逐条分辨率默认值（未单独设置过 → 取剧集配置）
        if (!s[i].res) s[i].res = (ep.res && ep.res.vid) || '864x480'
      })
      Object.keys(s).forEach(k => { delete s[k]._gen; delete s[k]._genAt })
      // 镜头数变少后，超范围的陈旧键（如 13 镜改 10 镜后的 "10"/"11"/"12"）一并清掉，
      // 否则会永远留在 videos.json 里干扰下游（组装块按镜头下标取，多出的键是脏数据）
      const n = ep.shots.length
      Object.keys(s).forEach(k => { if (!/^\d+$/.test(k) || Number(k) >= n) delete s[k] })
      this.vstate = s
      // 首帧接力：切集/重开时重算一次「首帧是否过期」（模板里只读结果，不在渲染路径改状态）
      this.refreshFrameStale()
    },
    /** 该镜头当前生效的分辨率（未单独设置过 → 剧集配置） */
    resOf(i) {
      const s = this.vstate[i]
      return (s && s.res) || (this.st.current && this.st.current.res && this.st.current.res.vid) || '864x480'
    },
    /** 档位按当前视频模型过滤；该镜头已保存的值不在档位里时补进去 */
    optsFor(i) { return optsWith((this.st.resOptions || {}).vid, this.resOf(i)) },
    /** 该镜头实际用于生成的秒数（分镜脚本的 dur，夹取 4~15 含边界） */
    durOf(i) { return clampDur(this.shots[i] && this.shots[i].dur) },
    /** 时长软校验（只提示不拦截）：台词/发声表演/复合运镜与 dur 不匹配时返回违规说明 */
    durWarn(i) { return durWarnings(this.shots[i] || {}) },
    durSuggest(i) { return durSuggest(this.shots[i] || {}) },
    /** 黄标正文（超单镜上限 → 建议拆分；时长不足 → 建议 Ns） */
    durTag(i) { return durTag(this.shots[i] || {}) },
    contWarn(i) { return (this.contAll && this.contAll[i]) || [] },
    mergeWarn(i) { return (this.mergeAll && this.mergeAll[i]) || '' },
    /**
     * 「自动补镜」预览（2026-10-12）：时长容量类自检的一键修复，**只做加法**。
     * 生成时已自动跑过一次（generate 里的 fitShotCount），这里服务「手动增删镜头 / 手改时长后又不达标」。
     * added = 0（含剧集体裁 / 脚本超体裁容量 / 内容超容量等不由补镜解决的情形）→ 按钮自动不渲染。
     */
    capPlan() { return fitShotCount(this.shots, this.adapted, this.limits, this.targetSec) },
    /* ---- 拆镜（第 2 批）：内容超单镜 15s 上限的镜头由程序按台词边界拆开 ---- */
    /** 该镜头的拆分标记（null = 不是拆分段） */
    splitInfo(i) { return (this.shots[i] && this.shots[i]._split) || null },
    /** 拆分段的行内黄标文案（'' = 不是拆分段） */
    splitTag(i) { return splitTag(this.shots[i] || {}) },
    /** 是否该拆分组的组头（只有组头挂「AI 重写 / 撤回」按钮） */
    splitHead(i) { const s = this.splitInfo(i); return !!s && s.k === 0 },
    /** 该拆分组的全部镜头下标（升序） */
    splitGroup(i) {
      const s = this.splitInfo(i)
      if (!s) return []
      const out = []
      this.shots.forEach((x, k) => { if (x && x._split && x._split.gid === s.gid) out.push(k) })
      return out
    },
    /** 该段是否正被 AI 重写（同组每一段都显示忙碌，避免用户以为点了没反应） */
    splitBusy(i) { const s = this.splitInfo(i); return !!s && !!this.rewriting && s.gid === this.rewriting },
    /** 拆镜黄标的 hover 说明 */
    splitTip(i) {
      const s = this.splitInfo(i)
      if (!s) return ''
      const g = this.splitGroup(i)
      return '本镜由「镜头 ' + ((g[0] || 0) + 1) + '」按台词边界拆分而来（第 ' + (s.k + 1) + '/' + s.n + ' 段）：\n'
        + '台词、场景、角色、时长由程序算定（台词一行不切）；画面动作与镜头语言是程序按标点粗切的，各段镜头语言相同。'
        + (s.ai ? '\n画面已由 AI 重写。' : '\n点右侧「AI 重写」让模型为每一段补写画面。')
    },
    /** 该镜头是否被手改过（_rev 由 touchShot 递增，新生成的镜头为 1）——「整理镜头」不碰用户的手改 */
    touched(s) { return ((s && s._rev) || 1) > 1 },
    /** 「整理镜头」预览：会重算时长的镜头数 + 会拆分的组（只统计没被手改过的镜头） */
    tidyPreview() {      let durFixed = 0
      const arr = this.shots.map(s => {
        if (this.touched(s)) return s
        const f = durFit(s)
        if (f > 0 && f !== clampDur(s.dur)) { durFixed++; return { ...s, dur: clampDur(f) } }
        return s
      })
      const sp = splitAll(arr)
      return { durFixed, groups: sp.groups, map: sp.map, from: this.shots.length, to: sp.shots.length }
    },
    /**
     * 整理镜头（存量数据）：按内容重算时长（跳过手改过的镜头）+ 把超单镜上限的镜头拆开。
     * 需要按下标重建提示词/视频槽位 —— 镜头数会变、后面所有镜头的位置都会前移。
     */
    async tidyShots() {
      this.askTidy = false
      const pv = this.tidyPreview
      if (!pv.durFixed && !pv.groups.length) {
        this.$root.toast('无需整理：时长已与内容一致，也没有超过单镜上限的镜头')
        return
      }
      const before = this.shots.length
      const fixed = this.shots.map(s => {
        if (this.touched(s)) return s
        const f = durFit(s)
        return f > 0 ? { ...s, dur: clampDur(f) } : s
      })
      const sp = splitAll(fixed)
      const oldP = this.prompts, oldV = this.vstate
      const np = [], nv = {}
      sp.map.forEach((dsts, oi) => {
        const op = oldP[oi], ov = oldV[oi] || {}
        const res = ov.res || (this.st.current && this.st.current.res && this.st.current.res.vid) || '864x480'
        if (dsts.length === 1) {
          // 没被拆的镜头：提示词与视频记录原样搬运（只是位置可能后移）
          np[dsts[0]] = op || { text: '', refs: emptyRefs() }
          nv[dsts[0]] = ov
          return
        }
        // 被拆开的镜头：原提示词对应的是"整段镜头"，拆开后作废；素材选择沿用（同场景同角色，省得重挑）；
        // 原视频对应整段镜头，记录一并清空（文件仍在磁盘），只保留分辨率选择
        const refs = op && op.refs ? JSON.parse(JSON.stringify(op.refs)) : emptyRefs()
        dsts.forEach(di => {
          np[di] = { text: '', refs: JSON.parse(JSON.stringify(refs)) }
          nv[di] = { files: [], cur: -1, confirmed: false, res }
        })
      })
      this.shots = sp.shots
      this.prompts = np
      this.vstate = nv
      this.syncSlots()
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      this.$root.toast('整理完成：时长重算 ' + pv.durFixed + ' 个镜头 · 拆分 ' + sp.groups.length +
        ' 组（镜头 ' + before + ' → ' + sp.shots.length + '）；拆出的画面可点「AI 重写」补写')
    },
    /**
     * 按段落秒数自动补镜（2026-10-12）：时长容量类自检的**一键加法修复**。
     * 与 tidyShots 的分工：那个是「按内容重算时长 + 拆内容超长的镜」（整理），
     * 这个是「把声明秒数装不下的长段落拆成多镜」（补齐容量）—— 判据与拆分机制复用同一套
     * （fitShotCount 内部就用 splitShotParts），槽位重建也与 tidyShots 完全一致。
     */
    async fixShotCount() {
      const pv = fitShotCount(this.shots, this.adapted, this.limits, this.targetSec)
      if (!pv.added) { this.$root.toast('无需补镜：当前镜头数已装得下脚本声明时长'); return }
      const before = this.shots.length
      const oldP = this.prompts, oldV = this.vstate
      const np = [], nv = {}
      pv.map.forEach((dsts, oi) => {
        const op = oldP[oi], ov = oldV[oi] || {}
        const res = ov.res || (this.st.current && this.st.current.res && this.st.current.res.vid) || '864x480'
        if (dsts.length === 1) {
          // 没被拆的镜头：提示词与视频记录原样搬运（只是位置可能后移）
          np[dsts[0]] = op || { text: '', refs: emptyRefs() }
          nv[dsts[0]] = ov
          return
        }
        // 被拆开的镜头：原提示词对应整段镜头，拆开后作废；素材选择沿用；原视频记录清空（文件仍在磁盘）
        const refs = op && op.refs ? JSON.parse(JSON.stringify(op.refs)) : emptyRefs()
        dsts.forEach(di => {
          np[di] = { text: '', refs: JSON.parse(JSON.stringify(refs)) }
          nv[di] = { files: [], cur: -1, confirmed: false, res }
        })
      })
      this.shots = pv.shots
      this.prompts = np
      this.vstate = nv
      this.syncSlots()
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      this.$root.toast('已自动补镜：' + before + ' → ' + pv.shots.length + ' 镜（+' + pv.added +
        '），秒数按各段落声明贴回；拆出的画面可点「AI 重写」补写')
    },
    /**
     * 让 AI 为拆出来的每一段重写「画面动作 / 镜头语言」。
     * 🔴 程序只采信 action 与 camera 两个字段：台词、场景、角色、时长一律以程序值为准，
     *    模型改了什么都不作数（幻觉风险从根上封死）。段数不符则整批放弃，不做部分采纳。
     */
    async rewriteSplit(i) {
      const idx = this.splitGroup(i)
      if (idx.length < 2 || this.rewriting) return
      const head = idx[0]
      const s0 = this.shots[head]
      const src = (s0._split || {}).src || s0
      this.rewriting = s0._split.gid
      const L = stepLog('拆分镜头重写')
      const t0 = Date.now()
      L.start('正在为拆分出的 ' + idx.length + ' 段重写画面（镜头 ' + (head + 1) + '~' + (idx[idx.length - 1] + 1) + '）')
      try {
        const system = await composeSystem({ specs: ['split.md'], mustHave: ['"shots"'], task: 'split' })
        // 只下发段位、台词、时长与待重写的画面；原始镜头供模型理解这段戏在讲什么
        const parts = idx.map((k, n) => ({
          n: n + 1,
          dialogue: String(this.shots[k].dialogue || ''),
          dur: this.shots[k].dur,
          action: String(this.shots[k].action || ''),
          camera: String(this.shots[k].camera || '')
        }))
        const user = await composeUser('split.md', {
          shot: JSON.stringify(src, null, 2),
          parts: JSON.stringify(parts, null, 2),
          n: idx.length
        })
        dbgPrompt('拆分镜头重写', '文字模型 · 镜头 ' + (head + 1) + ' 拆 ' + idx.length + ' 段', [['system', system], ['user', user]])
        const text = await window.studio.llmChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], { temperature: 0.7, maxTokens: 3072, json: true, stage: 'split', providerOverride: overrideOf('split'), label: '拆分镜头重写' })
        const parsed = JSON.parse(require_json(text))
        const list = Array.isArray(parsed) ? parsed : pickArr(parsed, ['shots', '镜头', '镜头列表'], new Set())
        if (!Array.isArray(list) || list.length !== idx.length) {
          throw new Error('模型返回 ' + (Array.isArray(list) ? list.length : 0) + ' 段，与拆分段数 ' + idx.length + ' 不符，本次结果已放弃')
        }
        idx.forEach((k, n) => {
          const s = this.shots[k]
          const r = list[n] || {}
          const act = String(r.action || '').trim()
          const cam = String(r.camera || '').trim()
          if (act) s.action = act
          if (cam) s.camera = cam
          s._rev = (s._rev || 1) + 1     // 分镜变了 → 本行提示词/视频的脏标记自动生效
          s._split.ai = true
        })
        await this.saveShots()
        L.done('拆分镜头的画面已重写：' + idx.length + ' 段（台词/时长未改动）', Date.now() - t0)
        this.$root.toast('已重写镜头 ' + (head + 1) + '~' + (idx[idx.length - 1] + 1) + ' 的画面；重新生成提示词后生效')
      } catch (e) {
        L.fail('拆分镜头的画面重写失败', Date.now() - t0, e)
        this.st.fail(e)
      } finally { this.rewriting = '' }
    },
    /** 撤回拆分：把这一组恢复成拆之前的那个镜头（原始内容快照存在每段自带的 _split.src 里） */
    async undoSplit(i) {
      const idx = this.splitGroup(i)
      if (idx.length < 2) return
      const head = idx[0], n = idx.length
      const snap = (this.shots[head]._split || {}).src
      if (!snap) return
      const back = JSON.parse(JSON.stringify(snap))
      back.dur = clampDur(back.dur)
      this.shots.splice(head, n, back)
      // 视频槽位：拆出来的段位（head+1 … head+n-1）丢弃，更靠后的整体前移 n-1
      const vs = {}
      Object.keys(this.vstate).map(Number).sort((a, b) => a - b).forEach(k => {
        if (k > head && k < head + n) return
        vs[k >= head + n ? k - (n - 1) : k] = this.vstate[k]
      })
      this.vstate = vs
      this.prompts.splice(head + 1, n - 1)
      this.syncSlots()
      await this.saveShots()
      await this.saveVideos()
      await this.savePrompts()
      this.$root.toast('已撤回拆分，恢复为镜头 ' + (head + 1) + '（该镜头的视频记录已清空，文件仍在磁盘）')
    },
    /** 该镜头场景名的档案体检文案（空串 = 没问题）；见 promptlib.sceneCardIssues */
    scWarnOf(name) { return (this.scIssues.byName || {})[String(name || '').trim()] || '' },
    /** 打开合并确认弹窗（i = 后镜下标；合并 i-1 与 i） */
    openMerge(i) { this.askMerge = i },
    /** 一键合并 i-1 与 i：确定性字段处理 + 复用 delShot 的下标位移（后续镜头全部继续有效） */
    async doMerge(i) {
      this.askMerge = null
      const a = this.shots[i - 1], b = this.shots[i]
      if (!a || !b) return
      const merged = mergeShotPair(a, b)
      merged._rev = (a._rev || 1) + 1   // 分镜变了 → 第 i 镜提示词/视频的脏标记自动生效
      this.shots.splice(i - 1, 2, merged)
      this.prompts.splice(i, 1)         // 提示词槽同步删后镜（i-1 槽保留，因 _rev 变化自动标脏）
      // vstate 以镜头下标为 key：删 i 槽、后续整体前移（与 delShot 同一套位移）
      const vs = {}
      Object.keys(this.vstate).map(Number).sort((x, y) => x - y).forEach(k => {
        if (k === i) return
        vs[k > i ? k - 1 : k] = this.vstate[k]
      })
      this.vstate = vs
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      this.$root.toast('已合并为镜头 ' + i + '，重新生成提示词后生效')
    },
    /**
     * 一键合并（2026-10-09）：把**所有**「可与上一镜合并」的相邻镜头一次并掉。
     * 判据与行内黄标完全同源（mergeWarnings + mergeShotPair，见 promptlib.mergeAllShots）——
     * 「界面标了什么」与「这个方法合掉什么」永远一致。
     * 槽位按 plan.map 重建：同一下标上取**靠前的那一镜**的提示词/视频记录（与逐镜合并同一套语义），
     * 被并掉那一镜的记录清空（磁盘文件仍在，见「重新生成分镜」才做归档）。
     *
     * 🔴 2026-10-09（Dragon）：**没有确认弹窗** —— 标题栏按钮、自检横幅按钮、生成后自检都直接调它。
     * 一次贪心扫描可能留下新的相邻可合并对（A|B|C 里 A-B、B-C 都满足时只会合掉一处），
     * 所以自动路径（generate）会按这个方法的返回值循环调用（≤3 轮），直到自检通过或无可合并。
     * @param {Object} [opts]
     * @param {boolean} [opts.auto] 自动路径：不弹 toast、不重复提示（由调用方统一汇总一条）
     * @returns {Promise<{before:number, after:number, count:number, durChanged:number}|null>} null = 无可合并
     */
    async mergeShotsAll(opts) {
      const auto = !!(opts && opts.auto)
      const before = this.shots.length
      const old = this.shots
      const plan = mergeAllShots(old)
      if (!plan.count) {
        if (!auto) this.$root.toast('没有可合并的相邻镜头（场景/角色一致、只有一方有台词、合计≤15s 才会合并）')
        return null
      }
      // 合并后把总时长贴回脚本各段秒数（与生成时同一套；没有段落时长的体裁原样跳过）。
      // keep：**合并前**被手改过的那一半 → 合并后的这一镜时长不参与重算。
      const keepNew = new Set()
      plan.map.forEach((dsts, oi) => { if (this.touched(old[oi])) keepNew.add((dsts && dsts[0]) || 0) })
      const units = storyUnits(this.adapted)
      let next = plan.shots
      let durChanged = 0
      if (units.hasSec) {
        const f = fitDurs(next, units.totalSec, (_s, i) => keepNew.has(i))
        next = f.shots
        durChanged = f.changed
      }
      // 合并产生的那几镜：分镜内容变了 → 打脏标（该行提示词/视频标记为已过期）
      for (const i of plan.merged) next[i]._rev = (Number((next[i] || {})._rev) || 1) + 1
      const oldP = this.prompts, oldV = this.vstate
      const np = [], nv = {}, seen = new Set()
      plan.map.forEach((dsts, oi) => {
        const di = (dsts && dsts[0]) || 0
        if (seen.has(di)) return          // 合进同一新下标的后续旧镜：提示词/视频记录丢弃
        seen.add(di)
        const ov = oldV[oi] || {}
        const res = ov.res || (this.st.current && this.st.current.res && this.st.current.res.vid) || '864x480'
        np[di] = oldP[oi] || { text: '', refs: emptyRefs() }
        nv[di] = Object.keys(ov).length ? ov : { files: [], cur: -1, confirmed: false, res }
      })
      this.shots = next
      this.prompts = np
      this.vstate = nv
      this.syncSlots()
      await this.saveShots()
      await this.savePrompts()
      await this.saveVideos()
      if (!auto) {
        this.$root.toast('已合并 ' + plan.count + ' 处：镜头 ' + before + ' → ' + next.length + ' 个' +
          (durChanged ? '，时长已贴回脚本 ' + units.totalSec + 's（改动 ' + durChanged + ' 个）' : '') +
          '；合并后的镜头带脏标，重新生成提示词后生效')
      }
      return { before, after: next.length, count: plan.count, durChanged }
    },
    /** 连续性状态的 tooltip / 是否显示「状态」小胶囊（空串 = 该镜没写快照，不显示） */
    contTip(i) {
      const s = this.shots[i] || {}
      const c = String(s.continuity || '').trim()
      const g = String(s.change || '').trim()
      return [c, g ? '变化：' + g : ''].filter(Boolean).join('\n')
    },
    /** 打开连续性状态编辑弹窗（点击行内的「状态」胶囊；行高固定 491px，编辑只能走弹窗） */
    openCont(i) {
      const s = this.shots[i] || {}
      this.contForm = { continuity: String(s.continuity || ''), change: String(s.change || '') }
      this.contEdit = i
    },
    async saveCont() {
      const i = this.contEdit
      this.contEdit = null
      if (i === null || !this.shots[i]) return
      const s = this.shots[i]
      s.continuity = String(this.contForm.continuity || '').trim()
      s.change = String(this.contForm.change || '').trim()
      this.touchShot(s)
      await this.saveShots()
      this.$root.toast('已保存镜头 ' + (i + 1) + ' 的连续性状态')
    },
    /* 2026-10-10（Dragon）：原 genTextV（视频区下方的「生成中 已用 X / 耗时 X」胶囊）已移除 ——
       本区下方只留脏标记；每一版视频自己的生成耗时改显示在它的播放框右上角（vidList 的 ms）。 */
    curVideo(i) {
      const s = this.vstate[i]
      return s && s.cur >= 0 ? s.files[s.cur] : null
    },
    /** 当前选中版本的下标（默认 = 最新一版） */
    curIdx(i) { return (this.vstate[i] || {}).cur ?? -1 },
    /** 视频区展示的版本列表：最多显示最新 2 个（带上在 files 里的真实下标 + 这一版自己的耗时文案）。
        🔴 耗时在这里就格式化成 msText —— fmtMs 是 import 的纯函数，Options API 的模板里访问不到
        （实测渲染层报 `t.fmtMs is not a function`，整块 zone-3 渲染失败）。 */
    vidList(i) {
      const s = this.vstate[i]
      if (!s || !s.files.length) return []
      const fm = s.fileMs || {}
      return s.files.map((f, k) => {
        const ms = fm[f] || 0
        return { f, k, ms, msText: ms ? fmtMs(ms) : '' }
      }).slice(-2)
    },
    /** 视频区固定 2 个槽位（长度恒为 2）：无视频时第 1 槽 null → 显示「待生成」占位，
        只有 1 个视频时第 2 槽 null → 留空（份高、行高都不跳动） */
    slotList(i) {
      const vs = this.vidList(i)
      return [vs[0] || null, vs[1] || null]
    },
    /** 点击某个视频 → 选为当前版本 = 采用（无独立采用/取消采用按钮，点谁选谁） */
    async setVideo(i, k) {
      const s = this.vstate[i]
      if (!s || s.cur === k) return
      s.cur = k
      s.confirmed = true
      await this.saveVideos()
    },
    /**
     * 视频框点击：点画面 = 选中该版本；点原生控制条（播放/进度/音量…）= 不拦截。
     * 🔴 不再用遮挡层硬编码 42px 预留控制条 —— 实测这版 Chromium 的控制条更高，
     * 遮挡层下缘正好切在播放键中间（点播放键上半截没反应）。改为按点击纵坐标判断：
     * 底部 CTRL_PX 像素内一律视为控制条操作；原生控件若不冒泡事件则本处理器根本不触发，两种情况都正确。
     */
    boxClick(e, i, k) {
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientY >= r.bottom - 64) return
      this.setVideo(i, k)
    },
    /** 路径 → 文件名（Windows / 通用分隔符都兼容） */
    baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() },
    /** 视频卡片上的素材一行字：用了什么、什么模式 */
    refsText(ru) {
      const bits = []
      if ((ru.images || []).length) bits.push('参考图×' + ru.images.length + '：' + ru.images.map(f => this.baseName(f)).join('、'))
      if ((ru.videos || []).length) bits.push('参考视频×' + ru.videos.length + '：' + ru.videos.map(f => this.baseName(f)).join('、'))
      if (ru.first) bits.push('首帧：' + this.baseName(ru.first))
      if (ru.last) bits.push('尾帧：' + this.baseName(ru.last))
      return (bits.length ? bits.join(' ｜ ') : '无参考素材') + '（' + (ru.mode || '?') + '）'
    },
    /** hover 提示：完整路径，逐行一个 */
    refsTitle(ru) {
      return [...(ru.images || []), ...(ru.videos || []), ru.first, ru.last].filter(Boolean).join('\n')
    },
    videoSrc(file) {
      // key 用绝对路径（含项目/集数目录），不同集之间的 shot_1.mp4 不会互相串
      const abs = joinPath(this.st.current ? this.st.current.shotDir : '', file)
      if (this._b64[abs] !== undefined) return this._b64[abs]
      this._b64[abs] = ''
      window.studio.readFileBase64(abs).then(b64 => {
        this._b64[abs] = b64 ? 'data:video/mp4;base64,' + b64 : ''
      })
      return ''
    },
    /**
     * 只保留最近 B64_KEEP 个视频缓存（其余释放掉，下次预览再读盘）+ 参考视频同理。
     * 🔴 只能在「非渲染路径」调用（生成完成 / 换集）：`videoSrc` 是模板里的函数，
     * 若在那里改动响应式数据会触发「渲染 → 改数据 → 再渲染」的死循环（曾表现为点击后整屏卡住）。
     * 对象 key 天然保插入顺序，直接用 key 顺序当 LRU。
     */
    pruneB64() {
      try {
        for (const [box, keep] of [[this._b64, B64_KEEP], [this._refv, REFV_KEEP]]) {
          const keys = Object.keys(box)
          while (keys.length > keep) delete box[keys.shift()]
        }
      } catch (_) { /* 清理失败不影响主流程 */ }
    },
    async saveVideos() {
      if (!this.canSave()) return
      // _gen / _genAt 是纯 UI 状态，不落库
      const clean = {}
      Object.keys(this.vstate).forEach(k => {
        const v = { ...this.vstate[k] }
        delete v._gen; delete v._genAt
        clean[k] = v
      })
      await this.st.saveArtifact('videoState', clean)
    },
    async genV(i, ctx) {
      const s = this.shots[i]
      const pr = ((this.st.current.prompts || [])[i] || {})
      const prompt = pr.text
      if (!prompt) { this.st.fail(new Error('镜头 ' + (i + 1) + ' 缺少 ' + this.promptZoneName() + '，请先生成本镜头的提示词')); return false }
      // 参考素材全部来自本行该镜头的设置（可不选）
      // 🔴 2026-10-14：与提示词**同一份**过滤结果（按本镜 chars / scene）
      //    —— 否则提示词里的 <Picture N> 与实际注入 ComfyUI 的图对不上。
      // 🔴 来源必须是 `pr.refs`（store 权威副本，和上面取 `pr.text` 同一个对象），
      //    不能用组件本地副本 this.prompts[i] —— 那只是编辑态，别块直接写库时它还是旧的。
      const eff = this.effRefs(i, pr.refs)
      const refImages = eff.images
      const refVideos = eff.videos
      const firstFrame = eff.first
      const lastFrame = eff.last
      const hasRef = refImages.length > 0 || refVideos.length > 0
      // 能力降级兜底：当前视频方案明确不支持某种素材时，在这里拦住并说清出路，
      // 而不是把它塞进工作流让 ComfyUI 报一堆看不懂的节点错误（入口本身也会被隐藏）。
      const caps = this.caps || {}
      const bad = []
      if (refImages.length && caps.refImage === false) bad.push('参考图')
      if (refVideos.length && caps.refVideo === false) bad.push('参考视频')
      if (firstFrame && caps.firstFrame === false) bad.push('首帧')
      if (lastFrame && caps.lastFrame === false) bad.push('尾帧')
      if (bad.length) {
        this.st.fail(new Error('当前视频模型不支持：' + bad.join('、') +
          '。请到「设置 → 生成模型方案」换一个支持它们的模型，或去掉本镜头的这些素材后再生成。'))
        return false
      }
      // 记录本次生成所属的集（收尾写库守卫的比对基准；切集哨兵 'SWITCHED' 不覆盖）
      if (this._busyEpId !== 'SWITCHED') this._busyEpId = this.st.current && this.st.current.id
      this.vBusy = true
      if (!this.vstate[i]) this.vstate[i] = { files: [], cur: -1, confirmed: false }
      this.vstate[i]._gen = true
      this.vstate[i]._genAt = Date.now()   // 「生成中 已用 X」的起点
      const t0 = Date.now()
      this.pl.beginGen(5)
      const L = stepLog('阶段6 H3视频')
      const prog = ctx ? '（第 ' + ctx.n + '/' + ctx.total + ' 个）' : ''
      const mode = hasRef ? '参考模式' : (firstFrame || lastFrame ? '首尾帧模式' : '纯文字模式')
      const inputs = []
      if (firstFrame) inputs.push('首帧')
      if (lastFrame) inputs.push('尾帧')
      if (refImages.length) inputs.push('参考图×' + refImages.length)
      if (refVideos.length) inputs.push('参考视频×' + refVideos.length)
      const dur = this.durOf(i)
      const resStr = this.resOf(i)
      const [rw, rh] = parseRes(resStr)
      L.start('正在生成视频：镜头 ' + (i + 1) + prog + '（' + dur + 's · ' + rw + 'x' + rh +
        ' · ' + resLabel(this.optsFor(i), resStr) +
        ' · ' + mode +
        (inputs.length ? ' · ' + inputs.join('+') : '') + ' · 本地推理，每镜头数分钟）')
      try {
        const dir = this.st.current.shotDir   // <项目>/分镜/<集>/
        // ⚠️ 必须转纯对象再送 IPC：refs 里的数组来自响应式 store（Vue Proxy），
        // Proxy 无法结构化克隆，直接传会抛「An object could not be cloned.」
        const params = JSON.parse(JSON.stringify({
          prompt, firstFrame, lastFrame, refImages, refVideos,
          width: rw, height: rh,
          seconds: dur,               // 秒数按分镜脚本该镜头的 dur（主进程对齐到 17k+5 帧网格）
          projectId: this.st.current.projectId   // 视频档位是项目级设置，由主进程按它实时读库
        }))
        dbgPrompt('阶段6 H3视频', '视频模型 · 镜头' + (i + 1), [
          ['prompt', prompt],
          ['time/size', dur + 's · ' + rw + 'x' + rh + '（' + resLabel(this.optsFor(i), resStr) + '）· ' + mode],
          ['refs', inputs.length ? inputs.join(' + ') : '无（纯文字生成）'],
          ['firstFrame', firstFrame || ''],
          ['lastFrame', lastFrame || ''],
          ['refImages', refImages.join('\n')],
          ['refVideos', refVideos.join('\n')]
        ])
        const r = await window.studio.comfyGenerate({
          templateKey: 'video', dir, baseName: this.epPrefix + '_shot_' + (i + 1),
          params,
          label: '阶段6 H3视频'
        })
        const ms = Date.now() - t0
        this.vstate[i].files = [...this.vstate[i].files, ...r.files]
        // 每一版各自记一份生成耗时（2026-10-10）：显示在该版播放框右上角；
        // 超出 4 版上限被 shift 掉的旧版，连带清掉它的耗时记录（否则 fileMs 会无限增长）
        const fm = this.vstate[i].fileMs || (this.vstate[i].fileMs = {})
        r.files.forEach(f => { fm[f] = ms })
        while (this.vstate[i].files.length > 4) {
          const gone = this.vstate[i].files.shift()
          if (gone && fm[gone]) delete fm[gone]
        }
        this.vstate[i].cur = this.vstate[i].files.length - 1
        this.vstate[i].confirmed = true   // 最新生成默认「采用」（点选其它版本即切换选中，无独立采用按钮）
        this.vstate[i].genMs = ms             // 整镜头「最近一次」的耗时（videos.json 持久化）
        // 素材快照：把「这一版视频实际用了哪些参考素材」记下来，行上直接可见
        this.vstate[i].refsUsed = { mode, images: refImages.slice(), videos: refVideos.slice(), first: firstFrame, last: lastFrame }
        // 🔴 记签名前先取一次最新指纹（同提示词的道理）：这一版视频到底用了磁盘上哪几张图
        await this.refreshAsig()
        this.vstate[i]._sig = this.curVideoSig(i)   // 记录生成时的上游签名（提示词/分镜/素材版本 + 顺序/内容）
        this.vstate[i]._ack = null                  // 重新生成即视为已处理
        delete this.vstate[i]._genAt
        this.pruneB64()                      // 只在非渲染时机清缓存（防渲染死循环）
        await this.saveVideos()
        // 本镜重新出片 → 下一个镜头若续接过本镜末帧，那个首帧就过期了（只查下一个）
        if (i + 1 < this.shots.length) await this.refreshFrameStale(i + 1)
        this.pl.markGen(5, ms)
        this.st.invalidateMedia(this.epProjectId, 'shots')   // 左侧树「分镜」下次展开刷新
        L.done('镜头 ' + (i + 1) + ' 视频生成完成：' + r.files.join('、'), ms)
        this.$root.toast('镜头 ' + (i + 1) + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        // 用户点了「停止生成」→ 这不是失败：走「已停止」提示，批量循环靠 'canceled' 结束整批
        if (/已停止生成|已取消/.test(String((e && e.message) || e))) {
          L.warn('镜头 ' + (i + 1) + ' 视频生成已停止' + prog)
          this.$root.toast('镜头 ' + (i + 1) + '：已停止生成')
          return 'canceled'
        }
        L.fail('镜头 ' + (i + 1) + ' 视频生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally { delete this.vstate[i]._genAt; delete this.vstate[i]._gen; this.vBusy = false; this.pl.endGen(5); if (!this.pBusy) this._busyEpId = null }
    },
    /** 批量生成视频：all=true 全部重生成（新版本追加，旧版保留可切换）；false 只补没有任何视频文件的镜头。
     *  入口 batchVideos() 已保证全部镜头都有提示词；此处再逐个保险校验 */
    async runBatchV(all) {
      const L = stepLog('阶段6 H3视频')
      const idx = []
      for (let i = 0; i < this.shots.length; i++) {
        if (!(this.prompts[i] && this.prompts[i].text.trim())) continue   // 保险：缺提示词的跳过
        const s = this.vstate[i]
        if (all || !(s && s.files.length)) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成的镜头'); return }
      this.batchV = true; this.batchVStop = false; this.vBusy = true
      this.batchVN = 0; this.batchVTotal = idx.length
      L.start('开始批量生成视频（' + (all ? '全部重生成，新版本追加' : '只补没有视频的镜头') + '）：待生成 ' + idx.length + ' 个（共 ' + this.shots.length + ' 个镜头）；预计总耗时较长，可随时点「停止生成」立刻中断')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchVStop) { stopped = true; break }
          this.batchVN = k + 1
          const okFlag = await this.genV(idx[k], { n: k + 1, total: idx.length })
          if (okFlag === 'canceled') { stopped = true; break }   // 用户强停：这一镜不计成功也不计失败
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成视频已停止' : '批量生成视频结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各镜头失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchV = false; this.batchVStop = false; this.vBusy = false
        this.batchVN = 0; this.batchVTotal = 0
        if (!this.pBusy) this._busyEpId = null
        // 批量出片后重算一遍首帧过期标记（逐镜出片时只查了各自的下一个，停止/失败会漏）
        this.refreshFrameStale()
      }
    },
    async confirmOne(i) {
      if (!this.vstate[i] || this.vstate[i].cur < 0) return
      this.vstate[i].confirmed = true
      await this.saveVideos()
      this.$root.toast('镜头 ' + (i + 1) + ' 已采用')
    },
    async unconfirm(i) {
      this.vstate[i].confirmed = false
      await this.saveVideos()
    },
    async confirmVideos() {
      await this.saveVideos()
      this.pl.confirm(5, this.st.current.id)
      this.$root.toast('视频全部采用，进入组装')
    }
  }
}

function emptyRefs() { return { images: [], videos: [], first: null, last: null } }

function require_json(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : text
  const start = raw.search(/[[{]/)
  if (start < 0) throw new Error('LLM 输出中未找到 JSON')
  // 切到最后一次闭合括号，容忍 JSON 后面的多余文字
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'))
  return raw.slice(start, end > start ? end + 1 : undefined)
}
/** 兼容两种返回：裸数组，或（JSON 对象模式下的）按 key 解析；used 记录已取用的键避免误取 */
function pickArr(v, keys, used) {
  if (Array.isArray(v)) return v
  if (!v || typeof v !== 'object') return null
  for (const k of keys) if (Array.isArray(v[k])) { used.add(k); return v[k] }
  const rest = Object.keys(v).filter(k => Array.isArray(v[k]) && !used.has(k))
  if (rest.length === 1) { used.add(rest[0]); return v[rest[0]] }
  return null
}
/** 场景名兜底：空 或 "同上/相同/一致…" → 用上一个镜头的场景名 */
function fixSceneName(v, prev) {
  const s = String(v == null ? '' : v).trim()
  if (!s || /同上|如上|一样|相同|同上场景/.test(s) || s === '一致') return prev || '未命名场景'
  return s
}
/** 档案归一化：字符串/对象都能吃，统一成 {kind,name,role,profile,prompt,negative,candidates,cur,res,_imgRev} */
function normArchive(list, kind) {
  const out = []
  for (const raw of list || []) {
    const o = (typeof raw === 'string') ? { name: raw } : (raw || {})
    const name = String(o.name || o.title || '').trim()
    if (!name) continue
    out.push({
      kind,
      name,
      role: kind === 'scene' ? (o.role || '场景') : (o.role || '配角'),
      // 档案：模型给的对象/数组统一成「字段名：值」行文本（卡片上直接可编辑）
      profile: normalizeProfile(o.profile || o.档案 || ''),
      _profRev: o._profRev || 0,
      _profRevAt: o._profRevAt || 0,
      prompt: String(o.prompt || o.promptEn || o.desc || '').trim(),
      negative: o.negative || '',
      candidates: Array.isArray(o.candidates) ? o.candidates.slice() : [],
      cur: typeof o.cur === 'number' ? o.cur : -1,
      res: o.res || '',
      genMs: o.genMs || 0,
      _imgRev: o._imgRev || 1
    })
  }
  return out
}
/**
 * 本次生成结果 + 旧条目里的**豁免项** = 新的档案列表（2026-10-09，Dragon）。
 *
 * 语义：**重新生成分镜 = 从零重来**，本次结果就是唯一事实来源 ——
 *   - 旧档案一律不继承（**同名也不继承**）：档案内容按本次结果、已出的图归零、单卡提示词重算。
 *     所以这里不再有「同名合并」那套（旧版 mergeArchive 把 candidates / cur / _imgRev 从旧条带过来，
 *     后果是「点完重新生成分镜，卡片上还是上一批的图」，与「下游全部清空」直接冲突）。
 *   - 只有两类旧条目留下（都是**用户自己造的**，不在模型产出里）：
 *     ① 手动新增的卡 `_manual`（用户加完还要自己「写入镜头」，丢掉等于把手工活清了）
 *     ② 从项目库导入的只读副本卡 `libReadonly` / `libId`（图在跨集共享目录里，卡片消失用户得重新导入）
 *   同名时以本次结果为准（不去重会得到两张同名卡 → 图片目录撞键）。
 *
 * @param {Array} list 本次生成出来的档案（已过 normArchive）
 * @param {Array} olds 已有档案
 */
function buildArchive(list, olds) {
  const out = []
  const seen = new Set()
  const fallbackKind = (list && list[0] && list[0].kind) || 'character'
  for (const it of (list || [])) {
    if (!it || !it.name) continue
    seen.add(it.name)
    out.push(it)
  }
  for (const o of (olds || [])) {
    if (!o || !o.name || seen.has(o.name)) continue
    if (o._manual !== true && o.libReadonly !== true && !o.libId) continue
    seen.add(o.name)
    out.push({ kind: o.kind || fallbackKind, ...o })
  }
  return out
}

/**
 * 「要归档的旧素材」清单：旧档案里**除豁免项外**的**全部**条目（2026-10-09，Dragon）。
 *
 * 🔴 与旧版的区别：**不再按「本次结果里有没有」过滤** —— 重新生成分镜 = 下游全部清空，
 *    同名的角色/场景也照样归档（卡片图归零、重新出图）；旧版留着同名图，用户看到的
 *    就是「点完重新生成，卡片上还是上一批的图」。
 *
 * 为什么要筛（归档是物理移动图片目录，误伤不可逆）：
 *  - 库条目（libReadonly / libId）的图在**跨集共享**目录里，挪走会连累别的集 → 一律排除
 *  - 手动新增的卡（_manual）本就被 buildArchive 豁免，不会出现在这里，这里再兜一层
 *
 * @returns {Array<{kind:string, name:string}>} 交给主进程逐个名字归档（没出过图的后端会静默跳过）
 */
function orphanAssets(oldEp) {
  if (!oldEp) return []
  const out = []
  const push = (kind, o) => {
    if (!o || !o.name) return
    if (o._manual) return                                  // 手动加的卡不归档（buildArchive 也豁免了它）
    if (o.libReadonly === true || o.libId) return          // 库条目的图是跨集共享的，绝不能动
    out.push({ kind, name: o.name })
  }
  for (const c of (oldEp.chars || [])) push('character', c)
  for (const s of (oldEp.scenes || [])) push('scene', s)
  return out
}
</script>
