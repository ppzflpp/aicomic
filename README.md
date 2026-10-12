# 飞鱼AI视频导演台

把小说、故事一键变成漫剧 / 短剧视频的本地桌面软件：**改编 → 角色场景 → 分镜出视频 → 组装成片**。
所有推理都在你自己的显卡上跑，不用云端 API，创作内容不出本机。

---

## 开始之前：你要准备 3 样东西

| | 要什么 | 怎么弄 |
|---|---|---|
| 1️⃣ | **本软件** | 见下方「第一步」 |
| 2️⃣ | **ComfyUI Desktop**（出图 / 出视频的后端） | 见下方「第二步」 |
| 3️⃣ | **模型文件**（约 90GB） | 见下方「第三步」 |

三样缺一样都跑不起来。下面按顺序做即可。

---

## 第一步：装本软件

两种方式，**任选一种**。

### 方式一：一键安装包 ✅ 推荐

从网盘下载安装包（`.exe`，约 800MB），双击 → 选安装目录 → 装好即可。

> **网盘：飞鱼AI视频工作台**
> 链接：<https://pan.baidu.com/s/1CE3ORRK3orUWClK0pR0HEg?pwd=xmbn>
> 提取码：**xmbn**

### 方式二：源码运行（会写代码的选这个）

```bash
git clone https://github.com/ppzflpp/aicomic.git
cd aicomic/comic-studio
npm install
npm run dev
```

源码仓库里**不含 ffmpeg 和 llama.cpp**（文件太大），需要从上面同一个网盘下载 **`tools` 文件夹**，
整个放进 `comic-studio/` 目录里，和 `electron/`、`src/` 放在一起：

```
comic-studio/
  ├── tools/          ← 从网盘下载后放这里
  │     ├── ffmpeg/
  │     └── llama/
  ├── electron/
  └── src/
```

---

## 第二步：装 ComfyUI（**必须装**）

⚠️ **不管用上面哪种方式，都必须再装一个 ComfyUI Desktop** —— 出图和出视频都是它在干活，
本软件只是调用它。不装 ComfyUI，软件什么图都出不了。

从官网下载安装：[comfy.org/download](https://www.comfy.org/download)（**版本要 0.37.0 以上**）。

**每次使用本软件之前，都要先手动打开一次 ComfyUI Desktop，并在里面启动一个实例** —— 随便新建一个就行，
这一步主要是用来初始化的。启动完把它最小化放在那儿，不用管它，然后就可以打开本软件开始创作了。

> 本软件只调用 ComfyUI，不负责启动它的界面，所以每次都要你自己先把它打开。

---

## 第三步：下载模型（**必须自己下**）

**模型不包含在软件里，也不在网盘里，必须自己下载**，合计约 90GB（非 50 系卡约 105GB）。

全部是 [hf-mirror.com](https://hf-mirror.com) 的国内镜像直链，不用科学上网。下面分三组，**每一组都要下齐**。

### 1️⃣ 文字创作：改编剧本、写分镜（1 个，必下）

| 文件 | 大小 | 直链 |
|---|---|---|
| Qwen3.5-9B-Q5_K_M.gguf<br><sub>文字模型</sub> | 6.1GB | [下载](https://hf-mirror.com/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q5_K_M.gguf) |

### 2️⃣ 生图：画角色、画场景（3 个，必下）

| 文件 | 大小 | 直链 |
|---|---|---|
| qwen_image_2.1_int8_convrot.safetensors<br><sub>生图主模型</sub> | 7.3GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| qwen3vl_8b_int8_convrot.safetensors<br><sub>生图文本编码器</sub> | 9.4GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| qwen_image_2.1_vae_bf16.safetensors<br><sub>生图 VAE</sub> | 0.7GB | [下载](https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

### 3️⃣ 出视频：分镜变视频（下面 4 组全要）

**① 视频主模型**（2 个，各 21GB）

| 文件 | 大小 | 直链 |
|---|---|---|
| minimax_h3_fl2va_pruned_int8_convrot.safetensors<br><sub>用「文字 / 首帧」生成视频</sub> | 21GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) |
| minimax_h3_ref2va_pruned_int8_convrot.safetensors<br><sub>用「参考图 / 参考视频」生成视频；不用参考素材可以不下</sub> | 21GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) |

**② 视频文本编码器**（**看你的显卡二选一**）

| 文件 | 大小 | 直链 |
|---|---|---|
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors<br><sub>**RTX 50 系（Blackwell）选这个**</sub> | 15.7GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) |
| qwen3vl_32b_minimax_h3_int8_convrot.safetensors<br><sub>**非 50 系（RTX 20 / 30 / 40 系）选这个**</sub> | 27.1GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors) |

