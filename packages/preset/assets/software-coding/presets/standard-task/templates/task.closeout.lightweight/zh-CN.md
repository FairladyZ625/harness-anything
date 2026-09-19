# Closeout

收口前必须替换本文件占位内容；`ha task complete` 会拒绝占位文本。lightweight 收口只答两件事：交付了什么、用哪条命令验证的。Fact 与 decision 记账在本 profile 下不是完成前置，发生了仍照常记。

## Summary

总结完成的行为变化。必须点名恰好一个交付 commit 的完整 40 位小写 SHA（合入 PR 的交付写 merge commit），或至少一个 `artifact:<path>@<revision>` 锚点；缺了 `ha task submit` / `ha task settle` 会以 `document_invalid` 拒收。

## Verification

一行测试命令与回执：写下你跑的命令和它的结果（退出码或通过计数）。其余适用的检查与已接受的残余风险，如有就附在本段内；本 profile 不设独立的 Residual Risk 与 Same Mechanism Elsewhere 段。
