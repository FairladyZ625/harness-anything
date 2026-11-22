# 交付物简报

## Deliverable Scope

明确交付物类型（`proposal`、`report`、`specification`、`briefing`、`checklist` 或 `other`）、回答的核心问题以及明确不包含的内容。

## Audience and Format

写明主要阅读者或决策方、必填章节结构，以及位于 `artifacts/` 下的正式交付文件路径。

## Upstream Baselines

记录依赖的每项上游输入引用及其 SHA-256 基线摘要（启用 `upstream-fresh` 时同步登记于 `artifacts/upstream-freshness.json`）。

## Review Checklist

- 交付物清单（`artifacts/deliverable-manifest.json`）中的摘要与已提交交付文件 SHA-256 一致。
- 所有声明的必填章节均存在且包含实质内容。
- 关键断言均附可复核来源，未核实项已显式标明。
