# 内置身份提供方

Harness Anything 默认使用本地内置身份提供方。首次启动只创建用户根目录下的 `rbac/config.json` 和 `rbac/builtin-state.json`，不会下载 Java、Keycloak 或 PostgreSQL。内置 provider 只服务单机单人：首个本地管理员、该用户的会话和本地仓库授权。

```bash
ha bootstrap
ha bootstrap --operation bootstrap-status
ha bootstrap --operation bootstrap-admin --username owner --email owner@example.invalid \
  --display-name Owner --person-id person-owner --password-file ./owner-password
ha bootstrap --operation login
ha bootstrap --operation login-poll
```

团队、额外账号、组和授权管理、节点凭据、edge join、Fleet 中心/边缘传输、远程 GUI 登录和远程会话续期都属于协作功能。内置 provider 会统一拒绝这些入口，并提示安装 Keycloak 插件；系统没有第二条授权路径。

## Keycloak 插件

需要组织级身份时，显式切换到已有 Keycloak：

```bash
ha bootstrap --mode external --url https://identity.example.com \
  --realm fleet --client-id harness-center --client-secret-stdin < ./client-secret
```

切换不会自动迁移本地凭据或授权。请先在 Keycloak realm 中创建需要的账号、角色和授权，再执行 `ha bootstrap --operation login`。回切内置 provider 需要显式写入 `mode: builtin` 并重新登录。
