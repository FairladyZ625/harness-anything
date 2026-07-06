# 改动流程

## 从一个可审查范围开始

一份贡献应该能回答：

- 它解决什么问题？
- 哪些文件或 surface 可以改变？
- 哪些明确不在范围内？
- 什么证据能证明它成立？

把无关清理留在 PR 外。如果你发现旁边还有一个 bug，只有当它阻塞当前改动时才一起修；否则开独立
issue/PR。

## 尊重架构边界

Harness Anything 把 git 里的 Markdown 当成 authored source of truth，把派生存储当成可重建投影。
不要为 task、decision、fact 或 relation 引入第二个 source of truth。不要绕过承重 authored
record 的写入路径。

改应用行为时，优先使用现有 package boundary 和 public surface。除非现有 public surface 无法表达本次改动，
且 PR 明确解释原因，否则避免跨 package deep import。

## 使用现有命令面

CLI 改动要同时经过已注册 command、descriptor、help 文本、receipt shape、error code 和测试。
一个命令即使能跑，如果不能通过 `--help` 被发现、不能输出结构化结果，或返回未注册错误形态，都还没完成。

如果在 `packages/**` 或 `tools/**` 下新增或修改测试，同步更新 `tools/test-tier-manifest.mjs`。
未分类测试预期会 fail closed。

## 文档改动

公开用户文档放在 `docs-release/`、根 README 和 package README。根 `docs/` 不是这个仓库的公开 release
渠道。

文档必须诚实描述当前 release 姿态。除非 release posture 和 gates 已先改变，否则不要声称已经有公开 npm 包、签名
installer、notarized build、hosted service 或完整 GUI 产品。

docs-only PR 也必须把 private-boundary 和路径泄漏检查当成真实 gate。公开文档不得暴露私有计划路径、本机文件系统路径或未发布的运行状态。

## 依赖和 package 改动

依赖、package 和 release-adjacent 改动的 review 负担更高。除非 PR 明确是 release-boundary 任务，
否则必须保持当前 package policy：

- 在明确 publish task 前，workspace packages 保持 private；
- PR 必须说明 version 与 publish impact；
- 即使代码 diff 很小，也可能需要 package smoke 和 supply-chain 检查。

## Commit 纪律

commit message 按约定保持简洁英文。完整双语解释放在 PR body。

commit 前：

```bash
git status --short
git diff --check
```

只 stage 属于本次 scope 的文件。不要 reset、重排格式或 stage 别人的无关本地改动。
