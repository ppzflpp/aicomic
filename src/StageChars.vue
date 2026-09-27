<template>
  <div>
    <div v-if="busy || shotsGening" class="progress"><div class="bar indeterminate"></div></div>
    <div v-if="!busy && !shotsGening && !cards.length" class="placeholder">确认分镜后，从分镜中自动提取角色与场景（含各自的档案与美术提示词）。</div>

    <!-- 单一网格：先摆角色、再摆场景，末尾常驻三张「新增入口」虚线卡；卡片左右结构（左：大图+档案 / 右：提示词 → 参数），无锁定随时可编辑
         脏标签（改编稿改过 → 建议重新出图）统一显示在本模块标题后面，见 App.vue 的 stage-head -->
    <div class="grp">
      <div class="char-grid">
        <div v-for="it in ordered" :key="it.c.kind + '|' + it.c.name" class="ccard"
             :class="[it.c.kind, { 'card-busy': it.c._gen, 'lib-ro': isLibRo(it.c) }]">
          <span v-if="it.c._gen" class="busy-txt"><i class="spin"></i>正在生成…</span>

          <!-- 左：大预览图（按原图比例完整显示）+ 图上角标（名称 / 定位 两枚独立徽标、分辨率） -->
          <div class="cleft">
            <div class="bigprev">
              <img v-if="selFile(it.c)" :src="imgSrc(absOf(it.c, selFile(it.c)))"
                   :title="'点击放大预览（' + it.c.name + '）'" @click="previewImg(it)" />
              <div v-else class="ph">{{ it.c.name[0] }}</div>
              <!-- 角标：名称、定位各一枚独立徽标（分开显示，不拼成一串）。
                   场景卡的定位恒为「场景」（与卡片类型、下方「场景档案」标题重复）→ 只显示名称徽标 -->
              <div class="kind-wrap">
                <span class="kind-tag-pos" :class="it.c.kind">{{ it.c.name }}</span>
                <span v-if="it.c.kind !== 'scene' && it.c.role" class="role-tag-pos" :class="it.c.kind">{{ it.c.role }}</span>
              </div>
              <span v-if="dimOf(it.c)" class="dim-tag" title="当前预览图片的实际分辨率">{{ dimOf(it.c) }}</span>
              <!-- 参考图背景检查：角色图带环境 → 视频会跟着泄漏环境（实测已发生），提示但不拦 -->
              <span v-if="bgWarn(it.c)" class="bg-warn"
                    title="这张角色图的背景不是纯色（含场景 / 建筑 / 道具）。角色图会作为参考图喂给视频模型，背景会被一起学进视频（实测：竹林戏里角色图的庭院背景被画进了画面）。建议重出一张纯色中灰背景的单人图。">
                ⚠ {{ bgWarn(it.c) }}
              </span>
              <!-- 库来源徽标：从项目库加载的卡（只读）／已同步到项目库的本地卡 -->
              <span v-if="isLibRo(it.c)" class="lib-badge ro"
                    title="这张卡来自项目角色场景库：文案、提示词、分辨率与出图都不在这里改（在左侧「项目角色场景库」里统一修改）。想改成本集专属版本，先「另存为本集变体」。">
                📚 从项目库加载 · 禁止修改
              </span>
              <span v-else-if="it.c.libId" class="lib-badge ok"
                    title="这张卡是本集自己的副本，已同步到项目库；在这里改是改本集，点「更新到项目库」才会推回库（会影响引用该角色的其它集）。">
                📚 已同步到项目库
              </span>
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

            <!-- 档案（提示词的唯一依据，可手改）：与大预览同列（图下）；
                 改动 → 脏标记「档案已改 · 提示词待更新」→ 点标题右侧的刷新图标按新档案重算 -->
            <div class="f pf-box">
              <div class="pf-head">
                <label>{{ it.c.kind === 'scene' ? '场景档案' : '角色档案' }}</label>
                <span style="flex:1"></span>
                <span v-if="profStale(it.c)" class="stale" title="档案改动后提示词还没重算；点这里先消除提示"
                      @click="ackProfile(it.i)">档案已改 · 提示词待更新</span>
              </div>
              <textarea v-model="it.c.profile" :rows="it.c.kind === 'scene' ? 5 : 7"
                        :readonly="isLibRo(it.c)"
                        placeholder="档案：每行一个字段「字段名：值」（来自剧本提取，可手工修改）…"
                        @change="touchProfile(it.c)"></textarea>
            </div>
          </div>

          <!-- 右：正向/负向提示词 → 小预览图 → 分辨率 → 生图按钮（固定右下角）
               链路：档案 → 刷新提示词 → 生图；三级都随时可编辑 -->
          <div class="cright">
            <div class="f ta-prompt">
              <!-- 标题行：正向提示词 + 右侧「刷新提示词」图标（按本卡档案重算正/负向提示词，会覆盖当前值） -->
              <div class="ta-head">
                <label>正向提示词</label>
                <span style="flex:1"></span>
                <!-- 删除整张卡（2026-09-27：从底部操作行挪到标题行、放在刷新图标左边，只显示图标不带文字）：
                     档案与提示词一起删，已生成的图片文件保留在项目 assets 下 -->
                <button class="del-btn head-x" :disabled="busy"
                        title="删除这张卡：档案与提示词会一起删掉（图片文件保留在 项目/assets 下，可用缩略图上的 ✕ 单独清理）"
                        @click="askDelCard(it.c)">✕</button>
                <button class="btn icon" :class="{ regen: it.c._profRevAt > 0 }"
                        :disabled="busy || isLibRo(it.c) || !String(it.c.profile || '').trim()"
                        title="刷新提示词（按本卡档案重新生成正向 / 负向提示词，会覆盖当前提示词，之后仍可手改）"
                        @click="genPromptFromProfile(it.i)">
                  <span v-if="it.c._pgGen" class="busy-txt"><i class="spin"></i></span>
                  <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
                  </svg>
                </button>
              </div>
              <textarea v-model="it.c.prompt" rows="5" :readonly="isLibRo(it.c)" placeholder="正向提示词"
                        @change="saveAll()"></textarea></div>
            <div class="f ta-neg"><label>负向提示词</label>
              <textarea v-model="it.c.negative" rows="3" :readonly="isLibRo(it.c)" placeholder="负向提示词"
                        @change="saveAll()"></textarea></div>

            <!-- 小预览图（抽卡记录，最多显示最新 4 张；点击选中作图生图底图，✕ 删除） -->
            <div class="f"><label>小预览图 <span class="hint" style="font-size:10px">点击选中为图生图底图</span></label>
              <div class="thumbs" v-if="it.c.candidates.length">
                <div v-for="t in shown(it.c)" :key="t.i" class="thumb-wrap">
                  <img :src="imgSrc(absOf(it.c, t.f))" :class="{ cur: t.i === it.c.cur }"
                       title="点击选中／再点一次取消选中" @click="pick(it.c, t.i)" />
                  <button v-if="!isLibRo(it.c)" class="img-x" title="删除这张图" @click.stop="askDel(it.c, t.i)">✕</button>
                </div>
              </div>
              <div v-else class="hint" style="font-size:11px">尚未出图</div>
            </div>

            <label class="card-res">分辨率
              <select v-model="it.c.res" :disabled="busy || isLibRo(it.c)" @change="saveAll()">
                <option v-for="o in optsFor(it.c)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>

            <!-- 库操作 + 一键填充（次级功能：绿色） -->
            <div class="cops fill-row">
              <button class="btn sec sm" :disabled="busy || !selFile(it.c)"
                      :title="'把当前选中的这张图填到所有包含「' + it.c.name + '」的镜头的参考图区（只填参考图，不动首尾帧）'"
                      @click="fillRefs(it.i)">
                一键填充
              </button>
              <!-- 本集新增卡 → 保存到项目库；已入库的本地卡 → 更新到项目库 -->
              <button v-if="!it.c.libId" class="btn sec sm" :disabled="busy"
                      title="把这张卡（档案 + 正负提示词 + 已选中的图 + 分辨率）打包保存到项目角色场景库，供其它集复用"
                      @click="saveToLib(it.c)">
                保存到项目
              </button>
              <button v-else-if="!isLibRo(it.c)" class="btn sec sm" :disabled="busy"
                      title="把本集的改动推回项目库（库版本 +1；引用该条目的其它集会提示重新生成）"
                      @click="updateToLib(it.c)">
                更新到项目库
              </button>
              <!-- 只读卡：库里存在同基础名的多张卡时，允许切换（系统判错时的纠正出口） -->
              <label v-if="isLibRo(it.c) && libVariantsOf(it.c).length > 1" class="lib-switch"
                     title="库里存在同基础名的多张卡（如 李白-少年 / 李白-老年）。系统自动选的可能不对，可在这里换成正确的那张。">
                <select :value="it.c.libId" :disabled="busy" @change="switchVariant(it.c, $event.target.value)">
                  <option v-for="v in libVariantsOf(it.c)" :key="v.id" :value="v.id">{{ v.name }}</option>
                </select>
              </label>
              <!-- 把这张卡写进本集镜头的 chars 字段（手动新增的卡否则不会出现在任何镜头的参考图里） -->
              <button class="btn ghost sm" :disabled="busy || !(ep && ep.shots && ep.shots.length)"
                      title="把「本集有谁」写进选定镜头的 chars 字段：只有写进去，这张卡的图才会在一键填充 / H3 生成时被挂上"
                      @click="openWriteShots(it.c)">
                写入镜头…
              </button>
              <!-- 「删除卡」已挪到上方「正向提示词」标题行（2026-09-27） -->
            </div>

            <!-- 出图耗时挪到「生图」按钮左边 -->
            <div class="ops-row">
              <span v-if="genText(it.c)" class="gen-ms" :class="{ live: it.c._genAt }">{{ genText(it.c) }}</span>
              <button class="btn sm" :class="{ regen: it.c.refAsBase && it.c.cur >= 0 }" :disabled="busy || isLibRo(it.c)" @click="gen(it.i)">
                {{ it.c.refAsBase && it.c.cur >= 0 ? '图生图' : '文生图' }}
              </button>
            </div>
          </div>
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
      <button class="btn sm" :class="{ regen: !batchP && !batchPStop && cards.some(c => String(c.profile || '').trim()), danger: batchP || batchPStop }"
              :disabled="batchPStop || batchI"
              :title="batchP ? '点击停止：当前条目跑完后，剩余条目不再执行' : '按档案批量重新生成提示词，或只处理档案有变动 / 还没有提示词的条目'"
              @click="batchPrompts">
        <span v-if="batchPStop" class="busy-txt"><i class="spin"></i>停止中…</span>
        <span v-else-if="batchP">停止批量({{ batchPN }}/{{ batchPTotal }})</span>
        <span v-else>批量生成提示词</span>
      </button>
      <button class="btn sm" :class="{ regen: !batchI && !batchIStop && cards.some(c => c.candidates.length), danger: batchI || batchIStop }"
              :disabled="batchIStop || batchP"
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
        </div>
        <input type="text" v-model="askAdd.name" placeholder="例如：张伯 / 李白-少年"
               @keyup.enter="doAdd" style="margin:8px 0" />
        <div class="modal-ops">
          <span style="flex:1"></span>
          <button class="btn ghost" @click="askAdd = null">取消</button>
          <button class="btn" :disabled="!String(askAdd.name || '').trim()" @click="doAdd">新增</button>
        </div>
      </div>
    </div>

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
          <div style="margin-top:6px">· 已生成的<b>图片文件仍保留</b>在 项目/assets/ 下（要清磁盘请在缩略图上点 ✕）。</div>
          <div style="margin-top:6px">· 项目角色场景库里的<b>同名条目不受影响</b>（要删库条目请在左侧库里操作）。</div>
          <div v-if="askCard.used" style="margin-top:6px;color:#fcd34d">
            ⚠ 分镜里还有 <b>{{ askCard.used }}</b> 个镜头在用这个名字，删掉后这些镜头在此处就没有对应卡了。
          </div>
        </div>
        <div class="modal-ops">
          <button class="btn danger" @click="doDelCard()">删除卡片</button>
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
import {
  readPrompt, parseFallbacks, pickFallback, section, ensureSceneKeeper, composeSystem, composeUser,
  normalizeProfile, profileDirty, profileBrief, equipmentWords, stripEquipmentWords
} from './prompts.js'
import { sceneCardIssues } from './promptlib.js'

