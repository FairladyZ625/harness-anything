# 发布状态边界

状态：这是发布治理的唯一公开锚点。本页负责说明哪些能力已经可用，哪些只是机制已完成但还没有产品化，哪些只是基础切片，哪些仍是实验性能力，哪些仍在计划中。其他公开文档应该链接到这里，而不是复述状态表。

## 状态词表

- Shipped：可以从本仓库通过已文档化或可发现的公开命令面使用，并且背后有实现证据、测试或 gate。
- Mechanism-complete：实现路径或 gate 已经存在于代码中，但面向用户的工作流仍缺产品文档、使用证明、清理工作或发布证据。它是真机制，不是打磨完成的产品。
- Foundation：公开合同、模型、构建、策略或护栏已经存在，但最终用户能力尚未发布。
- Experimental：只覆盖某个拓扑或会话形态的窄原型或 shim，存在已知限制，不能作为通用支持承诺。
- Planned：尚未作为受支持能力实现，或明确归属于后续里程碑或任务包。

## 能力状态

| 范围                      | 状态         | 边界和证据                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码 CLI 写路径           | Shipped      | CLI 写命令需要显式 actor 归属与 git author。`HARNESS_ACTOR` 继续用于 `agent:<id>` 与 `system:<id>`；human 写入必须使用 `--actor human:<id>`，因为环境变量会被继承。journal 会记录 `env`、`flag` 或 `daemon` source。示例使用 `HARNESS_GIT_AUTHOR_NAME` / `HARNESS_GIT_AUTHOR_EMAIL`，也可 fallback 到 Git author 变量。证据：`packages/cli/src/composition/actor-attribution.ts`。 |
| 任务层级与关系语义        | Shipped      | `ha task create --parent <id>`、`ha task tree <id> [--json]`、`ha task relate <src> depends-on <tgt> --rationale <t>` 已存在，并且 depends-on 有环检测。父任务完成不要求子任务完成；只会发出 `open_child_tasks` 软告警。`parent` 字段创建后不可变。证据：canon 1.4。                                                                                                               |
| 本地 daemon，包括单机多仓 | Shipped      | `ha daemon start`、`ha daemon repo register`、热注册 reconcile、按 repo 路由的 CLI 本地 daemon 模式都可用。CLI 默认仍是进程内 direct 模式；只有设置 `HARNESS_DAEMON_MODE=local` 才走 daemon。证据：canon 1.3。                                                                                                                                                                     |
| 桌面 GUI 源码界面         | Foundation   | GUI 可以从源码构建和运行，并且若干视图能读取真实 ledger 数据，但状态变更、review、追加进度、archive、决策裁决、terminal、presets、adapters，以及部分 relations，仍是仅 state、只读、deferred 或 mock-backed。仓库自我声明状态为 `source-checkout-and-package-smoke-only`。证据：canon 1.2。                                                                                        |
| Remote SSH daemon 模式    | Experimental | remote 模式会打开 `ssh <host> ha daemon connect --stdio`，连接到已有 daemon。团队 principal 需要逐 key 配置 `authorized_keys` forced command 与 roster credential；relay 会验证 sshd 进程上下文、精确 original command 与固定 root。它不是“GUI 连接远端 daemon”、tunnel 产品、TCP、HTTP 或 WebSocket。证据：`packages/cli/src/commands/daemon/connect.ts`。                        |
| 运行时与发布就绪          | Foundation   | 源码 checkout、Node 24 和 Node 26 CI、package smoke、GUI build 都有可执行 gate。发布产物仍未 ship。证据：`packages/gui/src/distribution/runtime-release-readiness.ts:50-60` 与 canon 1.2。                                                                                                                                                                                         |
| 供应链与许可证 gate       | Foundation   | npm audit、SBOM 校验、OSV 证据路径检查、许可证策略、Dependabot 覆盖、AGPL 网络服务发布说明 checklist，都是 gate 或任务包可检查的策略。发布产物仍未 ship。证据：`package.json:71` 与 `tools/check-supply-chain.mjs:51-74`。                                                                                                                                                         |
| M3-M7 backlog             | Planned      | 外部 adapter 实现、完整 GUI 产品行为与发布硬化都尚未 ship。占位 adapter package、仅页面级 GUI 代码、未签名产物、纯发布策略 prose，都不能被继承为已 ship 产品状态。                                                                                                                                                                                                                 |

## 机制已完成清单

这些机制已经实现到足以被视为真实能力，但在文档、证据或工作流缺口关闭前，本页不把它们描述成打磨完成的产品界面。

