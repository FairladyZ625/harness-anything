# 39A · Daemon Transport/API 与 Service Contract 生成合同

- **状态**: canonical split contract
- **日期**: 2026-07-07
- **拆分来源**: 39 · Daemon API 与 Service Contract 生成合同（原 §0-§4、§6-§9）
- **适用范围**: `packages/application` Service、`packages/daemon` JSON-RPC/REST/WS handler、GUI local API / remote daemon API、transport/auth/handler gate
- **关联**: 17(Effect TS 实现合同)、18(schema 合同)、31(GUI spec)、31A(Electron security)、35(GUI V2 vision)、39B(terminal/WS 特例)、ADR-0013、ADR-0005

> Terminal session、PTY backend、scrollback 与 terminal WS frame 的权威合同已拆到 `39B-terminal-ws-service-contract.md`。本文件只定义 daemon transport/API、Service mappability、handler registry/gate 与 GUI 连接模型。

## 0. 结论

M1/M2 不因为 GUI daemon 架构而扩大实现范围，但 M1/M2 新增或修改的 application Service 必须保持 **可映射到 API handler**。

正式 daemon / REST / WebSocket 实现前，必须先落地 API contract gate：要么生成 handler，要么用 lint/check 证明 handler 与 Service contract 没有漂移。

2026-06-13 用户裁决：

- GUI / daemon 采用 **统一协议、多 transport**。REST/WS 语义和 handler contract 只有一套；local 可以走 Unix domain socket / platform IPC / loopback TCP，remote 走系统 `ssh` tunnel。不得为了 local/remote 产生两套 API 语义。
- M1/M2 完成后、PLT-TaskTree 前新增 **M2.5 GUI/daemon productization & hardening** 里程碑，用于把 transport、tmux durable backend、distribution/update、service mappability gate 和文档治理补齐。
- Service 不可映射时默认重构 Service；不接受 CLI/GUI 调不同 Service surface。daemon adapter shim 不是默认兜底，必须另立 ADR 才能作为例外。

## 1. 边界

| 组件 | 允许 | 禁止 |
| --- | --- | --- |
| CLI | 直接调用 `kernel/application` Service | 依赖 daemon、本机 REST API 或 GUI package |
| GUI | 通过 daemon API contract 调用 Service；terminal 通过统一 WS frame attach；transport 可为 local socket/IPC/loopback 或 SSH tunnel | 直接写 store、直接调 external adapter、复制业务状态机；为 local/remote 写两套 API 语义 |
| Daemon | service host、terminal host、projection cache host、remote daemon API server | 成为第二套 kernel；在 handler 里实现业务规则 |
| REST/WS handler | auth、path 参数解析、schema validation、transport error mapping、调用 Service | 状态推导、写协调、domain transition、直接读写 task 包 |
| Service | 业务用例边界；可被 CLI 和 handler 共同调用 | 使用不可映射的长期 `payload: unknown` surface |

## 2. Service 方法形态

面向 GUI/daemon 暴露的 Service 方法必须有明确 input/output contract。允许两种表达：

1. TypeScript 类型 + 对应 Effect Schema；
2. 直接以 Effect Schema 为源，生成 TypeScript 类型。

示例：

```ts
import { Schema } from "effect"

export const GetTaskDetailInput = Schema.Struct({
  taskId: Schema.String
})

export const GetTaskDetailOutput = Schema.Struct({
  taskId: Schema.String,
  title: Schema.String,
  coordinationStatus: Schema.String
})

export interface TaskQueryService {
  readonly getTaskDetail: (
    input: typeof GetTaskDetailInput.Type
  ) => Effect.Effect<typeof GetTaskDetailOutput.Type, TaskQueryError>
}
```

`payload: unknown` 只能出现在 transport 边缘的 decode 函数内部，不能作为长期 Service public surface。

当前已有 `LocalControllerService` 的 `payload: unknown` 属历史过渡形态；任何 GUI/daemon 后续任务若继续依赖它，必须先创建迁移 task，把其拆成 typed query/command Service。

## 3. API Contract Registry

daemon 引入前必须定义一个 API contract registry。最小字段：

