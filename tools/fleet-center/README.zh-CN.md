# Fleet 中心用户态部署

**English** | [简体中文](./README.zh-CN.md)

`centerctl.sh` 是面向 `tencent-lighthouse-prod` 的 W5-R 生产切换演练部署。它在登录用户的
home 下安装固定版本的 Node 24 tar 包、克隆并构建 Harness Anything、把一份台账备份恢复到
`~/harness-center/repo` 并以 `remote-center` 挂载、启动托管授权服务、生成私有 TLS 物料与
任务分派名册（roster），最后启动 daemon 持有的 TLS 中心。它绝不使用 sudo、Docker、系统级
GitLab/nginx 配置，也不碰宿主机默认的 Harness daemon。

## 制作备份

中心由既有 canonical 仓库的一致性备份引导；仅凭私有台账的 Git clone 不够——SQLite
canonical 存储与激活状态从不进入 Git。在当前持有该仓库的机器上，通过它的 daemon 取备份
（写队列保证快照一致），再经你信任的通道把目录传到中心主机——它承载完整私有台账：

```bash
ha backup /var/tmp/harness-center-backup   # 绝对路径，且必须尚不存在
rsync -a /var/tmp/harness-center-backup tencent-lighthouse-prod:~/harness-center-backup
```

备份自带校验：manifest 或 payload 摘要不符、不含 SQLite canonical 存储、或所属仓库 id 与
`HARNESS_CENTER_REPO_ID` 不一致的备份，`up` 都会拒绝。这些准入判定在恢复任何内容之前
直接读备份自带的 manifest，被拒绝的备份不会在中心留下半初始化的目录。重复 `up` 不会
再次恢复：它复验已记录的恢复回执，然后从已恢复的仓库继续。

首次启动：

```bash
ssh tencent-lighthouse-prod \
  'HARNESS_CENTER_APP_REF=<public-commit> \
   HARNESS_CENTER_BACKUP_DIR=$HOME/harness-center-backup \
   ~/harness-center/bin/centerctl.sh up'
```

`up` 把备份恢复到 `~/harness-center/repo`（该目录必须尚不存在），将这个根注册为
`remote-center`，等待仓库 attach，把投影重建到恢复切点，然后继续启动授权服务、TLS 物料、
名册与 Fleet 监听器。

后续生命周期操作不再需要备份目录：

```bash
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh status'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh down'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh up'
```

`down` 只停止本部署的隔离 daemon，有意保留仓库、TLS 物料、名册与副本状态以备审计/恢复。
主机重启后登录并执行 `up`；daemon 与 Fleet 监听器都是进程持有的，需要重新建立。

恢复出的台账带着源机器的本地 Unix-socket 凭据，在中心主机上不会命中。本部署不编辑
`people.yaml`，也不向 remote center 放行本地写入：写入来自持有节点凭据的 Fleet 边缘，而
人通过连接到该 daemon 的桌面应用登录。

## 名册与节点

`up` 把 `~/harness-center/fleet/roster.json` 写成 `fleet-roster/v3`：每行一个 assignment，
声明节点可以触达什么（`assignmentId`、`nodeId`、`repoId`、`viewId`、`expiresAt`、
`scope`）。名册不回答「节点是谁」：节点的机器凭据与其属主登记在中心的 Keycloak 节点
注册表里，`centerctl.sh` 不创建任何凭据、不注册任何节点。

启动 Fleet 监听器之前，`up` 会执行 `ha bootstrap`，在本部署的 user root 下安装并启动托管
的 Keycloak 与 PostgreSQL。该步骤无需登录。它从 `repo1.maven.org`、`api.adoptium.net`、
`github.com` 下载运行时，回执保留在 `~/harness-center/rbac-bootstrap.json`。

之后的每一步都需要一个人完成，脚本不会代做：

1. 创建首位管理员并登录。本版本两者都只能通过连接到该 daemon 的桌面应用完成；没有桌面
   入口的服务器两者都无从谈起（跟踪于 `task_8352efd2f05ab2eda87b724761`）。
2. 给节点属主开账号，并授予该人仓库上的 `daemon-fleet-edge-sync`。
3. 由持有 `access-admin` 的管理员登录后注册节点。

保持这个顺序：先 `up` 起监听器，再登录。一旦管理员在该 daemon 上登录，
`ha daemon fleet center start` 会被 `authorization_denied` 拒绝，之后需要再次启动监听器的
`up` 会卡在这一步。这是本版本的已知限制。

### 注册一个节点

在中心上、面向本部署的 daemon 执行
（`HARNESS_DAEMON_USER_ROOT=~/harness-center/user-root`、
`HARNESS_DAEMON_ID=center-rehearsal`）：

```bash
mkdir -p ~/harness-center/fleet/nodes/<node-id>
ha bootstrap --operation node-register --node-id <node-id> --person-id <person-id> \
  --credential-file "$HOME/harness-center/fleet/nodes/<node-id>/credential"
ha bootstrap --operation node-list
```

节点首次注册会一次性铸造机器凭据，写入 `--credential-file` 指定的新文件，仅属主可读
（`0600`）。回执只点名文件、绝不携带凭据本身。不带 `--credential-file` 以
`credential_file_required` 拒绝；文件已存在时以 `credential_file_unavailable` 拒绝——两种
情况下都不会注册任何内容。每个节点用独立目录，绝不共享凭据。`<node-id>` 必须是名册
assignment 的 `nodeId`。

把你信任的通道把文件送到边缘机器后，删除中心侧副本。在边缘，凭据写进工作区的
`fleet-edge.json`（`credential`），或以 `ha daemon fleet edge sync --credential` 传入；
优先用文件，避免凭据进入进程列表与 shell 历史。

变更节点属主：从 `node-list` 读出 `version`，再以
`--person-id <new-person> --expected-version <version>` 重复 `node-register`。此时不铸造
凭据、不需要 `--credential-file`。

凭据文件在创建 Keycloak client 之前写好，因此注册要么生效且凭据已在文件里，要么失败且
不留 client。若一次注册报错时文件已经落盘，以 `node-list` 的读数为准：节点已注册，则文件
里的凭据即为可用凭据，无需重做；节点未注册，则删除该文件后重新注册。

### 人工确认

Fleet 节点以机器身份认证，即使其属主是人。来自该连接的 `ha task review-consent` 会被
`human_confirmation_required` 拒绝。请在中心以人的身份登录并在那里记录评审同意。本版本
不支持从边缘交互登录；节点凭据不能替代该确认。

移除节点：

```bash
ha bootstrap --operation node-unregister --node-id <node-id> --expected-version <version>
```

版本过期会得到 `version_conflict`。移除结算后，凭据对新连接立即失效，节点在中心的现存
TLS 会话也会在操作返回前被切断，已缓冲的帧不再处理或应答；经 `receipt-reconcile` 迟后结算
的移除同样切断。节点持有的 lease 由既有超时回收，而非立即吊销。

### 首次同步被拒绝时

| Code | 含义 |
| --- | --- |
| `authentication_failed` | 节点未注册，或凭据不对。两者刻意不可区分。 |
| `authorization_denied` | 节点已注册，但其属主没有该仓库的 `daemon-fleet-edge-sync` 授权。 |

如果出站 GitHub 访问不可靠，可预置 `~/harness-center/app` 为包含 `HARNESS_CENTER_APP_REF`
的干净 Git 检出。只有该固定 ref 缺失时 `up` 才会拉取，因此经审计的 Git bundle 或 rsync
传输同样可行，部署契约不变。
