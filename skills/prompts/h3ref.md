---
title: H3 视频提示词规范（参考模式）
module: h3ref
rev: 6
note: 本文件是「H3 提示词」模块的风格规范（参考模式：参考图/参考视频），不是直接发给大模型的指令，而是与固定的任务说明、输出契约组装后再发送。格式严格遵循 MiniMax H3 官方文档：六段式字段，不自创段落。纯文字/首帧/首尾帧模式另见 h3.md（三段规范）。保存后下次生成提示词立即生效。注意：请保留 ## 小节标题，程序按标题读取内容。
---

## 适用范围

本规范约束「镜头 → H3 视频生成提示词」环节的**全参考模式**（Ref2VA）：本镜头携带参考图和/或参考视频，参考资产作为外观与设定的固定依据。输出为一条完整的官方六段式英文提示词，每个镜头一条，画面风格固定为**古风真人实拍**。格式遵循 MiniMax H3 官方《Full-Reference Mode Rewrite Output Format Guide》；对白、运镜、时间线等基础写法与 h3.md（基础模式）一致。

## 核心规则

### 六段字段（官方固定，字段名与顺序不可改）

字段名单独一行、以英文冒号结尾，值从下一行起：

`subject_definitions:` 定义每个参考资产及其标签。
`summary:` 一小段英文概括任务类型（方括号前缀）、目标视频与主要参考关系。
`retention_analysis:` 逐标签说明参考内容如何保留、转移或复用。
`detailed_description:` 主体字段——按播放顺序描述画面、动作、镜头、声音与对白。
`overall_soundscape:` 全片环境音与物理动作音总括，1-4 句。
`non_diegetic_music:` 仅观众可听的背景音乐，1-3 句；没有写 `N/A`。

### 参考标签（subject_definitions）

- `<Subject N>`：从参考资产中抽象出的可复用画面内容（人物、场景、服装、道具、动作、风格等）。逐个定义一行，写明标签指代什么、参考角色是什么、要遵循的主要特征，并注明来源资产。本软件提供的参考图/参考视频都是**外观与设定参考**：一律通过 `<Subject N>` 定义，来源在定义内引用 `<Picture N>`（参考图）或 `<Video N>`（参考视频）。例：
  `<Subject 1> is the young poet in <Picture 1>, wearing a white hanfu, with a slender figure and a refined temperament.`
  `<Subject 3> is the sword-drawing motion from <Video 1>, a single smooth upward slash.`
- 只锁外观身份的参考**不要**单独建 `<Picture N>` 条目——那仅用于把图当作具体帧锚点（首帧/关键帧/尾帧）的场合，本模式不使用。
- `<Subject N>` 只收**可复用的画面主体**（人物、场景、服装、道具，以及参考视频提供的动作素材）。**绝不要把本镜头一次性的叙事动作或相机运镜编号成主体**（如 `<Subject 4> is the boat boarding action and camera movement`）——那些属于 `detailed_description` 里要写的镜头与情节；把它们塞进主体表会污染「主体 ↔ 说话人」的对应关系。相机运动一律写在正文句里。
- 主体表里**只有人物类 `<Subject N>` 能说话**；场景、道具、动作类的 Subject 绝不分配 `(Sx)` 音色槽，也绝不持有台词。
- 同一标签在全部六段中含义保持一致，一旦定义不得改写；`summary` 及之后不得引入新标签。
- 参考视频只提供动作/运镜/节奏参考时，同样归入 `<Subject N>`（画面内容）或在定义中引用 `<Video N>`；没有真实剪辑或续接行为，不使用 video editing / video continuation 类任务类型。

### summary（任务类型前缀）

- 以方括号任务类型开头。参考图锁定外观、参考视频提供动作/运镜参考 → `[reference generation]`。例：
  `[reference generation] The target video shows <Subject 1> wandering along the river tower at dusk, with <Subject 2> boarding a small boat.`
- 概括里只使用已定义的 `<Subject N>` 等标签描述主体与镜头流。

