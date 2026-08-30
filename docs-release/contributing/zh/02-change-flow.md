# 改动流程

可执行的编辑、test tier、定向测试和 commit 序列统一放在
[Make the change and test its surface](../../../skills/harness-contributing/SKILL.md#make-the-change-and-test-its-surface)
与
[Commit with the contributor identity](../../../skills/harness-contributing/SKILL.md#commit-with-the-contributor-identity)。

## 可审查范围

一份贡献只解决一个公开问题，并明确允许改动面、排除面和证明方式。无关清理应进入另一
issue/PR，除非它阻塞已接受的改动。dependency、package 和 release-adjacent 改动必须
明确说明影响，因为很小的文本 diff 也可能改变交付边界。

## 架构预期

git 中的 Markdown 是 authored source，派生 store 是可重建 projection。贡献不得引入
第二份 authored truth，也不得绕过现有承重写入路径。优先保持当前 package boundary
和 public surface；若它们无法承载行为，PR 必须解释原因。

CLI 行为只有在 registered command、descriptor、help、structured receipt、error
contract 和相关测试一致时才算完整。公开文档位于 `docs-release/`、根 README 和 package
README，并且必须如实描述当前 release posture，不能承诺尚未交付的产品。
