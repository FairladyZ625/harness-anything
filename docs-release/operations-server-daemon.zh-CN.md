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

## 连接模式 / Connection modes

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

## registry v2 硬切

包含 PR #2155 的版本要求 registry v2。机器上的 v1
`~/.harness/registry.json` 会被拒绝，必须重新注册仓库。注册本地工作区：

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
```

纯展示仓库使用上面的 `remote-proxy` 注册命令。v1 registry 没有兼容路径。

## Fleet 中心与边缘

`remote-center` 和 `remote-edge` 用于既有 Fleet 拓扑，不用于纯展示。部署和运维请见
[Fleet center deployment](../tools/fleet-center/README.md)。

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