// 🔴 生图环节的三份兜底（负向词表 / 空镜必备句 / 生图模板）全部来自项目规范 md
//    —— chars.md 的「## 兜底默认」（主人公 / 配角 / 负向）与 scenes.md 的「## 兜底默认」/「## 空镜必备句」，
//    由 fallbackTemplates() 在每次载入时刷新。代码不再内置任何提示词文案。
//    这三个名字保持模块级可变，是为了让下面各处引用零改动地复用（读不到时为空串 = 不补）。
let DEFAULT_NEG = ''
let SCENE_KEEPER_DEFAULT = ''
let FALLBACK_TPL = { hero: '', npc: '', scene: '' }
let EQ_WORDS = []   // 器材词表（scenes.md「器材词:」行）：生图发送前剥掉命中短语，防器材被画进画面
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
    out.words = equipmentWords(smd)
    if (!out.negative) out.negative = pickFallback(parseFallbacks(smd), ['负向', 'negative'])
  } catch (_) { /* 读不到就留空 */ }
  // 回写给模块级变量，让上面那些同步引用复用（新建卡片时的默认提示词 / 负向、生图时的空镜句）
  DEFAULT_NEG = out.negative
  SCENE_KEEPER_DEFAULT = out.keeper
  FALLBACK_TPL = { hero: out.hero, npc: out.npc, scene: out.scene }
  EQ_WORDS = out.words || []
  return out
}

