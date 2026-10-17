# 安装

CLI 与 daemon 通过 npm 发布，需要 Node.js 24 或更新版本。桌面 App 从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 下载。

## 从 npm 安装 CLI 与 daemon

```bash
npm install --global @harness-anything/cli@latest @harness-anything/daemon@latest
ha --version
```

预览版使用 `next` channel：

```bash
npm install --global @harness-anything/cli@next @harness-anything/daemon@next
```

## 安装桌面 App

从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 下载与 npm 相同版本的安装包。
macOS 仅 Apple Silicon arm64（dmg/zip）；Windows 为 x64 NSIS，首次运行可能出现 SmartScreen；Linux 提供 x64 AppImage 或 deb。
AppImage 自动更新，deb 手动升级。

## 前置条件

- Node.js 24 或更新版本，以及 npm。
- `git`。
- 一个可初始化的 git 仓库，或已经注册到本机 daemon 的仓库。

## 首次运行

`ha init` 从当前目录推导仓库 ID，从 `git config user.name` 推导 owner 身份。daemon 状态默认写到 `~/.harness`，仓库账本保留在所选仓库。

## 卸载

运行 `npm uninstall --global @harness-anything/cli @harness-anything/daemon`。只有明确要删除 daemon registry 与 cache state 时才删除 `~/.harness`。
