# 服务器 Daemon 运维

Harness Anything 使用本地 daemon，为同一台机器上的一份或多份已初始化 canonical
仓库协调读写。CLI 默认连接并按需自动启动本地 daemon。`HARNESS_DAEMON_MODE=direct`
只保留为显式 bootstrap / 测试边界，不是已初始化 ledger 的日常写路径。

remote 路径仍属实验性能力。远端 CLI 命令会通过 SSH stdio relay 连接到已经运行的 daemon，
不会通过 SSH 再启动一个 daemon。团队远程接入必须为每位成员配置一条 SSH
`authorized_keys` forced command，见[使用 SSH forced command 接入团队](#使用-ssh-forced-command-接入团队)。

## 支持的拓扑

- 本地 daemon，单仓：在 canonical 仓库旁直接运行普通 `ha` 命令；CLI 会按需注册并
  自动启动本地 daemon。
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

CLI 命令默认走本地 daemon，并在需要时自动启动：

```bash
ha task list
```

只有初始化、恢复或无法启动 daemon 的测试 fixture 才显式使用
`HARNESS_DAEMON_MODE=direct`；不要把它写成锁冲突的绕行方案。

`ha init` 默认显式写入 `settings.identity.mode: local`，并在缺失时创建机器级
`~/.harness/people.yaml`。项目可用 `harness/people.yaml` 覆盖资料和权限，但不得把机器级
credential 静默改绑给另一个 person。daemon 与 direct recovery 共用同一条解析链：机器级
roster → 项目覆盖 → remote 项目的远程权威。

CI / sandbox 必须显式选择 isolated profile；registry、机器 roster 与 endpoint identity 会落在
项目 `.harness/daemon-profile` 下，不写 `~/.harness`：

```bash
ha --daemon-profile isolated init
ha --daemon-profile isolated daemon repo register --repo-id ci --root "$PWD"
ha --daemon-profile isolated task list
```

`--daemon-profile default|isolated` 与 `--daemon-mode direct|local|remote` 只覆盖当前进程；
repo config 仍是持久 mode 声明。remote 不可达时 fail-closed，不会降级成本地身份。

## 多仓 Registry

把同一个 daemon 要服务的每个本地 canonical 仓库都注册进去：

```bash
ha daemon repo register --repo-id A --root /srv/harness/a
ha daemon repo register --repo-id B --root /srv/harness/b
ha daemon start --service
```

用 `--repo` 把 CLI 命令路由到已注册仓库：

```bash
ha --repo A task list
```

运行中的 daemon 每秒 reconcile 一次 registry。新注册的仓库可以热挂，不需要重启
daemon。

## 提交手改 task prose

机器读字段和 typed records 继续使用各自的 CLI/RPC 命令。手改已登记的人读 task prose
后，先检查，再只提交自己拥有的路径：

```bash
ha doc status --json
ha doc sync --dry-run --json
ha doc sync --submit --path tasks/task_01ABC/task_plan.md --json
```

需要提交多个文件时重复 `--path`。daemon 会重新派生允许区域，拒绝结构化或无法解析的
触碰，检查 Git base，并创建带真实归因的 commit。doc sync 已接受的文件不要再补一次
raw Git commit。

提交后你的工作树文件全程保留提交内容：发布器以 headless 方式提交到 session 分支，
不会 checkout 或重置共享工作树。旧版本在提交后会把文件短暂回退成提交前的内容、
直到后台合并恢复；该行为已移除，提交后无需等待。

顶层 ADR、standard、template 与 repository-agent prose 尚未进入已登记的 doc-sync 面；在
write-road registry 明确分类这些路径前，继续使用其既有治理仓库流程。`doc sync` 会对未知
Markdown fail closed，不会因为扩展名像 prose 就擅自放行。

### task complete 自动物化

当 `ha task complete` 发现尚未发布的已登记 task prose，或 task 自身 `artifacts/` 目录下的
文件时，daemon 会把恰好这些 dirty path 交给既有 doc-sync/artifact 发布写路，等待 canonical
settlement，再重跑 prepublish 检查。自动化只代办机械发布；closeout 写实、execution review、
code-doc reconcile 与 consent 门仍按原顺序执行。已发布并被 Git 跟踪的 artifact 也能直接
更新，不再需要先手工从 Git index 移除。

dry-run 仍然只读，并返回原始 prepublish 发现。若自动物化失败，complete 也会失败；回执会
逐个给出文件、拒收或 settlement 原因、以及可直接执行的修复步骤。先运行
`ha doc status --json`；修复指定文件后，运行 `ha doc sync --submit` 并重试 task complete。
若是 settlement 故障，则运行失败回执中打印的 receipt-status 命令。

## Remote SSH Relay

Remote 模式连接持久远程 daemon。先在 repo config 声明 `settings.identity.mode: remote`，
再提供连接坐标。客户端会打开 SSH stdio 会话，服务器的 forced command 把它 relay 到 daemon：

```yaml
schema: harness-anything/v1
settings:
  identity:
    mode: remote
  daemon:
    remote:
      host: team-host
      root: /srv/harness/team
      repoId: canonical
      haPath: ha
```

CLI 与源码 GUI 复用这份配置和同一传输。从包含该文件的客户端目录运行
`ha task list` 或 `ha gui`，都会读取远端 canonical；本地目录不需要保存 task、decision
或 fact 数据副本。需要覆盖文件配置时，可使用 `HARNESS_DAEMON_MODE`、
`HARNESS_DAEMON_SSH_HOST`、`HARNESS_DAEMON_REMOTE_ROOT`、
`HARNESS_DAEMON_REPO_ID` 与 `HARNESS_DAEMON_REMOTE_HA`。远端二进制默认是
`ha`，repo id 默认是 `canonical`。

客户端实际执行的是 `ssh <host> <remote-ha> daemon connect --stdio`。服务器必须已经为
canonical root 启动 `ha daemon start --service`。每个请求都会携带 remote root，并且它必须
匹配成员 forced command 固定的 root。

持久 daemon 缺失或 forced-command root 不匹配时，GUI 会显示远端错误，不会启动或回退到
本地 daemon。task 与 decision 读取始终实时请求 daemon；renderer cache 只用于显示。decision
mutation 使用远端已认证 principal。task status 与 progress mutation 在其 GUI route 接入带归因的
daemon write coordinator 前仍不可用。

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

同一 OS 用户、daemon user root 与 daemon ID 的默认 POSIX endpoint 不会因调用者的
`TMPDIR` 不同而变化。Linux 仍优先使用 `XDG_RUNTIME_DIR` 与 `/run/user/<uid>`；共享回退路径
位于 `/tmp` 下按 UID 隔离的私有目录。显式 `--socket` 仍会覆盖默认 endpoint。

Unix transport 不读取连接进程的身份。它记录
`unix-socket-owner-boundary`，subject 是 socket 文件属主的 `stat.uid`。每个成功连接
的客户端之所以归属该 owner，只因为 `0700` 目录与 `0600` socket 仅允许 owner
连接。放宽任一权限都会使这个边界失效，届时必须改用其他身份来源。

`~/.harness/people.yaml` 是机器级身份权威；项目 `harness/people.yaml` 在其上覆盖且不得
静默改绑 credential。没有可用 roster 时，写入会带配置命令 fail-closed。本地 repo 即使收到
forced-command 首帧也会忽略其中的 personId，仍按 socket owner boundary 解析；只有显式
`remote` 的 repo 才采信该帧。

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
