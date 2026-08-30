# CI 与证据

定向测试、manifest-selected workflow job、本地 GitHub 凭证窄例外和 typecheck 的当前
命令统一放在
[Run local gates](../../../skills/harness-contributing/SKILL.md#run-local-gates)。
该节是执行权威；本页只解释结果代表什么。

## Gate 权威

`tools/gate-manifest.json` 按 tier 分类 gate，并映射到 GitHub workflow job。贡献者选择
拥有本次改动面的 job，并通过 manifest runner 执行。记忆中的 package script 列表不能
替代 manifest，因为 manifest 和 workflow 都会演进。

GitHub required PR contexts 始终是权威。本地通过是 review evidence，不是跳过 CI 的
许可。同样，给 `main`、schedule 或 manual dispatch 使用的 aggregate full-check lane
不是标准 pre-PR loop。

## 证据标准

有效证据要写明精确命令、结果、scope，以及未运行时的原因。“有信心”和单独一句“不需要”
都不是证据。PR 应让 reviewer 能区分：相关检查已通过、无关检查按 scope 未运行、或检查
仍在 GitHub 等待。

检查失败时，阅读实际输出，修 contribution branch，重跑能证明修复的最小测试和受影响
manifest job，再让 GitHub 检查新 commit。失败 gate 是 review record 的一部分，不能靠
改写历史或绕过保护来消失。