| 能力                         | 状态               | 边界和证据                                                                                                                                                                                              |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtask expansion preset     | Mechanism-complete | `ha preset action subtask-expansion plan --task <id> --allow-scripts` 会产出 `subtask-plan/v1` 工件和命令字符串。它是规划器，不是自动展开器；用户必须自己执行生成的 task-create 命令。证据：canon 1.4。 |
| 决策文档 CAS 写入            | Mechanism-complete | 决策文档写入使用乐观并发，可能返回 `cas_watermark_mismatch`，CLI 面表现为 `write_rejected`。证据：canon 1.4。                                                                                           |
| Append-delta 幂等性          | Mechanism-complete | 逐字节相同的重复 fact 记录现在是幂等 no-op，而不是 rejection。证据：canon 1.4。                                                                                                                         |
| Claim-check blob store       | Mechanism-complete | session body 可以作为内容寻址 blob 存在 `harness/objects/sha256/...` 下；v0 没有 GC，也没有分块。证据：canon 1.4。                                                                                      |
| Code-doc reconciliation gate | Mechanism-complete | 解析出的 preset/profile 声明 `code-doc-reconciliation` 时（内置 coding profile 都声明），`ha task complete` 会硬失败，除非存在手写的 `harness/tasks/<id>/code-doc-anchors.json`；task create 不会生成它。该门由契约派生，并非全局门（ADR-0027 D7）。证据：canon 1.4。 |
| Distill 循环                 | Mechanism-complete | `ha task complete` 会排入 distill 候选，`ha distill candidate` 与 `ha distill promote` 已存在。公开发布文档仍需要补真实 distill 工作流。证据：canon 1.4。                                               |
| Create-milestone preset      | Mechanism-complete | `ha preset action create-milestone <scaffold                                                                                                                                                            | render-html | check> --task <id> --allow-scripts --input ...`已存在。没有顶层`ha create-milestone` 命令。证据：canon 1.4。 |
| Task archive                 | Shipped            | `ha task archive <id> --reason <r>` 支持单个与批量形式，包括 `--ids`、`--filter state:<s>`、`--before`。证据：canon 1.4。                                                                               |
| Graph panorama flags         | Shipped            | `ha graph` 支持 `--out`、`--focus`、`--projection`、`--include-archived`、`--json`；调用者需要满足投影 DB 前置条件。证据：canon 1.4。                                                                   |

## M2.5 GUI/daemon foundation

GUI/daemon 方向有真实的 foundation 切片：

- 本地 daemon 通过 method registry 读写；
- 本地 daemon 仓库注册与多仓路由；
- GUI 源码 checkout 中，受支持的读取路径会读取真实 ledger 数据；
- 面向 graph 的视图使用真实关系投影；
- 源码 checkout 与 package smoke 有构建、运行时、分发策略检查。

同一方向也有明确的非能力：

- 没有签名 installer、notarization、已发布产物或 auto-update；
- 没有 GUI task 管理写路径；
- 没有 GUI 决策裁决；
- 没有 GUI 连接另一台机器上的 daemon；
- 没有可工作的 remote tunnel、attach-token transport、TCP listener、HTTP API、WebSocket server、实时通知订阅，也没有在缺少 `harness/people.yaml` roster 时强制 RBAC。

这些边界就是 GUI 仍是 foundation 状态，而不是完整桌面产品的原因。

## 未发布边界摘要

| 界面                                      | 尚未发布                                                                                           | 不能意外继承为状态事实                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 已 ship 与 mechanism-complete 的 CLI 界面 | 工作流证明与完整公开文档。                                                                         | 把已 ship 的层级能力继续写成 planned 的旧文档，或隐藏写命令归属与 `--actor human:<id>` 要求的文档。       |
| Adapter 集成                              | 真实 GitHub Issues 或 Linear 实现与证明。                                                          | 把占位 package 当成已 ship 集成。                                                                         |
| 完整 GUI 产品                             | 持久化 GUI 写入、决策动作、全局真实 relations、非 mock terminal/adapters/presets，以及受支持分发。 | 把页面级 GUI 假设、重复 CLI/daemon 业务逻辑，或仅 state 的拖拽行为当成生命周期真相。                      |
| 发布硬化                                  | 签名产物、notarization、update feeds、发布产物 SBOM、发布证据。                                    | 未签名生产产物、未经审查的 license/SBOM 缺口，或没有签名、update-feed、rollback、安全测试的 auto-update。 |

## 运行时与发布就绪

状态：仅限源码 checkout 和 package smoke。运行时检查是可执行的；桌面发布产物仍属后续工作。

### 运行时合同