```ts
interface ApiRouteContract {
  readonly id: string
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "WS"
  readonly path: string
  readonly inputSchemaId: string
  readonly outputSchemaId?: string
  readonly errorSchemaId: string
  readonly service: string
  readonly serviceMethod: string
  readonly auth: "local-session-token" | "ssh-tunnel-local-token" | "none"
}
```

Registry 是 handler 生成或 handler lint 的事实源。REST 和 WebSocket 都必须登记；terminal attach 这类 stream API 可以把 control message schema 与 stream frame schema 分开登记。

## 4. Handler 生成 / 校验策略

优先级：

1. **生成 handler**：由 registry + Schema 生成 route boilerplate，只手写 Service 实现；
2. **薄 handler lint**：允许手写 handler，但 gate 检查它只 decode + authorize + call Service + encode error；
3. **临时手写**：只允许在 prototype/spike，不能进入 production package。

无论采用哪种，gate 至少证明：

- handler 文件不得 import `packages/kernel/src/store/**` 或 external adapter implementation；
- handler 文件不得出现 task 状态机分支、frontmatter 写入、SQLite 写入、`WriteCoordinator.enqueue` 直接调用；
- handler 调用的 Service 方法存在于 contract registry；
- Service input/output schema 有 valid/invalid fixture；
- CLI 和 daemon handler 调用同一个 application Service，而不是两套实现。

> 原 §5 Terminal / WS 特例已迁移到 `39B-terminal-ws-service-contract.md`。

## 6. GUI 连接模型

GUI 只有一个协议抽象：连接到某个 daemon API endpoint。协议语义、route、WS frame、schema、auth 只有一套；transport 可以不同。

```ts
type DaemonTransport =
  | { readonly kind: "local-ipc"; readonly endpoint: string }
  | { readonly kind: "local-loopback"; readonly host: "127.0.0.1"; readonly port: number }
  | { readonly kind: "ssh-tunnel"; readonly tunnelId: string; readonly localHost: "127.0.0.1"; readonly localPort: number }
```

| 模式 | daemon 位置 | GUI 如何连接 | 适用场景 |
| --- | --- | --- | --- |
| Local daemon IPC/socket | 本机 | local session token + Unix domain socket / platform IPC | 产品默认 local-only；避免端口冲突；权限由文件/平台 ACL 辅助 |
| Local daemon loopback | 本机 `127.0.0.1` | local session token + REST/WS | 开发、跨平台降级、IPC 不可用时；不是优先路径 |
| Remote daemon over SSH tunnel | 远程机器 | GUI 调系统 `ssh` 建本地端口 tunnel，再以 local endpoint 方式连接 | VS Code Remote-SSH 式远程项目/远程 terminal |
| Self-host control plane | 用户/企业后台 | 账号/设备/项目 registry；live terminal 仍优先走 SSH tunnel 或已授权 device path | V2/企业管理面 |

连接规则：

- GUI 不直接连远程 daemon 的公网端口；
- local 与 remote 不得拥有两套 handler 或两套 Service surface；
- SSH tunnel 使用系统 `ssh`、用户 `~/.ssh/config`、ssh-agent、ProxyJump 和 known_hosts；
- remote machine 只需要 headless daemon，不需要 GUI；
- relay / reverse tunnel 不是默认 V1/V2 路线，只有 browser/mobile cross-NAT live terminal 被证明需要时才立项；
- local GUI 与 remote daemon 之间的 API 合同必须与 local daemon 一致，不能出现第二套 remote-only handler。

### 6.1 Remote Daemon Token Bootstrap

remote daemon 认证不能依赖公网暴露端口。默认流程：

1. GUI 使用系统 `ssh` 连接 host profile。
2. GUI 通过 ssh exec 在远端启动或定位 headless daemon，并请求一次性 attach token。
3. 远端 daemon 生成短期 token，绑定 daemon instance、user、host profile、tunnel nonce 和过期时间。
4. GUI 建立 `ssh -L` tunnel 后，通过本地 tunnel endpoint 使用该 token 访问 daemon API/WS contract。
5. token 过期、tunnel 断开或 host profile 被 revoke 时，daemon 必须拒绝新请求并关闭相关 attach。

token 不写入 project repo，不同步，不进入 terminal scrollback。token refresh 必须走同一 SSH-authenticated control path。

### 6.2 Tunnel Connection Model

