# Pinkmo · 桌面宠物

> 🐭 黑鼠制作

用 **Tauri 2 + 原生 Rust** 打包的桌面宠物。宠物浮在桌面上，可上传你自己的宠物照片、多只同屏、随机游走、点击互动、定时提醒。数据本地保存，关掉再开还在。

## 运行方式

**前置：**
- 安装 [Rust](https://www.rust-lang.org/)（stable 工具链）
- Node.js 20+

**步骤：**
```bash
cd Pinkmo
npm install
npm run tauri dev        # 开发模式，带热更新
```

打包成独立可分发 app：
```bash
npm run tauri build      # 产物在 src-tauri/target/release/bundle/
```

> 首次 `tauri dev` 会下载并编译 Tauri 全套依赖，约 3–8 分钟；之后增量编译很快。

## 已实现
- 上传宠物图片（PNG/JPG，可一次选多张 = 多只宠物同屏）
- 宠物在桌面随机游走、碰边反弹、偶尔发呆
- 点击互动：单击蹦跳、双击转圈、连点 5 下炸毛，各带分级文字气泡
- 自定义提醒：午饭 / 下班时间可设、健康提醒间隔可设
- 提醒触发时宠物跳到屏幕中央放大 + 气泡喊你
- 宠物窗与控制面板分离；控制面板可最小化，宠物窗保持透明置顶
- macOS / Windows 的透明区动态鼠标穿透，宠物可点击、拖动、追随鼠标
- 2D 精灵动作、日常行为、性格气泡、宠物状态小卡
- 设置与宠物数据 **本地持久化**（Tauri store 插件），关掉再开还在
- 🐭 黑鼠制作署名

## 已知限制 / 后续
- **Windows 验收**：Windows 鼠标钩子已实现，但仍需在真实 Windows 机器上确认点击、拖动和高 DPI 缩放表现。
- **Mac 分发**：正式发布需 $99/年 开发者签名公证（自己开发运行无需）
- **灵动 3D（VRM）**：规划在 v2.0

## 版本路线
| 版本 | 代号 | 内容 |
|---|---|---|
| v0.1 | 幼崽 | 网页原型 |
| **v1.0** | **破壳** | **Tauri 真桌面版（本版）** |
| v1.5 | 投喂 | 喂食 + 宠物状态机（走/睡/吃/发呆） |
| v2.0 | 灵动 | 接入 VRM 模型库，眨眼/姿态/躲避 |
| v3.0 | 羁绊 | 宠物纪念 / 情感付费 |

## 发布到 GitHub

推送 `v*` 格式的标签会触发 `.github/workflows/release.yml`，自动构建 macOS 与 Windows 安装包并创建 GitHub Release：

```bash
git tag v1.10.3
git push origin v1.10.3
```

Windows 会产出 NSIS `.exe`，macOS 会产出 `.dmg` / `.app`。
