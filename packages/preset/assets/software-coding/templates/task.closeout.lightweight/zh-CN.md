# Closeout

这个文件是 issue 时物化的固定骨架，直接改写每一节的内容即可；提交只读取正文，不比较章节标题，也不检查是否还留着提示句。lightweight 收口只答两件事：交付了什么、用哪条命令验证的。Fact 与 decision 记账在本 profile 下不是完成前置，发生了仍照常记。

## Summary

总结完成的行为变化。submission 会冻结 `commitSha`、`changedFiles` 和代码 cut 的 `productionDelta` 等机器派生事实；直接引用这些字段，不要手抄数值。

## Verification

一行测试命令与回执：写下你跑的命令和它的结果（退出码或通过计数）。其余适用的检查与已接受的残余风险，如有就附在本段内；本 profile 不设独立的 Residual Risk 与 Same Mechanism Elsewhere 段。
