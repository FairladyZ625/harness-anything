# 安装并加入边缘节点

在干净的 macOS 或 Linux 机器上准备 Git、Node.js 24+ 与 curl，再运行源码安装命令：

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

中心管理员先在已登录的中心仓库中签发邀请：

```bash
ha bootstrap --operation edge-join-create --center-url https://center.example.test:9443 --node-id <node-id> --spki-sha256 <fleet-listener-sha256-pin>
```

邀请同时绑定 Fleet listener 的证书 SPKI 与 Keycloak HTTPS listener 的公开证书；链接不包含私钥或用户令牌。
中心端须分别配置可达的 Fleet TLS listener 与带 HTTPS 证书的 Keycloak listener。

命令从邀请读取 Fleet 指纹，使用邀请中的 Keycloak 证书验证设备登录连接，再向中心发送一次 `edge.join` 准入请求。
该信任仅用于邀请指定的登录 authority，系统 TLS 校验仍保持开启。中心在签发机器凭据前会校验交互式登录令牌与邀请归属。

Wayland 会话启动 GUI 时使用 `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`。加入后可运行
`ha gui --root <边缘仓库>` 查看中心任务，再从该仓库使用通常的 `ha runtime run` 派出 Agent。