### retention_analysis

每个标签一行，格式固定：
`<Subject 1> (appears in [Shot 1]): fully_preserved - the white hanfu, slender figure and refined temperament are retained.`
关系标记只用官方固定值：`fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`。目标视频新增的动作与情节不算保真度损失。

### detailed_description

- 先用 1-2 句英文确立整体风格，再从 `[Shot 1]` 开始按播放顺序展开（第一镜无时间戳；确需分镜时 `[Shot 2] At 00:03.500, ...` 切点严格递增且在时长内）。风格句固定写**古风真人实拍**的摄影语言：`Photorealistic live-action period drama, 8K ultra-detailed, real skin texture, natural light, shallow depth of field, cinematic color grading`；严禁出现 `anime / animation / illustration / cel shading / cartoon / 3D render / game CG / manga` 等词。
- 每个重要 `<Subject N>` 首次出现时，写明其参考特征、在画面中的位置与当前动作；后续继续用同一标签，不再重新定义。
- 生成类任务正文通常 350-500 英文词；对白密集时优先覆盖完整说话时间线，不为凑字数硬写。单镜头不代表可以写短，按信息量分配细节。
- **对白（最高优先级）**：本模式的说话人必须是一个**人物类** `<Subject N>`，规则与基础模式完全一致，同样三步走：
  1. **先定说话人**：`dialogue` 每条为「说话人名：台词」。先拿冒号前的人名，到 `subject_definitions` 里查出这个人的 `<Subject N>`（人名通常在参考资产清单里已标注，如 `<Picture 3> = 孟浩然_07.png（孟浩然）` → 他就是那个 `<Subject N>`），**台词只能挂到这个 Subject 上**。不得按 `summary` 里的描述顺序、画面焦点、特写对象、动作发起者或编号大小推断说话人。
     ⚠️ 「配角说话、主角反应」的镜头最容易写错：镜头描述「A 一怔，随即仰头大笑」且特写给 A，但开口的是 B——台词归 B，A 只写反应动作。`summary` 段若已写明「B 回头说话」，`detailed_description` 必须与之保持一致，不得改口。
  2. **再写台词句**：`<Subject N> (Sx) says ... <d>[Chinese] 台词原文</d>`，例如 `<Subject 2> (S1) says with a low, steady voice: <d>[Chinese] 太白，你近日诗作渐少…</d>, his lips clearly articulating the words`。
  3. **台词只出现一次**：整条提示词里每句台词**有且仅有一次**，就写在带说话人标签的那句里；绝不写成「裸台词一遍 + 带标签一遍」。
- **`(Sx)` 是与 `<Subject N>` 无关的独立人声槽**：`(S1)` 只表示本镜头第一个开口的声音，**不代表** `<Subject 1>`；`<Subject 2> (S1)` 是正常组合，`<Subject 1> (S1)` 也可以（前提是 1 号主体确实是第一个说话的人）。音色槽按本镜头内说话人首次开口顺序编号，同一说话人只有一个编号。反例：说话人是 `<Subject 2>`，却写成 `<Subject 1> (S1) says` —— 台词会被判给 1 号主体。
- **不许给非说话人「发声」**：台词句之前不得描述旁人 `lets out the sound` / `bursts into a laugh` / `opens his mouth` 后紧接台词；旁人反应写在他自己名下、与台词句分开。
- **对白朝向（有明确听话人时必须交代）**：`dialogue` 的听话人明确时（同一镜头里的其他角色/`<Subject N>`），**不管画面里有几个人**，`detailed_description` 必须写明**说话人相对听话人的朝向**——转向对方、与他目光接触、举杯/递物向他（如 `<Subject 3> turns to face <Subject 2>, making eye contact as he says ...`），或视线投向听话人所处的方向。听话人不入画（如单人特写）时，明写**画外视线**（如 `speaking toward Meng Haoran, who remains off-screen` / `his gaze directed at the unseen <Subject 2> beside him`），视线方向必须与听话人在空间中的位置一致。镜头构图（单人特写 / 双人 / 越肩）随镜头需要自由选择，入画人数不设限；**只禁止朝向悬空或自相矛盾**——比如对白说给身边的人，动作与视线却朝向太阳、酒液或江面（模型会据此让说话人背对听话人开口）。
- **场景 / 道具 / 动作类 Subject 永不说话**：只有人物才能持有 `(Sx)` 音色槽与 `<d>` 台词。台词原文原样进 `<d>[Chinese] 原文</d>`，一字不改、保留中文与标点；口型同步（`his lips clearly articulating the words`）、画外音（`says in an off-screen voiceover` + `while his lips remain completely closed`）规则同基础模式。台词、歌词只出现在本字段，不得写进声音两段。
- 运镜写法与基础模式一致：类型 + 幅度 + 速度的自然英文句。