```ts
interface TunnelConnectionInfo {
  readonly tunnelId: string
  readonly hostProfileId: string
  readonly status: "initiating" | "authenticating" | "established" | "degraded" | "reconnecting" | "failed" | "closed"
  readonly localHost: "127.0.0.1"
  readonly localPort: number
  readonly remoteDaemonId?: string
  readonly startedAt: string
  readonly lastHeartbeatAt?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}
```

GUI 必须能区分：

- tunnel 断开；
- remote daemon 不可达；
- terminal session 已退出；
- host profile 被 revoke。

tunnel 断开时，受影响的 remote terminal session 在 GUI 中显示为 detached/degraded，不得误标为 exited。重连成功后可重新 attach；重连失败时必须给用户关闭或重试动作。

### 6.3 Trust Policy

OpenTarget、file link、embedded browser 和 terminal output link 使用同一 trust policy。

```ts
interface TrustPolicy {
  readonly projectId: string
  readonly allowedRoots: readonly string[]
  readonly allowedLocalhostPorts?: readonly number[]
  readonly allowedUrlOrigins: readonly string[]
  readonly openExternalByDefault: boolean
}
```

默认：

- file target 必须落在 `allowedRoots` 内；
- embedded browser 默认只允许 `localhost` / `127.0.0.1` 和 `allowedUrlOrigins`；
- 外部 URL 默认交给系统浏览器；
- terminal output 链接永远是用户显式点击触发，不能自动打开。

### 6.4 Daemon Instance Boundary

M2.5 默认目标是 single-daemon-per-user-per-host。多 daemon 实例必须通过不同 IPC endpoint 或端口隔离；不得共享 session token、session registry 或 runtime cache。若进入 multi-instance 支持，必须先补实例发现和端口/socket 分配合同。

## 7. CI / Check 分阶段

### 当前阶段(M1/M2)

公开 `npm run check` 在 M1/M2 不强制 production daemon handler gate，因为 daemon/API handler 尚未进入 production surface。

但 M1/M2 任务若新增或改动 `packages/application` Service，必须在 task_plan 中说明：

- 该 Service 是否未来会被 GUI/daemon 调用；
- 若会，input/output 是否 typed/mappable；
- 是否存在 `payload: unknown` 过渡债务；
- 对应 Schema/fixture 是否需要进入 18 schema registry。
- 如果不可映射，默认处理是重构 Service，使 CLI 和 GUI/daemon 仍调用同一 Service surface；不得创建 CLI-only 与 GUI-only 两套业务 API。

### M2.5 GUI/daemon productization & hardening

M2 完成后、PLT-TaskTree 开始前，必须新增 M2.5 里程碑补齐：

- daemon transport 抽象：local IPC/socket、loopback 降级、SSH tunnel；
- tmux durable backend 或等价 detach/resume backend；
- remote daemon token bootstrap 与 tunnel lifecycle；
- service mappability lint；
- schema single-source gate；
- desktop distribution / signing / update strategy。

### Daemon/API 开工前

新增一个 gate，二选一：

- `harness:check-api-contracts`
- 或扩展 `harness:check-implementation-contracts`

gate 进入 `npm run check` 后，daemon/API 任务才可进入 implementation。

### Daemon/API 开工后

`npm run check` 必须阻断：

- handler 未登记 contract；
- contract 指向不存在的 Service；
- Service 输入输出没有 Schema；
- handler import store/adapters；
- handler 内出现业务状态推导或写协调实现；
- `payload: unknown` 出现在新增 public Service surface。
- CLI/GUI/daemon 分裂成不同 Service surface。

## 8. 文档与任务要求

任何包含 daemon/API/GUI Service 调用的 task packet 必须引用本合同，并在 Gates 中写明：

- 本任务只需要阅读哪些 architecture / contract / ADR 文件；
- Service contract registry 是否更新；
- Schema valid/invalid fixtures 是否更新；
- handler 生成或 lint gate 是否更新；
- CLI/GUI/daemon 是否共用同一 Service；
- terminal WS 是否保持 display-only，不进入 task state。

## 9. 非目标

- 本合同不要求 M1/M2 现在实现 daemon；
- 不要求现在引入 OpenAPI；
- 不要求 REST 成为 CLI 的本地调用路径；
- 不要求 browser/mobile live terminal 通过云 relay；
- 不把 terminal session registry 当作业务 kernel 状态。
