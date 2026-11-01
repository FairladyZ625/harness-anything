# 安装

CLI 与 daemon 需要 Node.js 24 或更新版本，目前尚未发布到公开 npm registry；发布前请使用[源码安装技能](../../../skills/harness-download/SKILL.md)。桌面 App 从 [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases) 下载。

## CLI 与 daemon

0.0.1 正式发布到 registry 后，可以全局安装面向用户的 package：

```bash
npm install --global @harness-anything/cli@0.0.1 @harness-anything/daemon@0.0.1
ha init
```

发布前继续使用源码 checkout 路径：[源码安装技能](../../../skills/harness-download/SKILL.md) 会一次构建 CLI、daemon 与 GUI，并把构建后的 `ha` 放进当前 shell 的 PATH；需要长期 PATH 或 `npm link` 时先向你展示提案并取得同意。

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

## 卸载

不再需要时可删除源码 checkout。Daemon state 与代码分开保存在 `~/.harness`；只有明确要删除 registry 与 cache state 时才删除它。
