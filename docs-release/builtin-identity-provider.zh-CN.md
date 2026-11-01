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

<a id="keycloak-plugin"></a>

## Keycloak 插件

需要协作能力时，先安装 Keycloak provider 包：

```bash
npm install --global @harness-anything/authorization-keycloak@0.1.0
```

该包提供 Keycloak 身份 provider；部署仍需自行提供并配置 Keycloak 服务和 realm。daemon、GUI 和授权接口保持不变，只切换选中的身份 provider。然后显式切换到已有 Keycloak：

```bash
ha bootstrap --mode external --url https://identity.example.com \
  --realm fleet --client-id harness-center --client-secret-stdin < ./client-secret
```

切换不会自动迁移本地凭据或授权。请先在 Keycloak realm 中创建需要的账号、角色和授权，再执行 `ha bootstrap --operation login`。回切内置 provider 需要显式写入 `mode: builtin` 并重新登录。

### 旧 edge 根目录恢复

旧版 Keycloak 创建的 edge 根目录可能只有 `fleet-edge.json` 和
`rbac/oidc-session.json`，没有 `rbac/config.json`。恢复时安装 Keycloak 插件并保留
这些文件，按 `fleet-edge.json` 指向的中心执行正常 edge 登录。daemon 会在首次成功
写入按中心键控的会话前读取旧会话，不会自动把旧 edge 切到本地 provider。旧会话可用
后，只有在业主明确选择目标 provider 时，才在 `rbac/config.json` 写入显式 selector。
新建本地根目录没有 selector 仍默认使用内置身份；这不表示旧 edge 可以使用本地身份。
