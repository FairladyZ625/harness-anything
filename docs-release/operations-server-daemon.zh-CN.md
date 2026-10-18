# Server Daemon 运维

Harness Anything 有三种连接模式。它们是 `~/.harness/registry.json` 中的机器本地
registry 选择；一个仓库只能注册为其中一种模式。

## 无桌面中心首次引导

在中心主机上启动 daemon 后，通过同一 CLI 安装身份服务、设置浏览器可达的 HTTPS 地址并创建首管理员：

```bash
ha bootstrap
ha bootstrap --operation listener
ha bootstrap --operation listener-set --listen-address <地址> --hostname <主机名> --port 8443 --certificate-file <证书.pem> --certificate-key-file <私钥.pem> --expected-version <版本>
ha bootstrap --operation bootstrap-status
ha bootstrap --operation bootstrap-admin --username <用户名> --email <邮箱> --display-name <姓名> --person-id <person-id> --password-file <受控密码文件>
ha bootstrap --operation login
ha bootstrap --operation session
ha bootstrap --operation node-register --operation-id <unique-id> --node-id <node-id> --person-id <person-id> --credential-file <新凭据文件>
```

密码文件只允许所有者读取（例如 `0600`），argv 只放路径；CLI 去掉文件末尾一个换行，仅通过中心原始本地 socket 发送密码。使用后删除密码文件。

尚无 `access-admin` 成员时，socket 所有者可配置既有 HTTPS listener；先读取版本，使用浏览器设备信任的证书。listener 设置与首管理员创建共用队列，只有一个首管理员能成功，之后排队的未登录设置也会被拒。管理员存在后，即使无人登录也不能重新开放窗口，必须以 `access-admin` 身份登录才能修改。边缘与远程 GUI 不能执行首次引导。

`login` 在另一台有浏览器的设备完成授权，中心和边缘复用同一入口。随后节点登记只将一次性机器凭据写入新的受控文件。

## 外接 Keycloak 中心凭据

在中心主机上，准备已有 fleet realm、`harness-center` 机密服务账号客户端，以及 Harness 所需的 realm-management 权限和 Authorization Services 配置。浏览器登录使用 `harness-gui`。先配置凭据，再执行上面的首管理员命令：

```bash
ha bootstrap --mode external --url https://identity.example.com --realm fleet --client-id harness-center --client-secret-stdin < /path/to/protected-client-secret
```

密钥只从重定向 stdin 输入并经中心原始本地 socket 传输，保存在中心 user root 中仅所有者可读的文件；health/status 和回执不读回密钥。realm 或凭据校验失败保留旧配置。其他 client ID 会被拒绝。首管理员已存在后，更换配置必须先在当前权威登录为 `access-admin`。

本地 GUI 的「账号与访问控制 → 改接外部 Keycloak」提供相同入口。输入 URL、realm 和中心客户端密钥后验证并应用；密码框在提交时清空，包括失败情况。外接 realm 需要首次引导时也显示首管理员表单。边缘节点和 remote-proxy 连接不能配置中心凭据。

## 连接模式 / Connection modes

在已登记工作区读取当前保留日志的性能窗口：

```bash
ha daemon metrics --window 1h
ha daemon metrics --window 7d --json
```

默认窗口 24h，可选 15m、1h、24h、7d。命令复用 `observe.tail` 读取已有轮转日志，不新增存储或采样。
request 日志仅排除 `observe.tail` 的 `kind: repo-log`、`direction: history` 诊断读（含失败读取），
避免诊断扩大自身分母和留存。业务请求、其他观察种类及 repo-log follow 维持原有记录行为，
连接日志仍记录诊断流量。此前已记录的诊断仍留在历史及统计中，不改写，也不从统计中滤除。
输出已完成请求总数、观察首末时间，以及超过一小时的静默区间。读完保留历史不代表窗口连续覆盖：
静默可能是无请求，也可能是留存丢失；7d 不会把较短的保留跨度外推成整周流量。

