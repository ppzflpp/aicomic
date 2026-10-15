# 飞鱼AI视频导演台

把小说、故事一键变成漫剧 / 短剧视频的本地软件：**改编 → 角色场景 → 分镜出视频 → 组装成片**。
全程在你自己的电脑上完成，创作内容不上传、不外泄。

**安装只要三步，照着做就行：**

| 步骤 | 做什么 | 去哪看 |
|---|---|---|
| 第一步 | 装**本软件** | 见下方「第一步」 |
| 第二步 | 装 **ComfyUI**（出图 / 出视频的后端） | 见下方「第二步」 |
| 第三步 | 下载**模型文件**（约 92GB） | 见下方「第三步」 |

三步缺一不可，请按顺序做完，就可以开始创作了。

---

## 第一步：安装本软件

两种方式，**任选一种**。

### 方式一：一键安装包（推荐，最省事）

下载安装包（`.exe`，约 800MB），双击 → 选个安装目录 → 装好即可。

> 下载地址：网盘「飞鱼AI视频工作台」
> 链接：<https://pan.baidu.com/s/1CE3ORRK3orUWClK0pR0HEg?pwd=xmbn>
> 提取码：**xmbn**

### 方式二：源码运行（适合会写代码的用户）

按顺序执行下面 4 条命令：

```bash
git clone https://github.com/ppzflpp/aicomic.git
cd aicomic/comic-studio
npm install
npm run dev
```

另外还要从上面同一个网盘下载 **`tools` 文件夹**，整个放进 `comic-studio/` 目录里，和 `electron/`、`src/` 放在一起：

```
comic-studio/
  ├── tools/          ← 从网盘下载后放这里
  ├── electron/
  └── src/
```

---

## 第二步：安装 ComfyUI（必须装）

⚠️ 出图、出视频都是 ComfyUI 在干活。**不管用上面哪种方式装软件，都必须再装一个 ComfyUI**，否则什么图都出不了。

1. 打开官网下载并安装：[comfy.org/download](https://www.comfy.org/download)（版本要 **0.37.0 以上**）
2. 装好后**打开 ComfyUI**，在里面**新建并启动一个实例**（随便选一个就行）
3. 启动完把它**最小化放着不用管**，然后就可以打开本软件开始创作了

> 每次使用本软件之前，都要先这样打开一次 ComfyUI。

---

## 第三步：下载模型（必须自己下载）

下面这些文件，**软件里没有、网盘里也没有，必须自己下载**，合计约 92GB（非 50 系显卡约 107GB）。
全部是 [hf-mirror.com](https://hf-mirror.com) 的国内镜像，点开就能下，不用科学上网。

**下面三组的文件都要下齐。**

### 1️⃣ 文字创作（1 个）

| 文件 | 大小 | 下载 |
|---|---|---|
| Qwen3.5-9B-Q5_K_M.gguf | 6.1GB | [下载](https://hf-mirror.com/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q5_K_M.gguf) |

### 2️⃣ 生图（3 个）

| 文件 | 大小 | 下载 |
|---|---|---|
| qwen_image_2.1_int8_convrot.safetensors | 7.3GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| qwen3vl_8b_int8_convrot.safetensors | 9.4GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| qwen_image_2.1_vae_bf16.safetensors | 0.7GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

### 3️⃣ 出视频（下面四组全要）

**① 视频主模型（2 个）**

| 文件 | 大小 | 下载 |
|---|---|---|
| minimax_h3_fl2va_pruned_int8_convrot.safetensors | 21GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) |
| minimax_h3_ref2va_pruned_int8_convrot.safetensors | 21GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |

**② 视频文字编码器（看你的显卡，两个里选一个）**

| 文件 | 大小 | 下载 |
|---|---|---|
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors<br><sub>**50 系显卡选这个**</sub> | 15.7GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| qwen3vl_32b_minimax_h3_int8_convrot.safetensors<br><sub>**非 50 系显卡选这个**</sub> | 27.1GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors) |

> 怎么看自己是不是 50 系？显卡型号以 **RTX 50** 开头就是（比如 RTX 5060 / 5070 / 5080 / 5090）。
> 选错了软件会跑不起来，请对着自己的显卡型号下。

**③ 出片加速包（5 个，都要下）**

| 文件 | 大小 | 下载 |
|---|---|---|
| minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors | 2.0GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors) |
| minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors | 2.0GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors) |
| minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors | 2.0GB | [下载](https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors) |
| minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors | 2.0GB | [下载](https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors) |
| minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors | 2.0GB | [下载](https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors) |

> 5 个都要下，少一个出片画面会变差。

**④ 视频画面与声音解码（2 个）**

| 文件 | 大小 | 下载 |
|---|---|---|
| minimax_h3_video_vae_fp16.safetensors | 5.2GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) |
| minimax_h3_audio_vae_fp32.safetensors | 0.6GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) |

---

**下载完不用自己分类、也不用找地方放。** 打开本软件 →「设置 → 模型管家」→ 点「批量导入文件夹…」，
选中你下载文件所在的文件夹，软件会自动识别并存到正确位置。**列表里全部显示绿色，就说明装好了。**

---

## 全部装好后：开始创作

1. 先打开 **ComfyUI**，在里面启动一个实例，然后最小化放着
2. 打开**飞鱼AI视频导演台** → 左上角「设置 → 模型管家」→ 批量导入模型文件夹，确认全部变绿
3. 回到主界面 → 点**新建项目**：先选「视频质量」和「视频比例」，软件会自动填好各项分辨率（也可以自己改）
4. 选好项目文件夹，就可以开始创作了

顶部状态条会显示文字模型、ComfyUI、ffmpeg 有没有就绪，以及显卡 / 内存占用，一眼就能看出环境是否正常。

> 文字创作、出图、出视频需要用到时，软件会自动启动对应的服务，不用你手动开关。

**软件界面预览：**

| 剧本改编 | 角色 & 场景 |
|---|---|
| ![剧本改编](screenshots/ui-1-adapt.jpg) | ![角色&场景](screenshots/ui-2-chars.jpg) |
| **分镜脚本** | **组装成片** |
| ![分镜脚本](screenshots/ui-3-shots.jpg) | ![组装成片](screenshots/ui-4-film.jpg) |

---

## 我的显卡够不够？

| 显存 | 情况 |
|---|---|
| 8-12GB | 出图没问题；出视频建议把分辨率调低一些 |
| 16GB 以上 | 出图、出视频都很顺畅 |

> 出视频要装哪个文件，按你的显卡选（见上方「第三步 ②」）：**50 系显卡选 nvfp4，非 50 系选 int8**。

---

## 交流

QQ 群：**1036028422** — 使用中有问题欢迎进群讨论。

## 打赏

开源不易，从改编、出图到成片的每一步都是用爱发电。
如果这个软件帮你把小说、故事变成了视频，省下了真金白银的制作费，欢迎请作者喝杯咖啡 ☕
金额随意，心意最重要 —— 你的支持就是我继续更新的动力！

**打赏方式**：扫描下方二维码添加作者微信，备注「飞鱼」，添加后微信转账即可。

<p align="center"><img src="screenshots/donate-wechat.png" alt="扫码加作者微信，打赏请转账" width="320"></p>

## License

随意使用，可商用。如果觉得好用，欢迎回来点个 Star 或请作者喝杯咖啡。
