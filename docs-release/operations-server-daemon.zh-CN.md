# 服务器 Daemon 运维

Harness Anything 可以在本机运行一个 daemon，为同一台机器上的一份或多份
canonical 仓库协调读写。CLI 不会自动切到 daemon：默认仍是进程内 direct 模式。需要
让命令走本地 daemon 时，显式设置 `HARNESS_DAEMON_MODE=local`。

不要把 daemon 部署成一个长期运行的 SSH 团队服务器。真实可用的 remote 路径是实验性
单命令 SSH shim：每次客户端命令都会启动一次 `ha daemon serve --stdio`，命令结束后
退出。它不是可承载并发 SSH 客户端的持久 daemon。

## 支持的拓扑

- 本地 daemon，单仓：在 canonical 仓库旁启动 daemon，再用
  `HARNESS_DAEMON_MODE=local` 让 CLI 命令显式走 daemon。
- 本地 daemon，单机多仓：把每个仓库注册进用户 daemon registry，启动一个 daemon，
  再用 `--repo <id>` 路由命令。
- Remote SSH shim：用 `HARNESS_DAEMON_MODE=remote` 执行单次 CLI 命令。客户端会
  spawn `ssh <host> ha daemon serve --stdio ...`，该命令完成后退出。

不支持的部署：

- 让多个 SSH 客户端连接同一个持久 daemon。每个 SSH 客户端都会启动自己的
  `daemon serve` 进程，因此会和持久服务在 `global.lock` 上冲突。
- 把 daemon 绑定到 TCP、HTTP 或 WebSocket。当前实现的传输只有本地 Unix socket 和
  Windows named pipe。
- 让 A 机 GUI 连接 B 机 daemon。GUI 连接的是本地 daemon endpoint。
- 实时通知订阅。订阅方法当前只是 no-op stub。

## 前置条件

- Node.js 满足当前 package engine 策略。
- 运行 daemon 命令的机器上有 `ha`。
- 该机器上安装 Git。
- 一份或多份已初始化的 canonical 仓库路径，且 daemon 用户可写。
- 只有在使用 bootstrap 检查、只读镜像或实验性 remote shim 时才需要 SSH 访问。

## 引导

首次部署时运行一次；之后重复执行也应保持幂等：

```bash
ha daemon bootstrap-server \
  --canonical-root /srv/harness/team \
  --ssh-host team-host \
  --ssh-user alice \
  --person-id person_alice \
  --display-name "Alice Admin" \
  --email alice@example.com \
  --readonly-mirror /srv/harness/team-readonly.git
```

该命令会初始化 canonical 仓库，确保 `harness/people.yaml`，安装 canonical
pre-receive hook，可选创建只读镜像，启动本地 daemon service，验证 SSH 可达，并写出
`daemon-bootstrap-report/v1` JSON 报告。

离线准备时使用 `--skip-ssh-check`；准备交给服务管理器启动时使用 `--no-start`。

## 本地 Daemon

以 detached service 启动 daemon：

```bash
ha daemon start --service
```

需要交给 service manager 托管进程时，使用前台模式：

```bash
ha daemon start --foreground
```

CLI 命令默认仍走 direct 模式，必须显式 opt in：

```bash
HARNESS_DAEMON_MODE=local ha task list
```

## 多仓 Registry

把同一个 daemon 要服务的每个本地 canonical 仓库都注册进去：

```bash
ha daemon repo register --repo-id A --root /srv/harness/a
ha daemon repo register --repo-id B --root /srv/harness/b
ha daemon start --service
```

用 `--repo` 把 CLI 命令路由到已注册仓库：

```bash
HARNESS_DAEMON_MODE=local ha --repo A task list
```

运行中的 daemon 每秒 reconcile 一次 registry。新注册的仓库可以热挂，不需要重启
daemon。

## Remote SSH Shim

Remote 模式是单会话 shim，不是持久远程 daemon 的客户端：

```bash
HARNESS_DAEMON_MODE=remote \
HARNESS_DAEMON_SSH_HOST=team-host \
HARNESS_DAEMON_REMOTE_ROOT=/srv/harness/team \
HARNESS_DAEMON_REMOTE_HA=ha \
ha task list
```

`HARNESS_DAEMON_MODE`、`HARNESS_DAEMON_SSH_HOST` 和
`HARNESS_DAEMON_REMOTE_ROOT` 是必需项。`HARNESS_DAEMON_REMOTE_HA` 默认是
`ha`；远端二进制路径不是 `ha` 时再设置。远端需要服务非 `canonical` 的已注册仓库
id 时，设置 `HARNESS_DAEMON_REPO_ID`。

不要把这条路径指向已经被持久 daemon 持有的仓库。SSH shim 会再启动一个
`daemon serve` 进程，而这个进程也必须获取同一个 `global.lock`。

## 安全模型

本地 Unix socket 才是真实访问边界。daemon 会用 `0700` 创建 socket 目录，并把
socket 文件设为 `0600`。

Unix transport 没有做 `SO_PEERCRED` 这类内核 peer credential 校验。记录的 peer
credential 来自 daemon 进程所有者（`process.getuid()` / `process.getgid()`），不是
连接进来的客户端。

存在 `harness/people.yaml` 时会启用基于 roster 的授权。没有这份 roster 时，本地连接
完全信任 transport 边界。

## 服务模板

从 CLI 包复制三平台模板：

```bash
ha daemon install-templates --out ./daemon-service-templates
```

模板不绑定发行版包管理器：

- `harness-anything-daemon.service`：systemd。
- `com.harness-anything.daemon.plist`：launchd。
- `install-harness-anything-daemon.ps1`：Windows Service 注册脚本。

安装前替换 `{{HA_BIN}}`、`{{CANONICAL_ROOT}}`、`{{USER}}` 和日志路径占位符。

## 拒绝直推 Hook

canonical 仓库 hook 会拒绝非 daemon push，并提示用户走 daemon-backed `ha` 路径。
它是服务器侧防误操作护栏，不做内容审查。除非未来 daemon 管理的 push 路径提供
服务器本地 token，否则默认 fail-closed。

## 只读镜像

镜像只承担批量上下文读取：

```bash
git fetch ssh://team-host/srv/harness/team-readonly.git
```

镜像同步是普通 Git fetch，从 canonical 仓库拉取，不需要 daemon 新增推送逻辑。
镜像自身也安装 pre-receive hook，拒绝写入并提示回到 canonical daemon 路径。

## Status 与 Stop

```bash
ha --root /srv/harness/team daemon status --json
ha --root /srv/harness/team daemon stop --timeout-ms 5000 --json
```

status 报告锁持有者、队列深度、当前/累计连接数、daemon 版本、协议版本和已 attach 的
仓库状态。stop 发送 `SIGTERM`，并等待 daemon runtime 排空队列、释放全局锁。
