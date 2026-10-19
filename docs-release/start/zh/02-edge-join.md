# 安装并加入边缘节点

在干净的 macOS 或 Linux 机器上准备 Git、Node.js 24+ 与 curl，再运行源码安装命令：

```bash
git --version
node --version  # 必须为 v24 或更高版本
curl --version
```

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

安装器把源码保存在 `~/.local/share/harness-anything`，执行 `npm ci`，构建 daemon、CLI 与 Electron GUI，并通过
`npm link` 生成 `ha` 入口。Linux 会设置 Electron 所需的 `chrome-sandbox` 属主与 setuid 权限（必要时使用
`sudo`）。本项目当前分发源码，不宣称已提供签名安装包或 registry package。

在中心 GUI 中打开「设置 → 仓库与连接 → 中心」，为新成员创建邀请，选择一个或多个仓库以及要授予的权限组，
再通过独立渠道把 `harness-edge://join/...` 链接交给该成员。邀请有效期为 72 小时，只能消费一次；处于 pending 状态时可以撤销。不要公开发布邀请链接。

受邀成员运行：

```bash
ha edge join '<邀请链接>'
```

命令先登录中心的设备登录服务；发送邀请令牌或登录访问令牌之前，会先验证邀请链接绑定的中心 TLS 公钥。随后命令消费邀请，
并完成每个所选仓库的首次同步。机器凭据只写入本机边缘配置；加入回执与状态查询不返回凭据。如果所选仓库或权限组快照已改变，
中心会拒绝加入，需要由邀请人按最新权限重新签发。

Wayland 会话启动 GUI 时使用 `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`。加入后可运行
`ha gui --root <边缘仓库>` 查看中心台账，再从该仓库使用通常的 `ha runtime run` 派出 Agent。
