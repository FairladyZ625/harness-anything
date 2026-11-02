# 安装

CLI 与 daemon 需要 Node.js 24 或更新版本，目前尚未发布到公开 npm registry；发布前请使用[源码安装技能](../../../skills/harness-download/SKILL.md)。桌面 App 从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 下载。

## 选择安装入口

- **只装 Harness Anything：** 让 Agent 使用 [harness-download](../../../skills/harness-download/SKILL.md)。
- **同时装 Harness 与 DeepSeek Harness 插件：** 复制 [README 中的 DSH 安装提示词](../../../README.zh-CN.md#同时装-harness-anything-与-deepseek-harness-插件macos)。[harness-dsh-install](../../../skills/harness-dsh-install/SKILL.md) 会复用已有 Harness、补齐缺失技能并保留定制版本，再把从源码构建的 private 插件装到你确认的桌面 profile。需要 macOS 和已安装的 DSH 桌面 App；源码中须已有 `packages/dsh-plugin`。Agent 准备完成后，首选「插件 → 添加插件」填写它给出的绝对 `link:` 路径，CLI 是备选。

## CLI 与 daemon

0.1.0 正式发布到 registry 后，可以全局安装面向用户的 package：

```bash
npm install --global @harness-anything/cli@0.1.0 @harness-anything/daemon@0.1.0
ha init
```

npm 通道是终端-only：不包含桌面 GUI，`ha gui` 会提示安装桌面 App 或可选的 GUI 包。需要桌面界面时，从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 安装桌面 App（内含 `ha`），或把 `@harness-anything/gui` 装进同一个 npm 前缀。

发布前继续使用源码 checkout 路径：[源码安装技能](../../../skills/harness-download/SKILL.md) 会一次构建 CLI、daemon 与 GUI，把构建后的 `ha` 链接到用户自己的 npm 前缀（默认 `~/.local/share/harness-anything-npm`），并打印 `ha` 的绝对路径与可选的 `export PATH=...` 行。安装器不会改写你的 shell 启动文件；新终端里直接使用打印的绝对路径即可，长期使用 `ha` 时再自行把该前缀加入 PATH。

## 安装桌面 App

从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 下载与 npm 相同版本的安装包。
macOS 仅 Apple Silicon arm64（dmg/zip）；Windows 为 x64 NSIS，首次运行可能出现 SmartScreen；Linux 提供 x64 AppImage 或 deb。
AppImage 自动更新，deb 手动升级。

## 前置条件

- Node.js 24 或更新版本，以及 npm。
- `git`。
- 一个可初始化的 git 仓库，或已经注册到本机 daemon 的仓库。
- 初始化仓库前需要配置授权服务并登录用户；见[Server Daemon 运维](../../operations-server-daemon.zh-CN.md)。

## 首次运行

`ha init` 从当前目录推导仓库 ID，从 `git config user.name` 推导 owner 身份。daemon 状态默认写到 `~/.harness`，仓库账本保留在所选仓库。

配好 Provider 运行时实例后，可直接使用内置的 `worker`、`reviewer`、`commander` 三个身份。启用实例与首次派工见[从内置身份开始](03-daily-commands.md#从内置身份开始)。

## 卸载

不再需要时可删除源码 checkout。Daemon state 与代码分开保存在 `~/.harness`；只有明确要删除 registry 与 cache state 时才删除它。
