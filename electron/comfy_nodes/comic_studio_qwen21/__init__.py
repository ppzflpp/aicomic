"""
Empty Qwen Image 2.1 Latent —— 可按宽高生成的空 latent（64 通道，1/16 下采样）

【这份文件的用途】
  它同时是 ComfyUI 的自定义节点本体。ComfyUI 缺这个节点时，Qwen-Image 2.1 只能出正方形图
  （官方 TextEncodeQwenImage21 自带的 latent 输出尺寸被 resolution 限死为正方形）。

  安装位置（把整个 comic_studio_qwen21 文件夹拷过去）：
      <ComfyUI>/custom_nodes/comic_studio_qwen21/__init__.py
  装好后重启 ComfyUI，工作流里的 EmptyQwenImage21LatentImage 节点即可用。

【为什么需要它】
  Qwen-Image 2.1 的 DiT 输入是 64 通道 latent，空间下采样率为 16（不是 SD3 的 16 通道 / 8）。
  ComfyUI 自带的 EmptyLatentImage(4ch)、EmptySD3LatentImage(16ch) 都不能用。
  本节点与官方 TextEncodeQwenImage21 内部的 latent 构造完全一致（全零），只是宽高自由。
"""

import torch
import comfy.model_management

MAX_RES = 16384
CHANNELS = 64      # Qwen-Image 2.1 latent 通道数
DOWNSCALE = 16     # 空间下采样率：latent 边 = 像素边 / 16


class EmptyQwenImage21LatentImage:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "width": ("INT", {"default": 1024, "min": 16, "max": MAX_RES, "step": 16,
                                  "tooltip": "输出图像的宽度（像素），需为 16 的倍数。"}),
                "height": ("INT", {"default": 1024, "min": 16, "max": MAX_RES, "step": 16,
                                   "tooltip": "输出图像的高度（像素），需为 16 的倍数。"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    OUTPUT_TOOLTIPS = ("Qwen-Image 2.1 的空 latent（全零）。",)
    FUNCTION = "generate"
    CATEGORY = "model/latent/qwen"
    DESCRIPTION = "为 Qwen-Image 2.1 生成任意宽高的空 latent（64 通道，1/16 下采样）。"
    SEARCH_ALIASES = ["qwen", "qwen image 2.1", "empty latent", "qwen21 latent"]

    def generate(self, width, height, batch_size=1):
        w = max(16, round(width / DOWNSCALE) * DOWNSCALE)
        h = max(16, round(height / DOWNSCALE) * DOWNSCALE)
        latent = torch.zeros(
            [batch_size, CHANNELS, h // DOWNSCALE, w // DOWNSCALE],
            device=comfy.model_management.intermediate_device(),
        )
        return ({"samples": latent, "downscale_ratio_spacial": DOWNSCALE},)


NODE_CLASS_MAPPINGS = {
    "EmptyQwenImage21LatentImage": EmptyQwenImage21LatentImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EmptyQwenImage21LatentImage": "Empty Qwen Image 2.1 Latent",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
