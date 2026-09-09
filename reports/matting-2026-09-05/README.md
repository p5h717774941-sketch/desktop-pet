# Pinkmo 本地 AI 抠图首轮实验 · 2026-09-05

结论：本地 AI 分割配合毛发透明度、前景颜色估计，在本轮绿幕猫咪样本上明显优于现有纯颜色工具；蓝幕黑猫仍有反射色。值得继续验证，但尚不适合宣称所有素材一键无残边。

本轮只生成独立对比文件，没有修改 Pinkmo 前端、窗口逻辑或应用数据中的动作，没有替换内置素材。

## 查看结果

- `comparison.jpg`：中文标注的四种素材对比，分别合成到黑、白背景。
- `animation.gif`：墨墨舔爪 24 帧动画；左侧现有算法，右侧 AI 加毛发处理。
- `groom-comparison.mp4`：同一对比的 MP4，约 4.10 秒，共 24 帧。
- `animation-contact.jpg`：整段动画的 24 帧检查图。
- `*-comparison.jpg`：12 张测试帧，每张包含四条处理路线、三种背景。

## 输入与方法

输入为现有墨墨舔爪、睡觉、哈欠视频及粉仔哈欠视频，各取 15%、50%、85% 时刻，共 12 张原尺寸 PNG。墨墨哈欠文件目前是后来更新的蓝色背景，不能把它描述为最初那段绿幕文件。原文件路径、时长和 SHA256 保存在 `manifest.json`。

这是**同一模型、不同后处理**的首轮对比，不是多个 AI 模型的排名。

模型：ONNX Community 的 BiRefNet Lite FP32，224,005,088 字节。

SHA256：`5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333`。本地文件已与发布页校验值核对。

模型与预处理来源：

- https://huggingface.co/onnx-community/BiRefNet_lite-ONNX
- https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/blob/main/preprocessor_config.json

严格采用发布者的 1024×1024 双线性预处理、RGB / 255、ImageNet 均值和标准差、输出 sigmoid。模型预测后还原至原图尺寸，再进行原图上的后处理；最后才缩小显示。

四条路线：

1. 从现有 `src/main.js` 提取原函数，在 512px 画面上运行“毛发优先”。这是同一 JS 抠图函数的离线对照；解码/缩放由 FFmpeg、Pillow 代替 WebView，不能宣称与 WebView 渲染逐像素一致。
2. AI 输出直接作为透明度，保留原 RGB。
3. AI 透明度 + PyMatting `estimate_foreground_ml`，估计边缘前景颜色。
4. AI 掩码构造三分图 + `estimate_alpha_cf` + `estimate_foreground_ml`，再缩放预览。

整段动画使用第 4 条路线。24 帧沿用应用的均匀采样时刻，统一裁切区域，没有逐帧单独缩放，没有额外增加时间平滑。

## 实测表现与限制

- 绿色背景舔爪、睡觉：明显改善现有工具的灰绿外轮廓和脚下残留。
- 蓝色背景墨墨哈欠：脚下背景块去除了，但部分身体外侧仍带蓝色反光；AI 分割不等于自动恢复真实毛色。
- 白猫：轮廓硬边改善；细毛仍需放大和动画确认。原视频底部已裁到身体，抠图不能还原缺失部分。
- 24 帧检查图中未见像旧版那样的大面积身体缺失；动态闪烁是否可接受仍需播放确认，未做完整时序算法或跨平台 UI 验证。
- 本次只在 Mac CPU 推理（4 线程），不是 Windows 实测，不代表 GPU 加速或最终产品速度。
- 12 张样帧的 AI 推理约 6.3–13.7 秒/帧；毛发后处理通常小于 0.5 秒/帧。不包含进程启动和首次编译等待。
- 完整 24 帧测试循环约 189.82 秒，包含逐帧解码、AI、后处理、旧算法对照和 PNG 写出；模型加载和最终视频编码不计入此数。
- 完整实验进程峰值 RSS 为 6437 MiB（约 6.29 GiB），高于四张样帧阶段。实验同时保留模型缓存和对比数据，不能视为产品最低内存需求；接入前必须优化并重新测量。

## 下一步

先由用户确认右侧样张和动画的视觉质量，再处理内存、任务取消/进度、模型下载校验及 Mac/Windows 独立工作进程。当前实验没有打包 AI 组件、生成新安装包或修改用户设置。

若蓝色反光仍不可接受，应将其作为独立的前景颜色恢复问题继续测试，不能用扩大删除范围来替代，也不要求用户立即重做视频。

## 可复现脚本

`prepare_samples.py`、`baseline.cjs`、`evaluate.py` 是本机实验脚本，保留了本机源素材、Node 与模型路径。它们不调用云端推理。依赖复用现有 `venv-rembg`（ONNX Runtime、Pillow、NumPy、SciPy、PyMatting）与 FFmpeg。

```sh
cd /Users/a754/Documents/ChatGPT/Pinkmo
venv-rembg/bin/python reports/matting-2026-09-05/prepare_samples.py
venv-rembg/bin/python reports/matting-2026-09-05/evaluate.py
venv-rembg/bin/python reports/matting-2026-09-05/evaluate.py --sequence
```

详尽数值见 `timings.json`、`extra-timings.json`、`animation-timings.json`。运行时原帧、掩码及 PNG 结果缓存在实验目录；正式产品集成应另外设计缓存清理和资源管理。