P50/P95 对所有合格样本使用 nearest-rank。每个时间字段独立列出样本数与缺失数；不足 20 个样本
标注 low sample，缺失值保持 unknown。主动 runtime await 单独计数，不进入延迟分母。
这些是 daemon duration、service 与 dispatch 时间；未独立测量 CLI 端到端耗时或 handler 内部排队。
日志混合多个客户端，不能称为 CLI 专用量。来源不可用或游标缺口会使命令失败，不输出局部统计。
用 `--root` 和 `--repo` 选择已登记仓库。

| Registry 模式                   | 适用场景                  | 本机运行内容                   | 数据与写入权威           |
| ------------------------------- | ------------------------- | ------------------------------ | ------------------------ |
| `local`                         | 普通本地开发              | daemon、runtime、GUI 与工作区  | 本机台账及其单写队列     |
| `remote-proxy`                  | 纯展示服务器仓库          | GUI 与透传 daemon；没有工作区  | 远端 daemon 及其单写队列 |
| `remote-center` / `remote-edge` | 既有 Fleet 中心和边缘部署 | 视场景运行中心或边缘组件与镜像 | Fleet 中心 lease 队列    |

要开发服务器上的仓库，请 SSH 到服务器。`remote-proxy` 本机没有工作区，也不是远程 CLI
开发环境。

## 登录与人工确认

无桌面的中心和边缘共用同一个命令行入口：

```bash
ha bootstrap --operation login
ha bootstrap --operation session
ha bootstrap --operation logout
```

`login` 显示 Keycloak 的登录网址、一次性验证码和到期时间，并等待浏览器授权。可以在另一台
有浏览器的设备上打开网址、输入验证码，用本人的账户登录；密码不放在命令参数中。
在边缘镜像目录执行时，daemon 通过已认证的 Fleet 连接取得中心的 HTTPS 登录地址和 realm，
无需另配边缘 Keycloak。中心必须先配置可达的授权服务器；首次管理员引导在中心本机完成。

同一个人在两台边缘登录时，会话分别保存在各自 daemon，每个节点独立续期和注销。边缘命令
通过 Fleet TLS 携带短期访问令牌，中心逐次在线验证节点当前所有者的交互会话并求值权限。
没有登录、只有机器凭据、所有者不符、会话被撤销或授权服务器不可达时，人工确认会被拒绝。
任务租约和评审独立性仍须满足。

桌面 GUI 使用系统浏览器登录。在 `remote-proxy` 模式，先选择服务器仓库，再使用侧栏登录
或「账号与访问控制」页；登录、会话、注销、控制台和授权管理都作用于所选服务器 daemon。
浏览器授权期间切换仓库，当前登录仍完成到发起时的服务器。首次管理员引导须通过中心原始
本地连接完成。

## 首次使用：Windows 纯展示服务器

当 Windows 只需显示仍留在服务器上的仓库时，使用此流程。服务器 daemon socket 路径由
服务器上 `ha daemon status` 的 `target: endpoint=` 行显示。

