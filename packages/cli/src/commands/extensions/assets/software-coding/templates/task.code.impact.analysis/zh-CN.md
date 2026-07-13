# {{title}} — 代码影响面分析

## Change Intent

描述计划改变的行为，以及支撑这项变化的证据。

## Affected Surfaces

| 影响面 | 当前行为 | 预期变化 | 证据 |
| --- | --- | --- | --- |
| 源码模块 | | | |
| 公共 API 或 CLI | | | |
| 配置或 schema | | | |
| 文档或示例 | | | |

## Dependency Paths

- 直接调用方与消费者：
- 上游依赖：
- 下游投影、生成资产或集成：

## Architecture Context

- 适用性：enabled；若为 docs-only / 明确局部低风险工作则可填 N/A（必须写理由）：
- Manifest 与 check 状态：absent (`not-configured`)、`fresh`、`drifted`、`invalid` 或 `tool-missing`：
- 稳定 node ID 与 canonical owner：
- 稳定 view / flow ID：
- 直接 incomers/outgoers；适用时记录受影响的多跳路径：
- 选择的实现层级及其应负责本次修改的理由：
- Snapshot digest（或无法取得的原因）：
- 必须保持可见的模型/snapshot 冲突：
- 关联 ADR 路径与 canonical `decision/<id>` 引用：
- 查询证据：使用的 LikeC4 MCP tool，或 CLI/文本模型 fallback：

## Compatibility and Data

- 兼容性承诺：
- 持久化数据、迁移或回滚影响：
- 安全、隐私或权限影响：

## Test and Verification Impact

- 需要新增或更新的测试：
- 受影响的现有 gate：
- 手工或集成验证：

## Risks and Unknowns

- 已知风险：
- 未决问题：
- 明确不受影响的范围：

## Evidence

链接已检查的文件、搜索、trace、测试或其他可复现来源；将观察事实与假设分开记录。
