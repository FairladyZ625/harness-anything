# 服务器 Daemon 运维

Harness Anything 团队模式使用一个常驻 daemon 托管一份 canonical 仓库。客户端
只通过 SSH 到达服务器，不需要打开公网 TCP 端口。

## 前置条件

- Node.js 满足当前 package engine 策略。
- 服务器用户的 `PATH` 上有 `ha`。
- 服务器安装 Git。
- 每位团队成员有 SSH 访问权限。
- daemon 用户可写 canonical 仓库路径。

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

status 报告锁持有者、队列深度、当前/累计连接数、daemon 版本和协议版本。stop 发送
`SIGTERM`，并等待 daemon runtime 排空队列、释放全局锁。
