# 安装

0.0.1 是第一个 macOS Local 发布候选版。桌面应用和 daemon 都只在你的 Mac
上运行；不需要 Harness Anything 服务器，也不需要拉取源码。

## macOS 要求

- Apple 芯片 Mac（arm64），macOS 12 或更新版本。
- `git`。先运行 `git --version`；如果 macOS 提示安装 Command Line Tools，请在
  首次启动前完成安装。
- 一个已有、且你有权初始化的 git 仓库。

桌面应用自带 Node.js runtime。只有安装独立 npm CLI 时才要求 Node.js 24。

## 从 GitHub Releases 安装 DMG

1. 从 `gui-v0.0.1` GitHub Release 下载
   `Harness-Anything-0.0.1-arm64.dmg` 与 `SHA256SUMS-macos-arm64.txt`。
2. 校验 checksum：

   ```bash
   shasum -a 256 Harness-Anything-0.0.1-arm64.dmg
   ```

3. 打开 DMG，把 **Harness Anything** 拖入**应用程序**。
4. 0.0.1 按裁决有意不签名、也不公证。第一次不要直接双击：在 Finder 的
   “应用程序”里按住 Control 点击或右键点击 **Harness Anything**，选择
   **打开**，然后再次确认**打开**。
5. 如果 macOS 仍然拦截，打开**系统设置 → 隐私与安全性**，找到 Harness
   Anything 被阻止的提示，选择**仍要打开**，完成认证并再次确认。

只使用 GitHub Release 或文档列出的 Homebrew tap。不要对来源不明的应用移除
quarantine 属性。

## 完成首启向导

首启向导有三步：

1. 选择 git 仓库，设置仓库 ID，并填写要写入本地账本的 owner 身份。点击
   **初始化仓库**；应用会创建 `harness/`、注册仓库并启动自带的本地 daemon。
2. 在 **Provider** 工作区添加检测到的 Claude、Codex 或 AGY 安装，并选择模型；
   也可以先继续，以后再设置。
3. 在 **Agent · 含 Squad** 工作区创建 Agent 声明并设置 runtime 偏好。GUI 可正常
   使用后点击**完成设置**。

Harness Anything 默认把 daemon 状态写到 `~/.harness`。仓库账本留在所选仓库
内；整个流程不使用应用服务器。

## 用 Homebrew 安装

仓内 cask 位于 `packaging/homebrew/harness-anything.rb`。tap 仓库发布后运行：

```bash
brew tap FairladyZ625/harness-anything
brew install --cask harness-anything
```

从当前 checkout 发布或验证 cask：

```bash
brew tap-new FairladyZ625/harness-anything
cp packaging/homebrew/harness-anything.rb \
  "$(brew --repository FairladyZ625/harness-anything)/Casks/harness-anything.rb"
brew install --cask --no-quarantine harness-anything
```

`--no-quarantine` 只用于本地 cask 验证。普通用户应保留 Gatekeeper，并使用上面的
右键 → 打开流程。

## 安装 npm CLI

CLI 包发布后要求 Node.js 24 或更新版本：

```bash
npm install --global @harness-anything/cli@0.0.1
ha --version
# 0.0.1
```

`ha` 和 `harness-anything` 是同一条命令的两个名字。安装后运行
`ha capabilities --json` 验证 CLI 入口。

## 源码 demo 与发布录像

贡献者仍可运行 `npm run quickstart:demo`。发布维护者可以用下面的命令准备隔离
demo 仓库并启动 macOS 录屏流程：

```bash
npm run release:demo:record
```

## 卸载

退出 Harness Anything，把 `/Applications/Harness Anything.app` 移到废纸篓
（或运行 `brew uninstall --cask harness-anything`）。只有明确要删除本地 daemon
注册表和缓存时才删除 `~/.harness`；所选仓库内的 `harness/` 账本不会自动删除。

## 故障排查

- **“App 已损坏”或无法打开**——从 GitHub Release 重新下载，校验 SHA-256，
  然后使用右键 → 打开。
- **daemon unavailable**——退出并重开应用；仍然失败时查看 `~/.harness/logs/`，
  报 bug 时附上日志片段。
- **未检测到 Provider**——安装对应 CLI，确认它在 shell PATH 上，然后回到
  Provider 工作区刷新探测。
- **`ha: command not found`**——重新安装 npm CLI，并确认 npm global bin 在 PATH 中。

下一步：**[你的第一个循环](02-first-loop.md)**