### overall_soundscape 与 non_diegetic_music

- **声音事件归属（官方规定，与基础模式不同）**：官方全参考模式明确 `Dialogue, singing, and sound events synchronized to a particular shot remain in detailed_description`——**与特定镜头同步的声音事件**（对白、歌唱、镜头内的笑声/哭喊/器物声）一律写在 `detailed_description` 里并写成**带来源与起止的声音事件句**（如 `A hearty, booming laugh bursts from <Subject 2> immediately after the line and continues through the end of the shot`）；`overall_soundscape` **只写跨全片连续的环境底噪**（room tone、风、水声等），**不得**塞镜头内事件，也不得只写一句空泛 ambience 了事。
- **非语言人声条件式**：角色**有明确声源、有戏剧行为**的发声（大笑、痛哭、惊呼、叹息、喘息）必须成句写成声音事件，**只写画面动作词不算数**（`bursts into loud laughter` 后面没有任何声音描述 = 视频无声）；群戏声源可写群体（`the crowd erupts in cheers`）；歌唱走对白规则（音色槽 + `<d>`）、「笑着说」属于音色修饰（`says between laughter`），都不算独立事件。台词「只出现一次」的规则**不适用**于声音描述。
- `non_diegetic_music`：1-3 句，只写配乐本身（乐器、速度、节奏、强弱变化），不写抽象情绪词；没有配乐写 `N/A`。

## 格式与一致性

- 六段输出、顺序固定；除台词原文与画面内可见文字外全部英文；不要编号、不要解释、不要 Markdown 代码块。
- 第一段就是 `subject_definitions:`——没有对齐句，也**绝不出现**旧版 `[Subject] / [Action] / [Camera] / [Style] / [Audio]` 五段格式或三段式字段名（`integrated_multimodal_description` 属于基础模式，本模式不用）。
- 人物外观只按 `subject_definitions` 的定义写，不得另行虚构；台词不得以字幕、水印、logo 形式出现在画面上。
- 场景描述与该镜头的场景档案保持一致；全片风格统一为**古风真人实拍**（真人古装剧质感），不得出现任何动漫/插画/3D 渲染的措辞；参考图本身若偏插画风，也要在风格句里强调 `photorealistic live-action` 把最终画面拉回真人质感。
- 所有时间表述必须与任务给出的镜头时长一致，不得超出。
- **输出前必须自检对白**（逐句过一遍，六问）：① 这句台词的说话主体，是不是 `dialogue` 里冒号前的**那个人**对应的 `<Subject N>`？② 这句台词在全文是否**只出现一次**？③ 台词句之前有没有旁人「发出声音」的描写？④ `summary` 里说的说话人是不是和正文一致？⑤ 台词有明确听话人时，说话人的**朝向**是否已写明（转向/看向对方，或看向其画外方向）？⑥ 镜头里角色大笑/痛哭等戏剧行为的发声，是否已作为**声音事件句写在 `detailed_description`**（而不是被塞进 `overall_soundscape` 或只写画面动作词）？任一项不合格就重写该句。镜头焦点、特写对象、主体编号顺序都与说话人无关。

## 兜底默认

（无）
