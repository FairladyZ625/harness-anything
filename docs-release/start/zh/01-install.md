# 安装

## 前置条件

- **Node.js 24 或更新版本。** CLI 在 Node 24 和 26 上测试过。
- **git。** Harness Anything 写入 git 仓库并以之为真实来源。

查看你的 Node 版本：

```bash
node --version   # must be >= 24
```

## 安装 CLI

目前还没有公开的 npm 发布——当前分发是从源代码检出的**本地全局安装**。从仓库根目录：

```bash
npm ci
npm run build
npm install -g .    # installs the `ha` command (and its `harness-anything` alias)
```

确认它在你的 PATH 上：

```bash
$ ha --version
harness-anything 0.0.0
```

`ha` 和 `harness-anything` 是同一条命令；`ha` 是这些文档里用的短别名。

## 检查你的环境

`ha doctor` 是一个只读诊断。它报告你的 Node 版本、你是否在 git worktree 内、是否存在 `harness/` 状态、以及下一步运行什么。它永远不会创建或编辑任何东西。

```bash
$ ha doctor
ok command=doctor summary="completed doctor"
```

加 `--json` 看完整的结构化报告。

## 故障排查

- **`ha: command not found`**——全局 bin 目录不在你的 PATH 上。运行 `npm bin -g` 找到它并加到你的 shell 配置里。
- **Node 太旧**——你会在启动时看到运行时错误。升级到 Node 24+ 并重新运行 `ha --version`。
- **其他任何问题**——先运行 `ha doctor --json`；它通常直指问题。

下一步：**[你的第一个循环](02-first-loop.md)**