Harness Anything 从源码运行时要求 Node 24 或更新版本。公开 CI matrix 覆盖 Node 24 和 Node 26，以保证源码入口命令、typecheck、测试和文档化运行时保持一致。

最小运行时 smoke 使用源码 CLI 入口：

```bash
node packages/cli/src/index.ts --json doctor
```

公开提交前使用完整本地 readiness gate：

```bash
npm ci
npm run check
```

PR 尺寸的本地反馈使用分层 gate：

```bash
npm run check:pr
```

### Package smoke

package smoke 会验证当前 package artifact 路径，但不声明已经有公开 npm release：

```bash
npm run harness:smoke-cli-package
```

这条 smoke 会构建并打包 CLI workspace，把 tarball 安装到临时 consumer project，并执行 JSON CLI 命令。

### GUI build

GUI renderer build 独立于桌面 packaging 检查：

```bash
npm run -w @harness-anything/gui build
```

这只证明 renderer bundle 可以编译。它不是签名桌面 installer，不是 notarized build，也不是 release artifact。

### GUI 分发与更新边界

Harness Anything GUI 通过源码和 package smoke test 验证。桌面 installer、daemon installer、签名、notarization、update feed 都是后续发布实现任务。Desktop app、local daemon、remote daemon 必须分别建模；当前策略只允许手动更新规划：auto-update 需要后续实现包提供 signing、update feed、rollback 和安全测试。未签名产物只用于开发。

### 运行时发布边界

当前发布边界刻意保守：

- 只有 `@harness-anything/cli` 可以在 version `0.1.0` 做 public npm publish dry-run preflight。
- 所有非 CLI workspace package 仍为 private，版本仍为 `0.0.0`。
- 不声明真实 npm package release。
- signed installers、notarized builds、auto-update、release feeds、published artifacts 都未 ship。
- Desktop 和 daemon 分发策略由本页治理。

后续发布任务必须扩展可执行的 runtime/release readiness 合同，而不是依赖只有 prose 的发布说明。

## 供应链与许可证 gate

状态：仅 release gate。供应链和许可证检查是可执行的，但发布产物尚未发布。

### 默认本地 gate

默认 gate 对本地和 CI 使用都足够确定：

```bash
npm run harness:check-supply-chain
```

它会运行两条 high-severity npm audit 路径：

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

它也会校验 CycloneDX SBOM 输出：

```bash
npm sbom --sbom-format=cyclonedx --sbom-type=application
```

SBOM 检查要求 dependency component 带 package URL、hash 和 license metadata。

### npm publish dry-run

当前阶段唯一允许的 npm publish preflight 命令是：

```bash
npm publish --dry-run --workspace @harness-anything/cli --access public
```

这条命令只能 dry-run。它可以构建并检查 CLI package artifact，但在这个任务阶段不能替换成真实 `npm publish`。

### OSV readiness

OSV readiness 属于发布证据路径，但 live OSV scan 依赖外部服务，所以不是默认本地 gate 的一部分。后续发布包必须运行并附上这条命令的证据：

```bash
npx --yes osv-scanner@latest --lockfile=package-lock.json
```

预期发布证据路径是：

```text
release-evidence/osv/scan-result.json
```

默认 gate 仍会检查 `package-lock.json` 存在，并检查这条 live scan 命令和证据路径仍在文档中。

### 许可证策略

Harness Anything 继续使用 AGPL-3.0-or-later。供应链 gate 会按当前发布策略检查根 package、每个 workspace package、lockfile dependency license metadata，以及 SBOM component license。

当前阶段允许的 dependency license identifier 刻意收窄为：`0BSD`、`Apache-2.0`、`BlueOak-1.0.0`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`、`MIT`、`MPL-2.0`。

### AGPL 网络服务发布说明 checklist

后续 hosted 或 network-service release packet 必须明确确认：

- [ ] public source offer and license notice
- [ ] modified source corresponding to the network service
- [ ] deployment and service docs preserve AGPL notices
- [ ] release notes identify user-visible network-service changes
- [ ] third-party license notices included with release evidence

### 发布产物 SBOM 边界

未来 desktop、daemon、installer 或 published package artifact 可以分发之前，必须有 release artifact SBOM。当前阶段不会发布这些产物，所以本页定义 gate，而不是提供 artifact SBOM。

### Dependabot 与 Electron upgrade

Dependabot 必须覆盖根 npm workspace 和 GUI workspace。Electron upgrade 需要安全 review，因为它可能改变 sandbox、renderer、permission、navigation、IPC 假设。

Electron upgrade 合入前必须经过安全 review。
