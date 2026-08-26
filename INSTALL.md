# Pinkmo v1.10 安装与使用说明

Pinkmo 是一款独立的桌面宠物应用。安装后会有两个窗口：透明置顶的宠物窗，以及可最小化的控制面板。

## 下载哪个文件

- **Windows**：下载 `Pinkmo_*_x64-setup.exe`。
- **macOS Apple 芯片**：下载 `Pinkmo_*_aarch64.dmg`，适用于 M1、M2、M3、M4 等机型。

## Windows 安装

1. 双击 `.exe` 安装包，按提示完成安装。
2. 若 Windows SmartScreen 提示“Windows 已保护你的电脑”，请确认安装包来自 Pinkmo 的官方 GitHub Release，再点“更多信息”→“仍要运行”。
3. 从开始菜单打开 Pinkmo。控制面板可最小化；宠物会继续留在桌面上。

## macOS 安装

1. 双击 `.dmg`，将 `Pinkmo.app` 拖入“应用程序”。
2. 本版本尚未进行 Apple Developer 签名和公证。首次打开时如果 macOS 拦截，请在“应用程序”中按住 Control 点击 `Pinkmo.app`，选择“打开”，再确认一次“打开”。
3. 若仍被拦截，前往“系统设置”→“隐私与安全性”，在页面底部选择仍要打开 Pinkmo。

> 请只从 Pinkmo 的官方 GitHub Release 下载未签名版本。

## 第一次使用

1. 控制面板的“上传宠物”可添加普通图片或 2D sprite sheet。
2. 在“宠物仓库”中放出、收回宠物，也可以替换独立封面。
3. 在“设置”中调整宠物大小、说话风格、闲置靠近时间与开关。
4. 鼠标停在宠物上可看到状态小卡；拖动、点击和提醒都会触发互动。

## 卸载

- **Windows**：在“设置”→“应用”中卸载 Pinkmo。
- **macOS**：退出 Pinkmo 后，将“应用程序”里的 `Pinkmo.app` 移到废纸篓。

宠物和设置保存在本机；卸载应用后，如需彻底清除数据，请再手动删除 Pinkmo 的本地应用数据目录。
