# 内置身份提供方

Harness Anything 默认使用本地内置身份提供方。首次启动只创建用户根目录下的 `rbac/config.json` 和 `rbac/builtin-state.json`，不会下载 Java、Keycloak 或 PostgreSQL。账号、角色、团队、节点登记和会话都由中心 daemon 的单一写队列持有；密码使用 Node `crypto.scrypt` 派生，登录和节点凭据使用 `randomBytes`/`randomUUID` 生成的不透明值。

```bash
ha bootstrap
ha bootstrap --operation bootstrap-status
ha bootstrap --operation bootstrap-admin --username owner --email owner@example.invalid \
  --display-name Owner --person-id person-owner --password-file ./owner-password
ha bootstrap --operation login
ha bootstrap --operation login-poll
```

内置 provider 只覆盖本地账号、角色、节点 join 和会话，不提供 SSO 或外部目录。多个边缘节点同时 join 或登录时，中心的串行状态是并发主体的唯一权威；边缘只保存中心签发的节点凭据和会话副本，不创建第二套授权状态。

需要组织级身份时，显式切换到已有 Keycloak：

```bash
ha bootstrap --mode external --url https://identity.example.com \
  --realm fleet --client-id harness-center --client-secret-stdin < ./client-secret
```

切换会保留内置状态但不自动把密码、角色或节点迁移到外部 realm。请先在 Keycloak 中创建对应账号和授权，再执行 `ha bootstrap --operation login`；上层 daemon、GUI 和授权端口不变。回切内置 provider 需要显式写入 `mode: builtin` 并重新登录。
