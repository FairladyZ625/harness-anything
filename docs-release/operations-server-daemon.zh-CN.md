# 服务器 Daemon 运维

Harness Anything 可以在本机运行一个 daemon，为同一台机器上的一份或多份
canonical 仓库协调读写。CLI 不会自动切到 daemon：默认仍是进程内 direct 模式。需要
让命令走本地 daemon 时，显式设置 `HARNESS_DAEMON_MODE=local`。

remote 路径仍属实验性能力。远端 CLI 命令会通过 SSH stdio relay 连接到已经运行的 daemon，
不会通过 SSH 再启动一个 daemon。团队远程接入必须为每位成员配置一条 SSH
`authorized_keys` forced command，见[使用 SSH forced command 接入团队](#使用-ssh-forced-command-接入团队)。

## 支持的拓扑

- 本地 daemon，单仓：在 canonical 仓库旁启动 daemon，再用
  `HARNESS_DAEMON_MODE=local` 让 CLI 命令显式走 daemon。
- 本地 daemon，单机多仓：把每个仓库注册进用户 daemon registry，启动一个 daemon，
  再用 `--repo <id>` 路由命令。
- Remote SSH relay：用 `HARNESS_DAEMON_MODE=remote` 执行单次 CLI 命令。客户端会运行
  `ssh <host> ha daemon connect --stdio`；sshd 的 forced command 再把 stdio 接到持久
  daemon。

不支持的部署：

- 把 daemon 绑定到 TCP、HTTP 或 WebSocket。当前实现的传输只有本地 Unix socket 和
  Windows named pipe。
- 让 A 机 GUI 连接 B 机 daemon。GUI 连接的是本地 daemon endpoint。
- 实时通知订阅。订阅方法当前只是 no-op stub。

## 前置条件

- Node.js 满足当前 package engine 策略。
- 运行 daemon 命令的机器上有 `ha`。
- 该机器上安装 Git。
- 一份或多份已初始化的 canonical 仓库路径，且 daemon 用户可写。
- 只有在使用 bootstrap 检查、只读镜像或实验性 remote relay 时才需要 SSH 访问。

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

## Remote SSH Relay

Remote 模式是持久远程 daemon 的单命令客户端。它打开一个 SSH stdio 会话，服务器的 forced
command 会把该会话 relay 到 daemon：

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

客户端实际执行的是 `ssh <host> <remote-ha> daemon connect --stdio`。服务器必须已经为
canonical root 启动 `ha daemon start --service`。每个请求都会携带 remote root，并且它必须
匹配成员 forced command 固定的 root。

## 使用 SSH forced command 接入团队

这条实验性路径通过服务器 sshd 认证人，而不是相信 `process.env.USER` 或客户端声明的
principal。请在运行持久 daemon、持有 canonical 仓库的服务器上完成配置。

1. 为 `/srv/harness/team` 注册并启动 daemon；上面的 bootstrap 命令可创建初始 roster 与
   service。确认服务已通过 `ha --root /srv/harness/team daemon start --service` 启动。
2. 在 `harness/people.yaml` 中添加每位成员。条目需要稳定的 `personId`、`displayName`、
   `primaryEmail`、其 command class 足够的 role，以及精确的 transport credential。它的 issuer
   必须匹配 daemon 进程看到的 `host:<os.hostname()>`，不能只写客户端使用的 SSH alias。每次
   改 roster 后都要重启 daemon service；运行中的 repo binding 只会在启动时加载 roster。

   ```yaml
   - personId: person_alice
     displayName: Alice
     primaryEmail: alice@example.com
     roles: [maintainer]
     credentials:
       - kind: ssh-forced-command-person
         issuer: host:team-host
         subject: person_alice
   ```

3. 在 daemon account 的 `authorized_keys` 中为该成员的 public key 加上一行。下面把 Alice
   与 `/srv/harness/team` 一并固定；替换 key material 与 comment，但保持 command 参数结构
   不变。

   ```text
   command="ha --root /srv/harness/team daemon connect --stdio --principal person_alice --expect-original-command 'ha daemon connect --stdio'",restrict ssh-ed25519 AAAA... alice@example.com
   ```

4. 成员客户端使用上面的 remote mode 环境变量。expected original command 必须精确匹配。示例
   假定远端二进制是 `ha`；如果修改了 `HARNESS_DAEMON_REMOTE_HA`，forced command 里的 expected
   string 也必须精确改成实际 SSH 命令。

### 吊销

先删除该成员的 `authorized_keys` 行：这会立即阻止新的 SSH 会话。随后从
`harness/people.yaml` 删除对应 credential 或 person，或把 person 标为 disabled，并重启 daemon，
让 roster 变更生效、现有 relay 会话也断开。若无法确定 key 的保管状态，请审查并轮换它；只改
display name 或 role 不是吊销 key。

### 安全边界

以下检查由机制保证：

- sshd 认证 key 并运行静态 forced command；relay 会拒绝没有 root-owned `sshd` ancestor 的
  进程。
- `SSH_ORIGINAL_COMMAND` 必须与 authorized 期望命令逐字相等。期望命令本身会拒绝
  `--principal`、`--root`、`--expect-original-command`，所以客户端不能把这些特权 option
  偷渡进去。
- forced command 固定 canonical root。请求另一个 root 会被拒绝；daemon 只通过 roster 中精确的
  `ssh-forced-command-person` credential 解析 forced principal。

这些机械保证不能替代管理纪律。管理员仍须在分配 `personId` 前核验 public key 的所有权，保护
daemon account 及其 `authorized_keys` / roster 文件，按最小权限授予 role，并在访问结束时及时
删除 key 与 credential。机制能证明走的是哪条已配置 key 路径；它不能证明管理员是否把正确的人
映射给该 key，也不能证明该人始终独占该 key。

## 安全模型

本地 Unix socket 才是真实访问边界。daemon 会用 `0700` 创建 socket 目录，并把
socket 文件设为 `0600`。

Unix transport 不读取连接进程的身份。它记录
`unix-socket-owner-boundary`，subject 是 socket 文件属主的 `stat.uid`。每个成功连接
的客户端之所以归属该 owner，只因为 `0700` 目录与 `0600` socket 仅允许 owner
连接。放宽任一权限都会使这个边界失效，届时必须改用其他身份来源。

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
