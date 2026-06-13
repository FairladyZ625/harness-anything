<div align="center">

# Harness Anything

**面向长周期软件工作的 Agent 任务 Harness。**

<p>
  <a href="#工作方式">工作方式</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#包结构">包结构</a> ·
  <a href="#贡献">贡献</a>
</p>

<p>
  <a href="./LICENSE"><img alt="License: AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml"><img alt="CI" src="https://github.com/FairladyZ625/harness-anything/actions/workflows/rewrite-ci.yml/badge.svg"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/FairladyZ625/harness-anything?style=flat&logo=github&color=yellow"></a>
  <a href="https://github.com/FairladyZ625/harness-anything/issues"><img alt="Issues" src="https://img.shields.io/github/issues/FairladyZ625/harness-anything"></a>
  <img alt="Status: early" src="https://img.shields.io/badge/status-early%20%26%20unstable-orange">
</p>

<p>
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

</div>

---

Harness Anything 为 coding agent 提供一层持久的任务结构：本地任务包、治理检查、迁移证据，以及一个足够小的 kernel。CLI、GUI 和 adapter 都可以构建在它之上，但不拥有生命周期状态。

Agent 越来越擅长改代码，但它们仍然需要一种可靠方式来跨长会话承载工作、拆分任务、保留 review 证据，并证明本地状态没有偏离仓库。Harness Anything 把这层操作系统变成一等的、可检查的工程制品。

## 工作方式

Harness Anything 围绕一个小内核和明确的扩展层组织。

| 层 | 作用 | 当前状态 |
| --- | --- | --- |
| **Kernel** | 拥有领域类型、schema、任务投影、生命周期校验和存储端口。 | 已在 `@harness-anything/kernel` 中实现。 |
| **CLI** | 暴露 init、doctor、status、check、任务操作、迁移证据和 Git diff 证据等本地命令。 | 已在 `@harness-anything/cli` 中实现。 |
| **Application layer** | 将 controller/service 编排从 UI 和 adapter 代码中隔离出来。 | 已在 `@harness-anything/application` 中实现。 |
| **GUI foundation** | 提供 Electron 桌面壳和 view model 边界。 | `@harness-anything/gui` 中已有早期基础。 |
| **Adapters** | 连接外部系统，但不接管 Harness 状态。 | Adapter 包结构已存在；外部写入 adapter 不属于 M2 声明范围。 |

产品模型刻意保持可组合：

- **Kernel first。** Kernel 保持小而保守。
- **Verticals add domain shape。** Vertical 定义任务领域、契约和 authored package 约定。
- **Presets add workflow choices。** Preset 可以为具体用例添加或删除模板、检查和操作假设。
- **Adapters stay at the edge。** Adapter 收集或发布证据，但不成为任务生命周期状态的事实来源。

## 这是什么

- 一个 local-first 的 coding-agent 任务 harness。
- 一个 TypeScript monorepo，包含 kernel、CLI、GUI、application 和 adapter 包。
- 一套治理表面，用于检查任务包、文件复杂度、import 边界、private/public 边界、schema 契约和 Legacy Intake readiness。
- 面向公开 Harness 产品表面的 clean-room rewrite workspace。

## 这不是什么

- 不是 agent runtime、model router 或 chat UI。
- 不是 Git、GitHub 或 CI 的替代品。
- 不是云端任务数据库。
- 还不是已发布的 npm release。M2 阶段刻意保持 packages 为 `private: true`，版本为 `0.0.0`。

## 快速开始

使用 Node.js 24 或更高版本。

```bash
npm ci
npm run typecheck
node packages/cli/src/index.ts --json doctor
```

最小项目循环：

```bash
node packages/cli/src/index.ts --root /path/to/project --json init
node packages/cli/src/index.ts --root /path/to/project --json new-task --title "First task"
node packages/cli/src/index.ts --root /path/to/project --json status
node packages/cli/src/index.ts --root /path/to/project --json check --post-merge
```

当前 coding-agent dogfood 使用 coding vertical 和 preset surface 创建新任务，
再通过 review/CI closeout gate 完成任务：

```bash
node packages/cli/src/index.ts --root /path/to/project --json new-task --title "Implement slice" --vertical software/coding --preset standard-task
node packages/cli/src/index.ts --root /path/to/project --json task-complete <task-id> --ci passed --reviewer <reviewer-id>
```

未完成的旧任务状态只作为 Legacy Intake 证据处理。把它带 provenance
重建成新的 Harness 任务，不承诺自动批量转换：

```bash
node packages/cli/src/index.ts --root /path/to/project --json new-task --from-legacy <legacy-id>
```

公开提交前运行完整仓库检查：

```bash
npm run check
```

## 包结构

这个仓库是单一 Git monorepo。`packages/` 下的包是 npm workspace package，不是嵌套 Git 仓库。

| Package | Purpose |
| --- | --- |
| `@harness-anything/kernel` | 领域模型、schema、生命周期校验、任务投影和存储端口。 |
| `@harness-anything/cli` | 面向 project、task、migration、evidence 和 check 工作流的本地命令表面。 |
| `@harness-anything/application` | CLI 和 GUI 共享的 controller/service 层。 |
| `@harness-anything/gui` | Electron GUI 基础和 renderer 边界。 |
| `@harness-anything/adapter-github-issues` | GitHub Issues 集成工作的 adapter 包位。 |

## 文档

- [M1 minimal loop](./docs-release/m1-minimal-loop.md)
- [M2 coding vertical](./docs-release/m2-coding-vertical.md)
- [Harness agent skill](./docs-release/harness-agent-skill.md)
- [Minimal example project](./examples/minimal-project/)

Private planning、architecture、review state 和 task ledger 位于 public docs tree 之外的 `.harness-private/` 中，并且会被本仓库刻意忽略。

## 项目状态

这个仓库工作流的 M2 Legacy Intake readiness evidence 已完成。

当前 release 边界：

- Packages 仍保持 `private: true`。
- Workspace versions 仍保持 `0.0.0`。
- 不声明任何 npm package release。
- 完整本地 gate 是 `npm run check`。

在公开 package surface 稳定前，请预期 breaking changes。

## Roadmap

**M2 - coding vertical workflow**

- [x] Kernel、CLI、package layout、governance checks、behavior corpus 和 Legacy Intake readiness evidence。
- [x] Legacy Intake 和 private CLI package artifact 的本地 smoke 覆盖。
- [ ] npm package publication。

**Next**

- [ ] Public package release plan 和 package boundary review。
- [ ] 在当前基础之上继续硬化 GUI workflow。
- [ ] 在 kernel/CLI contract 稳定后实现外部 adapter。
- [ ] 更多 vertical 和 preset 示例。

## 贡献

当前最有价值的贡献是尖锐的 bug report、可复现失败测试、架构问题和小型文档修正。

提交 pull request 前：

```bash
npm run check
```

请不要把 private harness state 放入公开变更。不要把 `.harness-private/`、root-local agent instructions 或 private planning docs 加入 public commit。

## License

[AGPL-3.0-or-later](./LICENSE)。Harness Anything 保持任务 harness 开源，包括有人将它作为服务提供时。