1. 在服务器上把 daemon 安装为用户级服务（见[常驻服务](#常驻服务macos-与-linux)）：

   ```bash
   ha daemon service install
   ```

2. 在 Windows 上把本地 TCP 端口转发到该服务器 socket。请替换 socket 路径和主机：

   ```bash
   ssh -L 9911:/path/to/server-daemon.sock <host> -N
   ```

   只要把远端 daemon endpoint 转到本机端口，也可以使用 UU、FRP 或 VPN。

3. 在 Windows 上添加并探测本机 endpoint，再将选中的服务器仓库注册为纯展示。添加命令
   返回的 connection identifier 用于仓库注册：

   ```bash
   ha daemon connection add --endpoint tcp://127.0.0.1:9911
   ha daemon connection probe --endpoint tcp://127.0.0.1:9911
   ha daemon repo register --repo-id <id> --mode remote-proxy --connection <connection>
   ha gui
   ```

   也可以直接使用 endpoint 注册：

   ```bash
   ha daemon repo register --repo-id <id> --mode remote-proxy --endpoint tcp://127.0.0.1:9911
   ```

   GUI 路径是 **设置 → 仓库与连接 → 添加连接 → 探测 → 注册所选为纯展示仓**。

纯展示模式下，「在系统中打开」会打开服务器副本。项目外本机文件链接不可用，且没有本机
bootstrap 入口。

## Local 模式

注册工作区并启动常驻 daemon：

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
ha daemon start --service
ha gui
```

## 任务分支发布与 direct-push 保护

产出为仓库变更的任务在 Harness 管理的工作树中运行，分支以任务标识命名。被派工的
worker 在其中提交，并经 daemon 代办的命令发布，绝不使用本人 GitHub 登录：

```bash
ha task push <task-id>        # 经 daemon 代持凭据发布任务分支
ha task pr <task-id>          # 创建 pull request（--update 更新已有）
```

Worker 使用托管平台 CLI 和自己的平台凭据读取检查。GitHub 使用
`gh pr checks <PR-number> --watch`，并用 `gh run view <run-id> --log-failed` 查看失败日志。

每个绑定 worker 都从正在运行的 daemon 安装中取得 `ha`，并通过 worker 环境收到本次
派工仓库 root 与 daemon 路由。中心与边缘 daemon 使用同一路径，不使用固定 canonical
root 的 edge 专用包装器。worker 的 Git 作者和提交者身份由派工发起人生成，只写入该
checkout 的 worktree config；结算和 edge delivery 均按 execution lease 记录的同一 person 身份检查提交。

`ha task push` 只推送名字等于任务标识的分支，并带 `--force-with-lease`，因此不会
静默覆盖更新的远端切点。检出不在该分支，或默认分支之上存在作者/提交者与派工 person
身份不符的 commit 时，推送被拒绝，并以 `delivery_publish_failed` 带回原因。结算成功的
任务绑定运行也会经同一路径发布分支；
`ha task push` 是 worker 在 submit 之前发布的方式。合入仍归 maintainer——见
[PR、审查与合入](contributing/zh/04-pr-review-and-merge.md)。

这些命令使用的凭据由操作者绑定，而不是由 worker 配置：
[托管 Git 凭据](hosted-credentials.zh-CN.md)。

direct-push 保护不只在 daemon 一侧，还落在 worker 自己的环境里：任务绑定 worker
的 git 凭据只能经一个只应答 `github.com` 提示的 askpass 助手取得，`PATH` 上排在
真实 git 前面的包装器会拒绝任何会更新 `task_*` 以外目标的 `git push`（包括
`--all`、`--mirror`、`--delete`）。同一包装器还拒绝 worker 在 canonical 仓库根内
commit 或检出新分支。因此即使 worker 手动推送，也发布不了自己任务分支以外的
任何东西。

## 常驻服务（macOS 与 Linux）

需要 daemon 在崩溃和重启后自己回来的机器，把 daemon 交给操作系统的服务管理器：

```bash
ha daemon service install     # 写入并加载用户级单元，启动 daemon
ha daemon service status      # 单元是否已加载，正在运行的 daemon 是否由它托管
ha daemon service uninstall   # 停止被托管的 daemon 并移除单元
```

`install` 在 macOS 上生成 `~/Library/LaunchAgents` 下的 launchd agent，在 Linux 上生成
`~/.config/systemd/user` 下的 systemd 用户单元，不需要 `sudo`。每个 user root 与 daemon id
对应一个单元：重复安装不产生变化，同一台机器上的两个 user root 各有各的单元。Windows 不支持，
请在 Windows 上使用 `ha daemon start --service`。

单元安装之后：

- daemon 崩溃或被杀后由服务管理器重新启动。正在运行的 agent 会话不会被连带停止，新 daemon 会收养它们。
- daemon 因磁盘上有更新的构建而退出时，由服务管理器重新启动，任意时刻只有一个 daemon。
- `ha daemon stop` 之后保持停止，服务管理器自身的重启和机器重启都不会把它拉起，直到执行
  `ha daemon start --service`。这两条命令都让 daemon 留在服务管理器的托管之下。
- `ha daemon service status` 只在正在运行的 daemon 就是单元启动的那个进程时以 `0` 退出。
  常驻节点的健康信号用它，不要用 `ha daemon status` 的退出码。

单元记录的是执行 `install` 的那个 shell 的 `PATH`，daemon 通过它找到 `git` 与各 agent CLI。
`PATH`、Node.js 位置或 Harness Anything 的 checkout 变化之后，重新执行一次 `install`。

若 HTTPS 端点使用私有 CA，安装时显式提供 PEM 文件：

```bash
NODE_EXTRA_CA_CERTS=/path/to/ca.pem ha daemon service install
```

单元只保留这个路径和 `PATH`，不复制其余 shell 环境变量。相对 CA 路径按安装进程的当前目录
转成绝对路径，文件需始终对服务用户可读。证书验证保持开启，Node 在进程启动时读取额外证书。
更换路径时带新值重新执行 `install`；移除时不带该变量重新安装，单元发生变化会重新加载。
若只替换同一路径的文件内容，执行 `ha daemon stop` 再执行 `ha daemon start --service` 重新读取证书。
这配置的是包括 OIDC 在内的 Node HTTPS 信任；Fleet 独立的 `caPath` 不会配置 OIDC 信任。

开机后无人登录也要启动，需要一个 Harness Anything 不代做的特权步骤：Linux 上执行
`loginctl enable-linger <user>`，macOS 上为该用户打开自动登录。

## 从 task 与 runtime 拒绝中恢复

回执的 validation diagnostic 会指出被拒字段、当前值与重试命令。恢复时按以下状态规则处理：

| 错误码                                | 条件                                                   | 恢复方式                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_submission`                  | closeout 文档无法生成有效 submission                   | 修正回执点名的 `closeout.md` 小节，再运行 `ha task submit <task-id>`。                                                                       |
| `invalid_runtime_mission`             | `--mission` 收到路径或非法 id                          | 使用小写裸 id；daemon 读取 `harness/<task-package>/artifacts/missions/<name>.md`，再运行 `ha agent run <agent> --task <task-id> --mission <name>`。 |
| `declare-executor` 的 `invalid_proof` | execution 不满足 `submitted/review` 且 `executor=none` | 已分配的 submitted execution 运行 `ha task review-execution`；仅未分配的 execution 使用 `ha task declare-executor`。                                    |
| `executor_binding_invalid`            | 声明的 executor 与 task binding 或 held lease 不同     | 从 diagnostic 点名的 expected executor 执行回执里的重试命令。                                                                                           |
| `task start` 的 `invalid_transition`  | 当前 round 已有 active execution                       | 不传 `--execution-id`，运行 `ha task start <task-id>` 复用它。                                                                                          |
| `lease_required`                      | submit 调用者不持有 execution lease                    | 运行 `ha task start <task-id>`，再由 holder 重试 submit。                                                                                               |
| `lease_not_found`                     | runtime 结算已释放 lease                               | 不传新的 execution id 运行 `ha task start <task-id>`，再重试 submit。                                                                                   |
| `ha task pr` 的 `runtime_credential_unavailable` | 派工的 runtime instance 未绑定托管凭据，或原生凭据库解析失败 | 由操作者绑定凭据（[托管 Git 凭据](hosted-credentials.zh-CN.md)）。 |
| provider key 命令的 `runtime_credential_unavailable` | 原生凭据库不可用（例如 Linux keyring 未解锁） | 按 [Provider API keys](provider-credentials.md#linux-without-a-desktop) 的无桌面 keyring 设置处理。 |
| `ha task push` 的 `delivery_publish_failed` | 任务分支推送被拒绝或被远端拒绝（检出在别的分支、git 身份缺失或非本仓身份、CAS 切点丢失、网络） | 读回执里的原因，在本地修正点名的问题后重试 `ha task push <task-id>`。 |
| 点名 `task push` / `task pr` 的 `unsupported_command` | 该机器的 CLI 或 daemon 版本早于这些命令 | 升级 CLI 与 daemon 后重试。 |

## registry v2 硬切

包含 PR #2155 的版本要求 registry v2。机器上的 v1
`~/.harness/registry.json` 会被拒绝，必须重新注册仓库。注册本地工作区：

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
```

纯展示仓库使用上面的 `remote-proxy` 注册命令。v1 registry 没有兼容路径。

## Fleet 中心局域网可达与边缘自助接入

这里有两个独立的 HTTPS 入口。`listener-set` 配置 managed Keycloak 登录服务，负责浏览器登录和 token issuer；Fleet TLS listener 是 edge 同步服务，通过 `daemon fleet center start` 配置。不要把一个命令的地址当成另一个命令的配置。

登录服务的绑定地址必须是中心主机上的 IP，`--hostname` 必须出现在证书 SAN 中。私钥保持 owner-only（权限 `0600`）：

```bash
ha bootstrap --operation listener
ha bootstrap --operation listener-set --listen-address 192.168.1.20 --hostname center.example.test --port 8443 --certificate-file /etc/harness/center.pem --certificate-key-file /etc/harness/center-key.pem --expected-version <version>
```

边缘同步服务把 Fleet listener 绑定到局域网地址，并把该地址加入证书 SAN。daemon 在打开 listener 前校验证书 SAN；地址已占用、不可用或权限不足时，回执会返回对应错误码：

```bash
ha daemon fleet center start --bind 192.168.1.20 --port 9443 --key /etc/harness/center-key.pem --cert /etc/harness/center.pem --repo <repo-id> --quota-bytes 1073741824
```

每次变更后重新读取 listener，并把返回的 version 用于下一次变更。使用同一私钥重签时，已有邀请链接的 pin 仍然有效。替换私钥会改变 SPKI pin：换钥后重新创建邀请；旧链接会以 `pin_mismatch` 拒绝。替换 listener 会中断现有 edge 连接，edge 信任新证书并再次运行 `ha daemon fleet edge sync` 后才会恢复。

受支持的 edge 路径是邀请链接。中心管理员登录后创建链接，edge 所有人登录并消费一次；链接只携带中心 URL 与证书 pin，不携带机器凭据：

```bash
ha bootstrap --operation edge-join-create --center-url https://center.example.test:9443 --node-id <node-id> --spki-sha256 <sha256-pin>
ha bootstrap --operation edge-join-consume --link '<harness-edge://join/...>' --observed-spki-sha256 <sha256-pin>
ha daemon fleet edge sync --host center.example.test --port 9443 --ca /path/to/center-ca.pem --node-id <node-id> --view-root /var/lib/harness/edge-view --quota-bytes 1073741824
```

edge 命令必须使用证书 CA；证书名与 DNS 名不同时加 `--servername`。证书未覆盖请求的 server name 时，TLS 主机名校验会拒绝连接；端口关闭会导致连接失败；链接过期、登录人不匹配或 pin 改变会由加入准入拒绝。凭据由本机 daemon 写入，不放进邀请 URL。

### 安装、升级与开发救援

按[安装说明](start/zh/01-install.md)从同一候选 checkout 安装 CLI 与 daemon。使用已有命令升级 managed center authority，然后重启 daemon 管理的服务，并在再次改 listener 前重新读取版本：

```bash
ha bootstrap --operation upgrade --backup-dir /var/backups/harness-rbac
ha bootstrap --operation listener
```

只有开发诊断可以通过 SSH 隧道转发 listener 或本地 daemon endpoint。隧道是临时救援路径；生产 edge 访问仍使用已配置的 listener、证书 SAN、邀请 pin 与 edge sync 流程。

## Fleet 中心与边缘

`remote-center` 和 `remote-edge` 用于既有 Fleet 拓扑，不用于纯展示。部署流程依赖具体环境，
不属于公开产品文档；环境部署和演练步骤请使用私有运维手册。

边缘镜像只包含中心台账已接受的文档。`ha init` 会把它写在 `harness/governance/` 和
`harness/context/` 下的脚手架文档作为台账文档发布，所以新建中心的边缘节点能收到它们。
由旧版本初始化的中心，这些文件只在磁盘上。在中心执行一次发布：

```sh
ha doc sync --submit --path governance/standards/README.md --path context/README.md
```

每个文件写一个 `--path`。`--path` 只接受文件，不接受目录：传目录会被报告为
`inapplicable`，不会发布任何内容。在中心手写的规范或上下文文档同样要走这一步。
文档发布后，边缘在下一次同步时看到它。

## 本地 socket 边界

本地 daemon socket 是访问边界。其目录以 `0700`、socket 文件以 `0600` 创建；不要扩大
任一权限。纯展示流程中的 endpoint tunnel 由用户管理，且不应把 daemon socket 暴露为公网
listener。