> ⚠️ **这两个别下错**：上面那个 nvfp4 是 50 系显卡专用的格式，装到 30/40 系上**是直接跑不起来**（不是慢一点）。
> 反过来 50 系下 int8 版也能跑，只是白白多占 11GB。

**③ 视频加速 LoRA**（3 个，各约 2GB）—— 装了出片快好几倍，三个分别管不同的线，**要下齐**

| 文件 | 大小 | 直链 |
|---|---|---|
| minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors<br><sub>「文字 / 首帧」线，8 步</sub> | 2.0GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors) |
| minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors<br><sub>「文字 / 首帧」线，4 步（更快）</sub> | 2.0GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors) |
| minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors<br><sub>「参考图 / 参考视频」线</sub> | 2.0GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors) |

> 另外还有 2 个可选加速 LoRA（不下也能跑，装了「平衡」档更稳）：`minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors`（[下载](https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors)）、`minimax_h3_turbo_v4_step600.safetensors`（0.8GB，[下载](https://hf-mirror.com/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/minimax_h3_turbo_v4_step600.safetensors)）。

**④ 视频 VAE**（2 个，都必下）

| 文件 | 大小 | 直链 |
|---|---|---|
| minimax_h3_video_vae_fp16.safetensors<br><sub>画面解码</sub> | 5.2GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) |
| minimax_h3_audio_vae_fp32.safetensors<br><sub>声音解码（漏了会「有画面没声音」）</sub> | 0.6GB | [下载](https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) |

**下载完不用自己找地方放。** 打开本软件 →「设置 → 模型管家」→ 点「批量导入文件夹…」，
选中你放这些下载文件的文件夹，软件会自动扫描并拷到正确位置。全部变绿就是齐了。

---

## 都装好之后：开始创作

1. 先打开 **ComfyUI Desktop**，并在里面启动一个实例（随便新建一个，用来初始化；启动完最小化放着就行）
2. 打开**飞鱼AI视频导演台** → 「设置 → 模型管家」→ 批量导入模型文件夹、确认全绿
3. 回主界面，选个项目文件夹就能开始了

顶部状态条会实时显示 **LLM / ComfyUI / ffmpeg** 三个依赖的状态，外加 GPU / 显存 / 内存占用，一眼就知道环境正不正常。

> 服务不用你手动启停：LLM（文字创作）和 ComfyUI（出图 / 出视频）都由软件在用到时自动拉起、用完自动让出显存。

**下面是软件的样子：**

| 剧本改编 | 角色 & 场景 |
|---|---|
| ![剧本改编](screenshots/ui-1-adapt.jpg) | ![角色&场景](screenshots/ui-2-chars.jpg) |
| **分镜脚本** | **组装成片** |
| ![分镜脚本](screenshots/ui-3-shots.jpg) | ![组装成片](screenshots/ui-4-film.jpg) |

---

## 我的显卡够不够？

| 显存 | 情况 |
|---|---|
| 8-12GB | 出图没问题；出视频要降分辨率 |
| 16GB 以上 | 出图、出视频都顺畅 |

> 出视频要用哪个版本的模型，按你的显卡选（见上方「第三步 ②」）：**50 系卡用 nvfp4，非 50 系用 int8**。

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
