# 安装并加入边缘节点

在干净的 macOS 或 Linux 机器上运行源码安装命令：

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

安装器把源码保存在 `~/.local/share/harness-anything`，执行 `npm ci`，构建 daemon、CLI 与 Electron GUI，并通过
`npm link` 生成 `ha` 入口。Linux 会设置 Electron 所需的 `chrome-sandbox` 属主与 setuid 权限（必要时使用
`sudo`）。本项目当前分发源码，不宣称已提供签名安装包或 registry package。

然后消费中心邀请链接：

```bash
ha edge join '<邀请链接>'
```

命令会从链接读取中心证书指纹，启动设备登录流程，并向中心发送一次 `edge.join` 准入请求。中心在签发机器凭据前
会校验交互式登录令牌与邀请归属。

Wayland 会话启动 GUI 时使用 `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`。加入后可运行
`ha gui --root <边缘仓库>` 查看中心任务，再从该仓库使用通常的 `ha runtime run` 派出 Agent。
