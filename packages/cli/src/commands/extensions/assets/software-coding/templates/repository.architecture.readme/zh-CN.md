# 仓库架构

## Purpose

本目录是 coding vertical 中帮助 Agent 在修改代码前理解仓库的长期导航面。模型保持在组件或子系统粒度，不把架构图维护成文件清单。

## Activation

仅有本 README 不会启用架构功能。只有同目录存在 `architecture-manifest.json` 才表示已配置；存在的 manifest 必须使用 `"enabled": true`，删除 manifest 才表示停用。

请显式执行架构初始化，再替换下方 placeholder。Harness 不会自动安装 LikeC4 或 extractor。

## Source of Truth

- `architecture-manifest.json` 负责 provider 路由、model 位置、稳定 view ID、source scope 与 extractor 声明。`modelRoot` 相对 manifest 目录解析；`provider.config` 与所有 `views[].path` 都相对 `modelRoot` 解析。
- 随 vertical 交付的可执行 `architecture-model/v1` 合同负责稳定 metadata key、生命周期取值、关系 expectation、证据格式和必需 view ID；script 与 adapter 必须消费这一权威。
- `model/**/*.c4` 负责人写的架构意图：语义节点、职责、边界和预期关系。
- 自动生成的代码 snapshot 是观察结果，必须位于 authored model 之外，也不能自动回写模型。

Manifest 中的物理路径（`modelRoot`、`provider.config`、`views[].path`）必须相对上文各自定义的解析基准，并使用 NFC 规范化、POSIX 分隔符且可在 Windows 使用。Provider config 与 view target 会在 NFC 规范化并忽略大小写后比较，发生碰撞即为无效配置。Source scope glob 是相对仓库根的 selector 而非物理路径，因此保留 `*`、`?` 等 glob 元字符，但仍禁止 NUL、绝对路径、traversal、反斜杠和前导 `!` negation。

Manifest 通过 `sourceScopes[].nodeId` 把源码范围连接到语义节点；该值必须恰好解析到一个 LikeC4 `metadata.archId` 相同的节点。Scope glob 匹配以仓库根为基准、规范化后的 POSIX 路径：include 取并集，exclude 永远优先，数组顺序没有优先级。映射按 extractor 分别计算，且只考虑该 extractor 的 `sourceScopeIds`：零个命中表示 `unmapped`，多个命中表示有歧义的无效映射。

## Authoring Contract

使用 `metadata.archId` 作为身份。LikeC4 name、完整限定名、显示标题、布局和源码路径变化时都不能改变它。Element `archId` 在整个模型内唯一，relationship `archId` 也在整个模型内唯一。Starter 中的节点与关系均为 `draft` placeholder，必须用仓库证据替换；仍有 placeholder 时 architecture check 应返回无效配置，不能伪报 fresh。

每个 element 记录 `archId`、`status`、`owner`、`responsibilities` 与 `nonResponsibilities`。每条 relationship 记录 `archId`、`status`，以及 `allowed`、`required`、`forbidden` 三种 `expectation` 之一。可选的 `extractorIds` 数组引用 manifest extractor ID；只有显式列出 extractor 的关系才参加对应 drift 比较，而且关系两端的 `archId` 都必须被该 extractor 引用的 scope 覆盖，否则配置无效。未列出 `extractorIds` 的关系仍是可查询的架构意图，不能被猜成 import edge。标记为 `verified` 的 element 或 relationship 必须至少包含一个证据值：`adrRefs` 使用相对仓库根的 POSIX 路径，`decisionRefs` 使用 canonical `decision/<decision-id>` 引用；源码路径只写在 manifest source scope 中。

## Views

V1 合同要求三个稳定 view ID，并让 model 与 view 分文件维护：

- `landscape`：组件级系统全景。
- `write-path`：人写代码的修改/写入路径。
- `runtime`：重要运行时边界。

Agent 引用 manifest 中的稳定 view ID 与节点 `archId`，而不是显示标题。

## Agent Query Routing

跨模块改代码前，只回答最小必要问题集：哪个稳定 node 负责该行为、它位于哪个 view/flow、直接 incomers/outgoers 是什么、哪些多跳路径受影响，以及为什么所选实现层级是 canonical owner。task 的 `code-impact-analysis.md` 只记录这些稳定引用和当前 snapshot digest。

如果环境已经提供 LikeC4 MCP，使用 `search-element` 或 `read-element` 解析稳定 node，使用 `read-view` 定位声明 flow，使用 `query-graph` 查看直接 incomers/outgoers；只有跨边界修改才使用递归 graph 或 relationship-path 工具。官方 server 可以来自已激活的编辑器扩展、`likec4 mcp` 或 `@likec4/mcp`；MCP 只是可选的查询加速器，不能成为 task 前置条件。

确定性 fallback 始终存在：按上文顺序读取 manifest 与 `.c4` 文本，再运行 `ha script run vertical:software-coding:architecture-check --task <task-id>`。若项目已经提供 LikeC4，可用 `likec4 validate` 检查模型语法。不能为了完成普通 task 自动安装或启动联网工具。

显式解释 check 状态：`not-configured` 表示继续普通 coding 流程；`fresh` 提供应引用的 snapshot digest；`drifted` 必须同时保留模型意图与冲突的代码证据；`invalid` 必须呈现配置问题；`tool-missing` 必须记录缺失工具，并在可行时继续用文本模型导航。docs-only 或明确局部低风险的工作可以写明理由后标 N/A，无需运行外部查询。

## Validation

用随 vertical 交付的 `architecture-manifest/v1` 合同校验 manifest。若项目显式提供 LikeC4，则从 manifest 的 `modelRoot` 运行 `likec4 validate`。工具缺失是确定性的降级状态，不能因此自动联网安装。

阅读顺序：manifest、相关 view、被引用的节点和关系、对应 ADR/decision 证据。若自动 snapshot 与模型冲突，必须呈现冲突，不能静默修改任一侧。

## Migration and Conflicts

初始化遵守 no-overwrite。已有架构文件必须人工审查并迁移；初始化器报告全部冲突路径并保持现有内容不变。Authored intent 应提交版本库，generated/local snapshot 则遵循仓库自身策略。
