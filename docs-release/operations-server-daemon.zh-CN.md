# Server Daemon 运维

Harness Anything 有三种连接模式。它们是 `~/.harness/registry.json` 中的机器本地
registry 选择；一个仓库只能注册为其中一种模式。

## 连接模式 / Connection modes

| Registry 模式 | 适用场景 | 本机运行内容 | 数据与写入权威 |
| --- | --- | --- | --- |
| `local` | 普通本地开发 | daemon、runtime、GUI 与工作区 | 本机台账及其单写队列 |
| `remote-proxy` | 纯展示服务器仓库 | GUI 与透传 daemon；没有工作区 | 远端 daemon 及其单写队列 |
| `remote-center` / `remote-edge` | 既有 Fleet 中心和边缘部署 | 视场景运行中心或边缘组件与镜像 | Fleet 中心 lease 队列 |

要开发服务器上的仓库，请 SSH 到服务器。`remote-proxy` 本机没有工作区，也不是远程 CLI
开发环境。

## 首次使用：Windows 纯展示服务器

当 Windows 只需显示仍留在服务器上的仓库时，使用此流程。服务器 daemon socket 路径由
服务器上 `ha daemon status` 的 `target: endpoint=` 行显示。

1. 在服务器上启动常驻 daemon：

   ```bash
   ha daemon start --service
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

## 本地 socket 边界

本地 daemon socket 是访问边界。其目录以 `0700`、socket 文件以 `0600` 创建；不要扩大
任一权限。纯展示流程中的 endpoint tunnel 由用户管理，且不应把 daemon socket 暴露为公网
listener。
