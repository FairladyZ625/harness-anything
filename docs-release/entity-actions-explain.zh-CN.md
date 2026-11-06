# Entity Action explanation：授权预检合同

`repo.entity.actions.explain` 是 Entity Action 唯一的公开授权预检面。客户端用它询问「当前已认证的人此刻能对这些 Entity 对象做什么」。它给的是预检结论，不是写入、锁、批准或可反复使用的许可；真实写入仍由 writer 在当前 canonical cut 上重新授权。

本页说明调用形状、身份前提、`allowed` / `denied` / `unavailable` 三种结果与稳定 reasonCode、新鲜度以及能力发现。schema 保持 `entity-action-explain-request/v1` 与 `entity-action-explanation/v1`。

## 调用方式

传输方法：`repo.entity.actions.explain`。协议描述符里另有 `POST /api/entities/actions/explain`；那只是路由声明，不代表已经部署独立公网 HTTP listener。第三方 BFF 走 daemon 传输，或走持有用户 token 的已认证 ingress。

object 模式对目标 Entity 的完整动作目录逐个求值：

```json
{
  "repo": { "repoId": "registered-repository-id" },
  "payload": {
    "schema": "entity-action-explain-request/v1",
    "mode": "object",
    "entityKind": null,
    "refs": ["task/task-id"]
  }
}
```

- `mode` 取 `object` 或 `catalog`。
- object 模式下 `entityKind` 必须为 `null`，kind 从每个 ref 推导。
- `refs` 为 1–500 个 EntityRef；允许重复，同一请求内会复用结果，响应保持输入顺序。
- catalog 模式下 `entityKind` 指定一个已注册 kind，`refs` 为空或只含同一个 kind。

catalog 模式只发现动作，不求值：

```json
{
  "repo": { "repoId": "registered-repository-id" },
  "payload": {
    "schema": "entity-action-explain-request/v1",
    "mode": "catalog",
    "entityKind": "task",
    "refs": []
  }
}
```

除上述字段（以及保留的 `executor`）外的 payload 字段会在 wire 形状处被拒绝，包括 `actor`、`personId`、`role` 和 `cut`：调用方不能自选主体或求值 cut。`executor` 留给执行绑定的 agent，见下。

## 身份前提

请求按 daemon 已认证传输建立的主体求值，绝不按 payload 里的值求值；`authorizationDecision.actor` 就是该主体。

- **必须有 binding。** 没有 binding 的请求返回 `authentication_required`，不会当成匿名或空结果。
- **Keycloak 凭据必须与 actor 一致。** daemon 通过既有 `AuthorizationProvider` 求该 person 自己的 grant；没有在线凭据时动作按 `keycloak_evaluation_missing` 拒绝，不默认放行。
- **`executor` 不改变人。** 执行绑定的 agent 只有在声明已认证 `RuntimeSession` 或匹配当前 task lease 时才能声明 executor；其他声明返回 `executor_binding_invalid`。Web 客户端不应发送 `executor`。
- **service account、node 凭据、execution credential 都不是 Web 用户。** 它们不会让请求带上某个人的 grant，也不能代替逐用户转发自己的 access token。

## 响应

响应是 `entity-action-explanation/v1` 集合。`mode` 为 `object`、`failure` 或 `catalog`。object/failure 的 `evaluatedAtCut` 为 `canonical:<sourceRevision>`，catalog 为 `null`。

每个 object 动作行包含：

| 字段                         | 含义                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                     | 规范声明：`kind`、`id`、`catalogRef`、`contractVersion`、`explain` 与 `syntax`（`usage` 和输入字段）。                                                               |
| `target`                     | 被求值的 EntityRef 与其 revision。                                                                                                                                   |
| `available`                  | 仅当授权结论为 `allowed` **且**所有声明的对象/主体/cut criterion 都满足时为 `true`。                                                                                 |
| `criteria` / `unmetCriteria` | 按声明顺序给出每个 criterion 的状态（`met`、`unmet`、`invocation-required`、`not-evaluated`）、failureCode 和 nextActions；`unmetCriteria` 是 `unmet` 行的精确投影。 |
| `authorizationDecision`      | `policyRef`、`actor`、`subject`、`bindingsUsed`、`outcome`（`allowed` 或 `denied`）、稳定 `reasonCodes`、`nextActions` 与 `evaluatedAtCut`。                         |
| `evaluatedAtCut`             | 本行使用的唯一 canonical cut，与集合一致。                                                                                                                           |

`available` 不表示具体调用一定成功：它只覆盖本次授权求值加上目录声明的对象/主体/cut 条件，不证明用户看过确认界面、参数合法，也不证明稍后的写入仍会被允许。

### 三种答复与稳定码

