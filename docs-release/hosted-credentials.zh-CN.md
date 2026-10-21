# 托管 Git 凭据

任务分支推送、创建 pull request 与读取 CI 检查都经 daemon 完成。Daemon 使用
机器操作者按 runtime instance 一次性配置的 GitHub 或 GitLab token；runtime
进程拿不到它。本页是操作者配置说明；面向 worker 的命令见
[任务分支发布与 direct-push 保护](operations-server-daemon.zh-CN.md#任务分支发布与-direct-push-保护)。

## 这份凭据驱动什么

每条命令解析「运行该派工的 runtime instance」上绑定的凭据，且只用于该任务：

| 命令 | 用凭据做什么 |
| --- | --- |
| `ha task push <task-id>` | 经 HTTPS git 推送任务分支（`git push --force-with-lease`）。 |

daemon 的 `PATH` 上必须有 GitHub CLI（`gh`）与 `git`；常驻服务记录的是安装
shell 的 `PATH`（见[常驻服务](operations-server-daemon.zh-CN.md#常驻服务macos-与-linux)）。

## 把凭据绑定到 runtime instance

```bash
ha runtime instance hosting-credential set <instance-id> --provider github --ref credential:v1:<slug>
ha runtime instance hosting-credential unset <instance-id> --provider github
ha runtime instance hosting-credential set <instance-id> --provider gitlab --ref credential:v1:<slug>
ha runtime instance hosting-credential unset <instance-id> --provider gitlab
```

`--ref` 接受指向本机原生凭据库的不透明引用，不接受 token 本身。
`credential:v1:<slug>` 是现行语法；旧式 `keychain:<service>/<account>` 只在
macOS 上继续解析。`ha runtime instance show <instance-id>` 只投影凭据状态——回执
永不回显引用或 secret。worker 会话无权修改这一绑定；它是操作者侧设置，
绑定缺失表现为 `runtime_credential_unavailable`（见
[从 task 与 runtime 拒绝中恢复](operations-server-daemon.zh-CN.md#从-task-与-runtime-拒绝中恢复)）。

## 创建凭据库条目

引用在本机原生凭据库内解析，与 daemon 存 provider API key 用的是同一个库：
service `com.harness-anything.runtime-instance`，account `<slug>`。先用平台
工具创建条目，再按上一节绑定引用。存入前先按下一节确定 token 权限；轮换
token 就是存一个新条目并改绑新引用。

macOS 钥匙串（`-w` 不带值时会提示输入两次，即输入加确认）：

```bash
security add-generic-password -U -s com.harness-anything.runtime-instance -a <slug> -w
```

Linux Secret Service（daemon 本身的无桌面设置见
[Provider API keys](provider-credentials.md#linux-without-a-desktop)）：

```bash
printf '%s' "$github_token" | secret-tool store --label "harness github credential" service com.harness-anything.runtime-instance account <slug>
unset github_token
```

Windows 凭据管理器：创建名为 `com.harness-anything.runtime-instance/<slug>`
的通用凭据，secret 即 token。

## token 需要能做什么

daemon 用这份 token 执行的是一组固定操作。只对工作区要发布的那个仓库授予
恰好覆盖这些操作的权限：

| 操作 | 使用方 | 细粒度 PAT 权限 |
| --- | --- | --- |
| 经 HTTPS 推送任务分支 | `ha task push` | Contents: Read and write |

classic personal access token 用 `repo` scope 覆盖同一组操作。没有推送权限的
token 在 `ha task push` 失败。轮换 token 即存新条目并改绑；daemon 只有在
没有其他 instance 或凭据设置还引用某条目时才会删除它。

## 当前限制

GitHub 与 GitLab 任务发布均受支持。GitHub token 推送需要仓库内容写权限；GitLab
token 推送需要 `write_repository`。daemon 按 provider 解析绑定引用，仅向自身 git/API
操作提供 token。开 PR 与读检查（`gh pr create`、`gh pr checks --watch`、
`gh run view --log-failed`）用本机自己的托管平台 CLI 登录。provider 默认从
`origin` 推断；无法识别或自建 GitLab host 时，在仓库 settings 声明
`hosting.provider` 与 `hosting.host`。GitLab CI 使用 REST API
v4；daemon 管理的发布无需 `glab`（见
[Provider credentials](provider-credentials.md#github-and-gitlab-task-delivery)）。
