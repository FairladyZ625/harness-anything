# 本地准备

## 前置条件

使用公开文档里的同一条基线：

- Node.js 24 或更新版本。CI 覆盖 Node 24 和 Node 26。
- git。
- 本仓库的干净源码 checkout。

从仓库根目录运行：

```bash
npm ci
```

目前还没有公开 npm package release。产品使用和本地源码运行见
[start/install](../../start/zh/01-install.md)。贡献本仓代码时，从 checkout 工作并使用
workspace scripts。

## 使用 branch 或 worktree

不要直接编辑共享 `main`。先基于最新 upstream：

```bash
git fetch origin
git switch -c <branch-name> origin/main
```

Agent 写的实现分支应使用本仓约定：

```bash
git switch -c codex/<short-scope> origin/main
```

如果有多个 agent 并行，或需要把本地协调和公开实现隔离开，优先使用 git worktree：

```bash
git worktree add .worktrees/<short-scope> -b codex/<short-scope> origin/main
```

每个并发 agent 使用自己的 branch 或 worktree。两个 agent 编辑同一个 working tree 是协调
失败，不是 merge 策略。

## 分开公开文件和本地文件

公开 PR 可以包含仓库代码、工具、CI 文件、公开文档和 fixture。不得包含：

- 根目录本地 agent 入口文件，例如 `AGENTS.md` 或 `CLAUDE.md`；
- 未刻意公开的本地 harness 或计划记录；
- 生成缓存目录；
- 编辑器、Finder、操作系统或机器本地文件；
- secret、token、私有 URL 或本机绝对路径。

stage 前先运行 `git status --short`。只 stage 属于本次贡献的路径。

## 命令名

使用当前 CLI 命令面：

```bash
ha <command>
npx harness-anything <command>
```

不要在这个 checkout 里使用 stale 的 `harness` / `npx harness` 命令面。

如果改了 `packages/cli/src`，在依赖 workspace bin 前先重建 CLI：

```bash
npm run build -w @harness-anything/cli
```

迭代 CLI 行为时，也可以直接跑源码入口：

```bash
node packages/cli/src/index.ts --json doctor
```

## 开始编码前

用一句话写清 scope。如果你说不清 PR 允许改哪些文件或行为，先收窄再动手。把实现、release
姿态、无关清理和 docs 重写混在一起的贡献很难 review，也更容易被退回。
