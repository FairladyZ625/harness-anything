# 安装并加入边缘节点

在干净的 macOS 或 Linux 机器上运行源码安装命令：

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

安装器把源码保存在 `~/.local/share/harness-anything`，执行 `npm ci`，构建 daemon 与 CLI，并通过 `npm link`
生成 `ha` 入口。Linux 会设置 Electron 所需的 `chrome-sandbox` 权限。本项目当前分发源码，不宣称已提供签名
安装包或 registry package。

然后消费中心邀请链接：

```bash
ha edge join '<邀请链接>' --observed-spki-sha256 '<SPKI 指纹>'
```

该命令复用已有 typed `daemon.rbac.manage` edge-join consume 动作。中心 daemon 串行消费邀请，校验链接中的
SPKI 指纹和登录身份，并拒绝过期或已消费链接。加入成功后，已有 remote-edge 注册与常驻 replica 路径负责
`fleet-edge.json` 和首次同步。多个边缘节点各自持有机器凭据；中心单写者负责邀请消费以及 lease/复制协调。

Wayland 会话启动 GUI 时使用 `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`。加入后可运行
`ha gui --root <边缘仓库>` 查看中心任务，再从该仓库使用通常的 `ha runtime run` 派出 Agent。
