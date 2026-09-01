# 安装

Harness Anything 当前从源码 checkout 运行，需要 Node.js 24 或更新版本。受支持的桌面入口只有
`ha gui`；直接启动 packaged Electron executable 不是受支持的生产路径。

## 前置条件

- Node.js 24 或更新版本，以及 npm。
- `git`。
- 一个可初始化的 git 仓库，或一个已经注册到本机 daemon 的仓库。

## 安装源码 CLI 与 GUI

```bash
git clone https://github.com/FairladyZ625/harness-anything
cd harness-anything
npm ci
npm run build -w @harness-anything/cli
(cd packages/cli && npm link)
ha --version
```

global link 会把 `ha` 固定到这份 canonical checkout。不要把它指向 feature worktree：worktree 是仓库
上下文，不是 daemon 或 GUI 的安装 owner。

## 启动 Electron GUI

在要打开的仓库中运行：

```bash
ha gui
```

也可以从任意目录显式选择仓库：

```bash
ha gui --root /path/to/repository
```

`ha gui` 会从 canonical installation 重建 renderer 与 preload，通过其他 `ha` 命令共用的
canonical-only CLI autostart 路径取得 default daemon，再 detached 启动 Electron。所选目录只决定仓库
上下文。关闭 Electron 永远不会停止 daemon；operator 停止 daemon 后，已经打开的 GUI 也永远不会重启它。

`npm run dev:electron` 只是 GUI 贡献者使用的 package-local hot-reload 工具，不是用户启动命令。

## 完成首启向导

首启向导有三步：

1. 选择 git 仓库，设置仓库 ID，并填写写入本地账本的 owner 身份。点击**初始化仓库**；应用会创建
   `harness/`，并把仓库注册到 CLI 在 Electron 启动前取得的 daemon。
2. 在 **Provider** 工作区添加检测到的 Claude、Codex 或 AGY 安装并选择模型；也可以先继续，以后再设置。
3. 在 **Agent · 含 Squad** 工作区创建 Agent 声明并设置 runtime 偏好。GUI 可正常使用后点击**完成设置**。

Harness Anything 默认把 daemon 状态写到 `~/.harness`。仓库账本留在所选仓库内；整个流程不使用应用服务器。

## 只安装 npm CLI

独立 CLI 包发布后要求 Node.js 24 或更新版本：

```bash
npm install --global @harness-anything/cli@0.0.1
ha --version
```

独立 CLI 包不包含源码 GUI workspace；需要 `ha gui` 时请使用上面的源码安装。`ha` 和
`harness-anything` 是同一命令的两个名字。

## 源码 demo

```bash
npm run quickstart:demo
```

Demo 会创建 throwaway project 并跑通 CLI lifecycle，不改动你选择的仓库。

## 卸载

退出 GUI，在 `packages/cli` 下运行 `npm unlink --global @harness-anything/cli`，不再需要时删除源码
checkout。只有明确要删除 daemon registry 与 cache state 时才删除 `~/.harness`；仓库内的
`harness/` 账本不会自动删除。

## 故障排查

- **`ha: command not found`**——在 `packages/cli` 重新运行 `npm link`，并确认 npm global bin 在 `PATH`。
- **GUI build failed**——在 canonical checkout 运行 `npm ci`，再重试 `ha gui`。
- **daemon unavailable**——运行 `ha daemon status`。如果 operator 有意停止了它，请关闭旧窗口，并从
  operator shell 重新运行 `ha gui`；已经打开的 GUI 不会 respawn daemon。
- **未检测到 Provider**——安装对应 CLI，确认它在 shell `PATH` 上，再刷新 Provider discovery。

下一步：**[你的第一个循环](02-first-loop.md)**