export default {
  name: 'StageChars',
  data() {
    return {
      cards: [], busy: false, _b64: {}, _dims: {}, ask: null, _keeper: SCENE_KEEPER_DEFAULT,
      // 参考图背景检查结果缓存（绝对路径 → 四角最大通道差；0 未算出 / -1 读失败 / >阈值 = 背景非纯色）
      _bg: {},
      // 批量任务（块 2 标题行的两个按钮）：
      //   batch*=队列在跑；*Stop=已点停止等当前条目收尾；askBatch=范围选择弹窗
      //   batch*N/Total=按钮上的进度（正在处理第 N 个 / 共 Total 个），跑完/停止归零
      batchP: false, batchPStop: false, batchPN: 0, batchPTotal: 0,
      batchI: false, batchIStop: false, batchIN: 0, batchITotal: 0,
      askBatch: null,
      // 项目角色场景库相关的四个弹窗：手动新增 / 从库导入 / 写入镜头 / 批量入库
      askAdd: null, askImport: null, askWrite: null, askLibSave: null,
      // 删除整张卡片的确认弹窗（与「删图」区分：删卡删档案与提示词，图片文件留在磁盘）
      askCard: null,
      // 「本集新增卡片是否入库」的询问去重键（同一个集的同一批卡片只问一次，避免每次重建都弹）
      _libAskFor: '',
      // 有生成在跑时 = 该次生成所属的集 id；切集时改置 'SWITCHED'（收尾写库守卫据此丢弃，防旧集数据写进新集）
      _busyEpId: null,
      // 🔴 Teleport 延迟挂载开关：切集时 <section :key> 整棵重建，mounted 前 #chars-batch 不在文档里
      tpReady: false
    }
  },
  computed: {
    st() { return useProjectStore() },
    pl() { return usePipeline() },
    ep() { return this.st.current },
    /** 单一网格的摆放顺序：先角色、后场景（同类内部保持原顺序），每项带上在 cards 里的真实下标 */
    ordered() {
      const rank = { character: 0, scene: 1 }
      return this.cards.map((c, i) => ({ c, i }))
        .sort((a, b) => ((rank[a.c.kind] || 0) - (rank[b.c.kind] || 0)) || (a.i - b.i))
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
      if (ep) this.init(ep)
    },
    // 🔴 各块常驻挂载（无锁定随时可见）：分镜/档案在别处生成后要立即反映到这里
    'st.current.chars'() { this.rebuildSoon() },
    'st.current.scenes'() { this.rebuildSoon() },
    'st.current.shots'() { this.rebuildSoon() },
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
        if (r.renamed) {
          card.name = r.entry.name
          this.$root.toast('库里已有同名条目，已存为「' + r.entry.name + '」；请核对分镜里的写法')
        } else {
          this.$root.toast('已保存到项目角色场景库：「' + card.name + '」')
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
      if (Array.isArray(e.images) && e.images.length) card.candidates = e.images.slice()
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
    /** 切换变体：把本集这张只读卡换成库里另一个条目（连带把分镜/对白里的旧名换掉、参考图路径改到新目录） */
    async switchVariant(c, id) {
      const ep = this.ep
      const card = this.liveCard(c)
      const e = this.libEntry(id)
      if (!ep || !card || !e || e.id === card.libId) return
      const oldName = card.name, newName = e.name
      const oldDir = this.dirOf({ kind: card.kind, name: oldName })
      const newDir = this.dirOf({ kind: card.kind, name: newName })
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
    /** 新增一张空白本集卡（名字手填，档案与提示词留空，之后照常补） */
    async doAdd() {
      const a = this.askAdd
      if (!a) return
      const name = String(a.name || '').trim()
      if (!name) return
      const kind = a.kind === 'scene' ? 'scene' : 'character'
      if (this.cards.some(c => c.kind === kind && c.name === name)) {
        this.$root.toast('本集已有同名' + (kind === 'scene' ? '场景' : '角色') + '卡'); return
      }
      this.askAdd = null
      const defRes = (this.ep && this.ep.res && this.ep.res.img) || '1216x832'
      this.cards.push({
        kind, name, role: kind === 'scene' ? '场景' : '配角',
        profile: '', _profRevAt: 0, _profRev: 0, _profAck: 0,
        prompt: '', negative: DEFAULT_NEG,
        promptMs: 0, promptAt: 0, candidates: [], cur: -1, res: defRes, genMs: 0,
        _imgRev: 1, libId: '', libRevAt: 0, libReadonly: false, _libAck: 0, _libRevNow: 0
      })
      await this.saveAll()
      this.$root.toast('已新增' + (kind === 'scene' ? '场景' : '角色') + '卡：「' + name + '」；记得用「写入镜头…」把它写进相关镜头')
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
        res: e.res || (this.ep && this.ep.res && this.ep.res.img) || '1216x832', genMs: e.genMs || 0,
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

      const tpl = await fallbackTemplates()
      this._keeper = tpl.keeper || SCENE_KEEPER_DEFAULT   // 场景图的空镜必备句（来自 scenes.md）

      // 项目角色场景库（命中即只读加载；主进程首次访问会自动迁移老项目）
      let lib = null
      try { lib = await this.st.loadLibrary(ep.projectId) } catch (_) { lib = null }
      const byName = new Map()
      for (const e of ((lib && lib.entries) || [])) byName.set(e.kind + '|' + e.name, e)
      const aligned = []

      const out = []
      for (const kind of ['character', 'scene']) {
        names[kind].forEach((name, idx) => {
          const old = byKey.get(kind + '|' + name) || {}
          const role = kind === 'scene' ? '场景' : (old.role || (idx === 0 ? '主人公' : '配角'))
          const t = kind === 'scene'
            ? (tpl.scene || '')
            : (role === '主人公' ? tpl.hero : tpl.npc)
          out.push({
            kind,
            name,
            role,
            // 档案（提示词的依据）：来自分镜提取，用户可手改；_profRev/_profRevAt/_profAck 是脏标记依据
            profile: normalizeProfile(old.profile || ''),
            _profRevAt: old._profRevAt || 0,
            _profRev: old._profRev || 0,
            _profAck: old._profAck || 0,
            prompt: old.prompt || (t || '').replace(/\{name\}/g, name),
            negative: old.negative || DEFAULT_NEG,
            promptMs: old.promptMs || 0,
            promptAt: old.promptAt || 0,
            candidates: Array.isArray(old.candidates) ? old.candidates.slice() : [],
            cur: typeof old.cur === 'number' ? old.cur : -1,
            // 🔴 图生图底图标记随卡落库（2026-09-27）：以前是运行时字段，点选后 pick() 的 saveAll
            //    会触发「工件变化 → 150ms 后 init 重建」把标记冲掉 → 按钮闪回「文生图」、参考图从未真正用过。
            //    显式点选才置 true、每次生成完 gen() 都会置 false，所以落库不会造成自动继承上一张
            refAsBase: old.refAsBase === true,
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
      const defRes = (ep.res && ep.res.img) || '1216x832'
      this.cards = out
      this.cards.forEach(c => {
        delete c._gen; delete c._genAt; delete c._pgGen; delete c._pgAt
        if (!c.res) c.res = defRes
        // ---- 库命中判定 ----
        const e = byName.get(c.kind + '|' + c.name)
        if (!e) return
        c.libId = e.id
        c._libRevNow = e.libRev || 1
        if (c.libRevAt) return              // 以前对齐过：保留本集副本，只读；版本落后则亮黄标
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
      })
      if (aligned.length) {
        await this.saveAll()
        this.$root.toast('已从项目角色场景库加载：' + aligned.join('、'))
      }
    },
    /** 该类型的图根目录：<项目>/assets/characters 或 <项目>/assets/scenes */
    rootOf(c) {
      const a = this.ep && this.ep.assetsDir
      return a ? joinPath(a, c.kind === 'scene' ? 'scenes' : 'characters') : ''
    },
    /** 某张卡的图目录：<项目>/assets/<类型>/<名称> */
    dirOf(c) { return joinPath(this.rootOf(c), seg(c.name)) },
    /** 某张图的绝对路径 */
    absOf(c, f) { return joinPath(this.dirOf(c), f) },
    /** 点大预览图 → 打开 App.vue 的媒体预览弹窗（大图查看，带「所在文件夹」入口） */
    previewImg(it) {
      const f = this.selFile(it.c)
      if (!f) return
      this.$root.openPreview({ file: f, path: this.absOf(it.c, f) }, 'image', it.c.name)
    },
    /** 卡片上的耗时文案：生成中实时计时 / 完成后显示本次生成耗时 */
    genText(c) {
      void this.live
      if (c._genAt) return '生成中 已用 ' + fmtMs(Date.now() - c._genAt)
      return c.genMs ? '耗时 ' + fmtMs(c.genMs) : ''
    },
    /** 档案区的时间文案：正在生成提示词 / 上次生成提示词的时间 */
    pgText(c) {
      void this.live
      if (c._pgAt) return '生成提示词 已用 ' + fmtMs(Date.now() - c._pgAt)
      return c.promptAt ? '提示词 ' + agoText(c.promptAt) : ''
    },
    /** 该卡当前生效的分辨率（未单独设置过 → 剧集配置） */
    resOf(c) { return c.res || (this.ep && this.ep.res && this.ep.res.img) || '1216x832' },
    /** 档位按当前底模过滤；该卡已保存的值不在档位里时补进去（保证显示正确） */
    optsFor(c) { return optsWith((this.st.resOptions || {}).img, this.resOf(c)) },
    /** 大预览当前图片的实际分辨率（'1216×832'，读到为止显示空） */
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
    /** 参考图背景检查（零新依赖）：缩小到 56×56 采样四角 5×5 邻域，取四角之间的最大通道差。
     *  纯色背景（含细微噪点/渐变）差值很小；带场景、建筑、天空、道具时四角必然差异大。
     *  只对角色图判——场景图本来就该有环境。 */
    bgFlat(src) {
      return new Promise(res => {
        const im = new Image()
        im.onload = () => {
          try {
            const W = 56, H = 56
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H
            const g = cv.getContext('2d'); g.drawImage(im, 0, 0, W, H)
            const d = g.getImageData(0, 0, W, H).data
            const patch = (x0, y0) => {
              let r = 0, gg = 0, b = 0, n = 0
              for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x0 + 5; x++) {
                const p = (y * W + x) * 4; r += d[p]; gg += d[p + 1]; b += d[p + 2]; n++
              }
              return [r / n, gg / n, b / n]
            }
            const ms = [[0, 0], [W - 5, 0], [0, H - 5], [W - 5, H - 5]].map(([x, y]) => patch(x, y))
            let max = 0
            for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++)
              for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(ms[i][k] - ms[j][k]))
            res(Math.round(max))
          } catch (e) { res(-1) }
        }
        im.onerror = () => res(-1)
        im.src = src
      })
    },
    /** 角色卡的参考图是否带环境（背景非纯色）→ 卡片角标文案；返回空串 = 不提示 */
    bgWarn(c) {
      if (!c || c.kind !== 'character') return ''
      const f = this.selFile(c) || c.candidates[c.candidates.length - 1]
      if (!f) return ''
      const abs = this.absOf(c, f)
      const k = 'bg:' + abs
      if (this._bg[k] === undefined) {
        const src = this.imgSrc(abs)
        if (!src) return ''          // base64 还没就绪：不缓存，下次渲染再试
        this._bg[k] = 0
        this.bgFlat(src).then(v => { this._bg[k] = v })
        return ''
      }
      const v = this._bg[k]
      return (typeof v === 'number' && v > 36) ? '背景非纯色' : ''
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
  if (c.cur === i) { c.cur = -1; c.refAsBase = false } else { c.cur = i; c.refAsBase = true }
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
    /** 打开删卡确认（统计有多少镜头在用它，提示里说清后果） */
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
      this.askCard = { c: card, used }
    },
    /** 删除整张卡：卡片数组移除 → 落库（chars.json / scenes.json 由 saveAll 从 cards 重写） */
    async doDelCard() {
      const a = this.askCard
      if (!a) return
      const card = this.liveCard(a.c)
      this.askCard = null
      const i = this.cards.indexOf(card)
      if (i < 0) return
      const L = stepLog(TAG)
      try {
        this.cards.splice(i, 1)
        await this.saveAll()
        this.st.invalidateMedia(this.ep.projectId, 'characters')
        L.done('已删除' + (card.kind === 'scene' ? '场景' : '角色') + '卡：「' + card.name + '」（图片文件保留在磁盘）')
        this.$root.toast('已删除「' + card.name + '」这张卡（图片文件仍在 assets 下）')
      } catch (e) {
        L.fail('删除卡片失败', null, e)
        this.st.fail(e)
      }
    },
    /** 🔴 卡片可能因 rebuildSoon 被整体替换（保存→watch→150ms 后 init 重建），
     *  弹窗/异步回调里持有的旧对象已脱离 this.cards —— 任何写操作前先按
     *  「类型+名字」重新解析当前活卡，文件名是稳定标识，用它找回下标 */
    liveCard(c) { return this.cards.find(x => x.kind === c.kind && x.name === c.name) || c },
    async doDel(permanent) {
      const f = this.ask.f
      const c = this.liveCard(this.ask.c)
      const i = c.candidates.indexOf(f)
      this.ask = null
      if (i < 0) return
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
          mustHave: ['"prompt"', '"negative"']
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
        ], { temperature: 0.6, maxTokens: 1024, json: true, label: TAG })
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
    /** 生成某张卡的图（逐张分辨率取该卡自己的配置）；角色与场景走同一套流程 */
    async gen(i, ctx) {
      const c = this.cards[i]
      if (!c) return false
      const isScene = c.kind === 'scene'
      const what = isScene ? '场景图' : '角色图'
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
      // 场景图强制空镜：正向里缺空镜陈述时补上「空镜必备句」（取自 scenes.md，可随时改）；
      // 发送前再剥掉命中器材词的短语（存量老提示词里的「单反相机拍摄」防器材被画进画面）
      const positive = stripEquipmentWords(isScene ? ensureSceneKeeper(c.prompt, this._keeper) : c.prompt, EQ_WORDS)
      const [rw, rh] = parseRes(this.resOf(c))
      L.start('正在生成' + what + '：' + c.name + prog + '（' + rw + 'x' + rh +
        ' · ' + resLabel(this.optsFor(c), this.resOf(c)) +
        (fromRef ? ' · 图生图，参考：' + c.candidates[c.cur] : ' · 文生图') + '）')
      try {
        const dir = this.dirOf(c)
        dbgPrompt(TAG, '图片模型 · ' + what + '「' + c.name + '」', [
          ['positive', positive],
          ['negative', c.negative || DEFAULT_NEG],
          ['size', rw + 'x' + rh + '（' + resLabel(this.optsFor(c), this.resOf(c)) + '）'],
          ['mode', fromRef ? '图生图 denoise 0.62，参考图 ' + c.candidates[c.cur] : '文生图' + (isScene ? '（已补空镜句）' : '')]
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
        const ms = Date.now() - t0
        c.genMs = ms                 // 逐条耗时（持久化，显示在该卡标题旁）
        c._imgRev = (c._imgRev || 1) + 1   // 图片版本 +1：引用本资产图片的镜头提示词会被标 ⚠
        delete c._genAt
        await this.saveAll()
        this.pl.markGen(3, ms)
        this.st.invalidateMedia(this.ep.projectId, 'characters')   // 左侧树 assets 下次展开刷新
        L.done(what + '「' + c.name + '」生成完成：' + r.files.join('、'), ms)
        this.$root.toast(c.name + ' 已生成：' + r.files.join('、'))
        return true
      } catch (e) {
        L.fail(what + '「' + c.name + '」生成失败' + prog, Date.now() - t0, e)
        this.st.fail(e)
        return false
      } finally {
        delete c._genAt; c._gen = false; this.busy = false; this.pl.endGen(3)
        if (!this.batchI && !this.batchP) this._busyEpId = null
      }
    },
    /* ================= 批量任务（块 2 标题行的两个按钮） ================= */
    /** 「批量生成提示词」：跑动中点击 = 请求停止；空闲点击 = 弹框选范围 */
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
      const have = this.cards.filter(c => c.candidates.length).length
      this.askBatch = { kind: 'images', have, miss: this.cards.length - have, total: this.cards.length }
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
        if (!String(c.prompt || '').trim() || profileDirty(c)) idx.push(i)
      }
      if (!idx.length) { this.$root.toast('没有需要生成提示词的条目'); return }
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
    },
    /** 批量生成图片：all=false 只补还没有图的条目（已有图的跳过）；all=true 全部重出一张（完成自动选中新版） */
    async runBatchI(all) {
      const L = stepLog(TAG)
      const idx = []
      for (let i = 0; i < this.cards.length; i++) {
        if (all || !this.cards[i].candidates.length) idx.push(i)
      }
      if (!idx.length) {
        this.$root.toast('没有需要生成的条目')
        return
      }
      this.batchI = true; this.batchIStop = false; this.busy = true
      this.batchIN = 0; this.batchITotal = idx.length
      L.start('开始批量生成图片（' + (all ? '全部重新生成，完成后自动选中新版本' : '只补还没有图的，跳过已有图') + '）：待生成 ' +
        idx.length + ' 个（共 ' + this.cards.length + ' 个角色/场景）；可随时点「停止批量」，当前条目跑完后停止')
      const tAll = Date.now()
      let okN = 0, badN = 0, stopped = false
      try {
        for (let k = 0; k < idx.length; k++) {
          if (this.batchIStop || this._busyEpId === 'SWITCHED') { stopped = true; break }
          this.batchIN = k + 1
          const okFlag = await this.gen(idx[k], { n: k + 1, total: idx.length })
          okFlag ? okN++ : badN++
        }
        const left = idx.length - okN - badN
        const sum = (stopped ? '批量生成图片已停止' : '批量生成图片结束') +
          '：成功 ' + okN + ' 个' + (badN ? '，失败 ' + badN + ' 个' : '') +
          (stopped && left > 0 ? '，剩余 ' + left + ' 个未执行' : '') + '，总耗时 ' + secs(Date.now() - tAll)
        if (badN && !okN) L.fail(sum, null, new Error('全部失败，请到日志面板看各自失败原因'))
        else if (badN || stopped) L.warn(sum)
        else L.done(sum, null)
      } finally {
        this.batchI = false; this.batchIStop = false; this.busy = false
        this.batchIN = 0; this.batchITotal = 0
        if (!this.batchP) this._busyEpId = null
      }
    },
    async confirm() {
      await this.saveAll()
      this.pl.confirm(3, this.ep.id)
      this.$root.toast('角色 & 场景已确认')
    },
    /* ---- 一键填充：把当前选中的这张图批量填进「包含该角色/该场景」的镜头的参考图区 ---- */
    /** 该镜头是否包含这张卡（角色比对 shots[].chars，场景比对 shots[].scene） */
    shotHas(c, s) {
      const raw = String((c.kind === 'scene' ? s.scene : s.chars) || '')
      if (!raw) return false
      if (c.kind === 'scene') return raw.trim() === c.name || raw.includes(c.name)
      return raw.split(/[、,，/]/).map(x => x.trim()).includes(c.name) || raw.includes(c.name)
    },
    /**
     * 一键填充：把该卡**当前选中**的那张图追加到所有命中镜头的 refs.images。
     * - 只填参考图（不动首帧/尾帧）；镜头已有这张图 → 跳过；参考图已满 9 张 → 跳过
     * - 结束后用 toast 汇总（填了几个、跳过几个及原因）
     * - 命中的镜头会因此亮 ⚠（素材签名变了 → 提示词应重新生成），这是预期行为
     */
    async fillRefs(i) {
      const c = this.liveCard(this.cards[i])
      const f = c ? this.selFile(c) : null
      if (!c || !f) { this.$root.toast('请先在小预览图里选中一张，再点「一键填充」'); return }
      const ep = this.ep
      const shots = (ep && ep.shots) || []
      if (!shots.length) { this.$root.toast('还没有镜头；先在第 4 块生成分镜再填充'); return }
      const abs = this.absOf(c, f)
      // 🔴 工件在 store 里，必须整份复制出来改完再落库（改同引用会漏存）
      const prompts = JSON.parse(JSON.stringify(ep.prompts || []))
      while (prompts.length < shots.length) prompts.push({ text: '', refs: EMPTY_REFS() })
      let hit = 0, dup = 0, full = 0
      shots.forEach((s, k) => {
        if (!this.shotHas(c, s)) return
        if (!prompts[k]) prompts[k] = { text: '', refs: EMPTY_REFS() }
        const p = prompts[k]
        if (!p.refs) p.refs = EMPTY_REFS()
        if (!Array.isArray(p.refs.images)) p.refs.images = []
        const imgs = p.refs.images
        if (imgs.indexOf(abs) >= 0) { dup++; return }
        if (imgs.length >= MAX_REF_IMG) { full++; return }
        imgs.push(abs)
        hit++
      })
      if (!hit) {
        const why = []
        if (dup) why.push(dup + ' 个镜头已有这张图')
        if (full) why.push(full + ' 个镜头参考图已满 ' + MAX_REF_IMG + ' 张')
        this.$root.toast(why.length ? '没有可填充的镜头（' + why.join('、') + '）'
          : '没有镜头包含「' + c.name + '」，未填充')
        return
      }
      try {
        await this.st.saveArtifact('prompts', prompts)
        // 通知常驻挂载的「分镜脚本」块按最新工件重建表单（否则它的本地副本会把这次填充覆盖回去）
        ep.promptsSyncAt = Date.now()
      } catch (e) { this.st.fail(e); return }
      const skip = []
      if (dup) skip.push(dup + ' 个已有该图')
      if (full) skip.push(full + ' 个已满 ' + MAX_REF_IMG + ' 张')
      this.$root.toast('已把「' + c.name + '」的这张图填入 ' + hit + ' 个镜头的参考图区' +
        (skip.length ? '（跳过 ' + skip.join('、') + '）' : '') + '；这些镜头的提示词已标 ⚠，记得重新生成')
    }
  }
}
</script>
