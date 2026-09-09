# 可选本地 AI 动作制作组件 · protocol v1

主应用不包含 Python、模型或数值计算库。用户仅在「从动作视频创建」中
选择本地 AI 并点击下载后，才安装独立组件。取消下载清理本次暂存文件，
下次重新下载；当前不支持断点续传。没有云端推理或按次费用。

## 架构与范围

- WebView 解码视频并依次写入最多 1280px 的 24 张 PNG，沿用原采样时刻。
- Rust 只允许主面板调用；任务路径由后端生成，不接受任意输出路径。
- 独立 worker 执行与已认可实验一致的 BiRefNet → trimap → PyMatting
  alpha/前景颜色估计；整段统一裁切，预乘透明通道缩放，输出 6×4、320px。
- 没有静默回退到旧颜色算法；失败会提示。基础颜色抠图仍是明确的可选项。
- 正常完成、失败、取消均清理本次临时帧；应用退出终止 worker。
- 成果进入原有「预览确认 → 保存动作 → 加入指定宠物」路径，不自动替换内置动作。
- NumPy、模型不会加载到 Tauri 主进程；每次任务结束 worker 退出释放内存。

## 本机构建

在单独 Python 3.13 环境安装 requirements.txt，然后执行：

```sh
python components/matting/build.py --model /absolute/path/model.onnx --output /absolute/path/component-output
```

输出 zip 与同名 json（包含大小、SHA256、平台与协议版本）。macOS 构建
必须在 Apple Silicon 上运行；Windows x64 必须在 Windows 上构建和实测。
Python 和依赖都封装在组件中，最终用户不需要自行安装。

## 发布与许可证（维护者操作）

先提交代码并手动运行 GitHub 的 `Build optional AI component` 工作流。
工作流会在 macOS Apple Silicon 与 Windows x64 上分别构建、校验模型哈希、
运行 worker 测试，并把 ZIP/JSON 暂存为 artifacts；默认还会自动建立或更新
独立的 `ai-matting-v1` Release。

Release 文案必须说明：视频与图片仅在本地处理、模型为 BiRefNet Lite ONNX、
处理结果需由用户预览确认。每个组件 ZIP 都必须保留 `licenses/` 中的
`BiRefNet-LICENSE.txt`、`THIRD_PARTY.md` 与依赖许可证；不得删除或改写模型
版权与许可证文本。

仓库固定为 `p5h717774941-sketch/desktop-pet`。下载器只接受固定来源、平台和
文件名，经 HTTPS 获取清单，校验 zip 大小和 SHA256，安全解压（拒绝越界、
符号链接和异常解压大小），再验证固定模型 SHA256。安装在应用数据目录，
无管理员权限要求。模型原始许可和依赖许可随组件分发。

未发布资源时，应用明确显示「组件尚未发布」，不会假装安装成功。
不要覆盖已发布的组件文件；同一 v1 如需修复，只能在确认兼容后更新 Release，
重大升级应同时更新后端固定版本、协议与工作流文件名。
本地 Mac 测试通过不代表 Windows 真机或所有 macOS 版本已通过。