| 答复   | 形状                                                                                                     | 客户端行为                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 允许   | `authorizationDecision.outcome === "allowed"` 且 criteria 全满足                                         | 对该对象启用动作；写入仍可能被 writer 自己的条件拒绝。                                     |
| 拒绝   | `authorizationDecision.outcome === "denied"` 或有 `unmet` criterion，`reasonCodes` 与 `nextActions` 非空 | 保持禁用，展示原因与下一步；不要盲目重试。                                                 |
| 不可用 | 读取失败，错误码 `keycloak_unavailable`                                                                  | 视为授权中心暂时不可用：不允许任何动作，给出重试入口，使用有界退避加抖动；绝不回退为启用。 |

Web 调用方在 `authorizationDecision.reasonCodes` 可能看到的稳定码：

| 码                            | 来源                                               |
| ----------------------------- | -------------------------------------------------- |
| `keycloak_allowed`            | person 的 grant 允许该动作作用于该资源。           |
| `keycloak_denied`             | 授权中心已答复，person 没有覆盖该动作的 grant。    |
| `unknown_scope`               | 授权中心不认识该 scope；按拒绝处理并暴露合同缺口。 |
| `authentication_required`     | 凭据不能证明该决策对应的 actor。                   |
| `keycloak_evaluation_missing` | daemon 没有该行的在线决策，按拒绝处理。            |
| `entity_kind_not_found`       | artifact 动作指向了运行期无法解析的 kind。         |

`policyRef`（例如 `keycloak-policy@1`）标识授权方的决策语义，不是 policy epoch，不能拿它比较新旧。传输故障不产生决策行，而是以 `keycloak_unavailable` 失败，且不会同时产生 `allowed` 行。授权方返回畸形响应属于缺陷，不会重新归类为不可用。

### 类型化失败

无法求值的目标返回类型化 failure subject，而不是编造决策：

| failureCode                  | 含义                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `invalid_entity_ref`         | ref 不是已注册的 EntityRef。                                            |
| `entity_not_found`           | 该 cut 上 Task、Person 或 Squad 不存在。                                |
| `unsupported_explain_target` | ref 可解析，但本面不求值该 kind（例如 `fact/...` 或外部 harness ref）。 |
| `projection_pending`         | 投影尚未到达 canonical cut；等它追上后重试。                            |

## 新鲜度

每个 object 请求都重新调用在线授权，不存在按 person、对象或 cut 复用的跨请求 allow 缓存。

- 一次请求只用一个 canonical cut：所有行与集合的 `evaluatedAtCut` 相同，决策的 `evaluatedAtCut` 等于其行。
- 若在解析授权决策与读取投影之间 cut 发生移动，读取以 `projection_pending` 失败，而不是混合两个 cut。
- 撤掉 grant 后，即使 ledger cut 未动，下一次 explanation 也会改变；旧响应不会因此变成写入许可。
- session 撤销属于 Keycloak session 语义。本版按请求重新求 grant，但中心 adapter 可能复用 user token 的有效性结果到该 token 过期；因此不要把预检当成 session 仍然有效的证明，敏感写入仍走 writer 自己的检查。
- 所有真实写入都在 writer 内、按当前 cut 重新授权。预检响应永远不会被当作写入 proof、幂等键或委托。

## 能力发现

渲染按钮前先用 `mode: "catalog"` 了解部署支持什么：

- `task`、`person`、`squad` 以及每个声明了动作目录的运行期 artifact kind 的完整动作清单；
- 每个动作的 `id`、合同版本、usage、输入字段和 criteria；
- `available: null`、`authorizationDecision: null`、`evaluatedAtCut: null` 和 `not-evaluated` criteria，因为 catalog 模式从不求值授权。

不能只凭 catalog 就启用动作。catalog 也无法为尚不存在的目标授权（例如 `task-create` 的 repository 目标）；没有对象目标的 create/intent 动作在 object explain 能点名目标前只是发现项。

object explain 当前覆盖 `task`、`person` 和 `squad`。artifact kind 可在 catalog 中发现，但 artifact object ref 返回 `unsupported_explain_target`；不要把该 failure 当作动作被拒绝。未知 catalog kind 使请求以 `invalid_command` 失败。

## 兼容性与权威

上面的 request/response schema id 是当前版本。后续变更遵守「当前版本 + 上一版本」兼容窗口：新 schema id 增量化引入，上一版本在窗口内继续工作，窗口结束删除旧 adapter。本页只描述当前 v1 形状，是面向客户端的索引，不是第二份 schema。

规范声明位于
[`entity-action-explanation.ts`](../packages/kernel/src/domain/entity-action-explanation.ts)、
[`task-action-explanation-read.ts`](../packages/daemon/src/task-action-explanation-read.ts)
和协议描述符
[`daemon-protocol-gui-reads.ts`](../packages/daemon/src/protocol/daemon-protocol-gui-reads.ts)。
合同测试为
[`entity-action-explain-contract.integration.test.ts`](../packages/daemon/test/entity-action-explain-contract.integration.test.ts)。
