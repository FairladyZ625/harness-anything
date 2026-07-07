# 39B · Terminal / WS Service Contract

- **状态**: canonical split contract
- **日期**: 2026-07-07
- **拆分来源**: 39 · Daemon API 与 Service Contract 生成合同（原 §5）
- **适用范围**: terminal session API、terminal backend、session registry、env profile、scrollback、terminal WS frame、display-only 边界
- **关联**: 39A(daemon transport/API 与 Service contract)、ADR-0004、ADR-0005、40-gui-and-apps/39(workspace terminal architecture)

> 本文件是 terminal / WS 特例的唯一文档事实源。daemon API handler、Service mappability、remote token/tunnel 与 gate 分阶段要求见 `39A-daemon-transport-api-service-contract.md`。

## 0. Terminal / WS 特例

Terminal session API 是 daemon service，不是 kernel business Service。它仍必须有 contract registry：

- `POST /api/terminal/sessions`
- `GET /api/terminal/sessions`
- `GET /api/terminal/sessions/:id`
- `WS /api/terminal/sessions/:id/attach`
- `POST /api/terminal/sessions/:id/resize`
- `DELETE /api/terminal/sessions/:id`

## 1. Terminal Backend

Terminal backend 是 daemon 内部 session 宿主策略，不改变 GUI attach 协议。

| Backend | 用途 | V1 口径 | 持久性 | 约束 |
| --- | --- | --- | --- | --- |
| `direct-pty` | 本机 shell、agent CLI、系统 `ssh` shell | 开发/降级 backend | daemon 退出后 session 结束 | 最小真 PTY 路径；必须覆盖 resize、exit、backpressure、display-only |
| `tmux` | daemon 重启后继续 attach，用户熟悉的长期 shell | M2.5 durable baseline | tmux server 存活则 session 可恢复 | 需要 session 命名、cleanup、scrollback 事实源、可用性检测和跨平台降级策略 |
| `remote` | 远端 headless daemon 托管 session，本地 GUI 只 attach stream | 远程模式 | 由远端 daemon/backend 决定 | 本地 GUI 通过系统 SSH tunnel 访问远端 daemon API/WS contract |

`direct-pty` 仍是最小真 PTY spike 和跨平台降级路径，但不能作为 durable terminal 的产品承诺。M2.5 必须把 `tmux` 或等价 detach/resume backend 纳入 baseline；如果某平台无法使用 tmux，必须在 GUI 中明确降级并禁止承诺 daemon 重启后 session 存活。`remote` 是连接形态，不是本地 daemon 里再 spawn 远端 shell 的特殊捷径。

Backend 切换不迁移已经存在的 session。已有 session 继续归属创建时的 backend；新 session 使用当前默认 backend。用户可以 reopen exited session，但 reopen 创建新 session，并继承 metadata，不复用已退出进程。

## 2. Session Registry Schema

daemon 必须维护 session registry。它是运行时控制面 metadata，不是 kernel task 状态。

本节是 `TerminalSessionInfo` 的唯一文档事实源。ADR、workspace 架构说明和原型任务不得复制此 interface；只能指向本节。

```ts
interface TerminalSessionInfo {
  readonly sessionId: string
  readonly name: string
  readonly backend: "direct-pty" | "tmux" | "remote"
  readonly status: "active" | "idle" | "exited"
  readonly hostProfileId?: string
  readonly hostLabel: string
  readonly projectId?: string
  readonly taskId?: string
  readonly cwd?: string
  readonly shell?: string
  readonly createdAt: string
  readonly lastActivityAt?: string
  readonly exitCode?: number
}
```

Registry 最少支持：

- list active / idle / exited sessions；
- attach existing session；
- close active session；
- reopen exited session as a new session with inherited metadata；
- surface host/project/task context/cwd/status/lastActivity/exitCode to GUI session list。

关闭 pane、切换 perspective、关闭 task context workspace 或 GUI reload 只能 detach 视图，不得隐式 kill session。

## 3. Env Profile

`envProfileId` 引用 daemon 管理的环境配置。它是 terminal 启动上下文，不是 secret store。

```ts
interface EnvProfile {
  readonly envProfileId: string
  readonly name: string
  readonly projectId?: string
  readonly hostProfileId?: string
  readonly cwd?: string
  readonly shell?: string
  readonly env: Record<string, string>
  readonly inheritSystemEnv: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
```

约束：

- `env` 不得保存 private key、token、passphrase 等 secret 值；secret 只能通过 OS keychain、ssh-agent 或企业 secret store 引用。
- host-specific env profile 必须绑定 `hostProfileId`；project-specific env profile 必须绑定 `projectId`。
- 启动 terminal 时，daemon 负责把 `envProfileId` 解引用为 PTY spawn options。

## 4. Scrollback Contract

scrollback 是 daemon runtime buffer，不是 project truth，不进入 projection，不同步。

```ts
interface ScrollbackConfig {
  readonly maxBytes: number
  readonly replayMaxBytes: number
  readonly eviction: "drop-oldest"
}
```

默认值：

- `maxBytes`: `1_048_576`(1 MiB) per session；
- `replayMaxBytes`: `262_144`(256 KiB) per attach；
- `eviction`: `drop-oldest`。

当 scrollback 被截断时，daemon 必须发送 `error` 或 metadata frame 通知 GUI，GUI 需要显示“早期输出已截断”。tmux backend 的 scrollback 事实源可以是 tmux history，但 attach replay 仍受 `replayMaxBytes` 限制。

## 5. WS Frame Schema

WS frame 至少分为：

- `stdin`
- `stdout`
- `resize`
- `exit`
- `error`
- `heartbeat`

最小 frame 形态：

```ts
type TerminalClientFrame =
  | { readonly type: "stdin"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "heartbeat"; readonly at: string }

type TerminalServerFrame =
  | { readonly type: "stdout"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number | null }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "heartbeat"; readonly at: string }
```

Terminal output 不进入 task state，不写 projection，不触发 progress append。
