# 托管 Git 凭据

任务分支推送、创建 pull request 与读取 CI 都经 daemon 完成，不用 worker
本人的 GitHub 登录。它们使用的凭据是由机器操作者按 runtime instance
一次性配置的 GitHub token。本页是操作者配置说明；面向 worker 的命令见
[任务分支发布与 direct-push 保护](operations-server-daemon.zh-CN.md#任务分支发布与-direct-push-保护)。

## 这份凭据驱动什么

每条命令解析「运行该派工的 runtime instance」上绑定的凭据，且只用于该任务：

| 命令 | 用凭据做什么 |
| --- | --- |
| `ha task push <task-id>` | 经 HTTPS git 推送任务分支（`git push --force-with-lease`）。 |
| `ha task pr <task-id>` | 先跑仓库的 PR body 门，再经 GitHub CLI 创建或更新 pull request。 |
| `ha task ci <task-id>` | 经 GitHub CLI 读取任务分支的 checks、workflow runs、失败日志与 pull request 状态。 |

daemon 的 `PATH` 上必须有 GitHub CLI（`gh`）与 `git`；常驻服务记录的是安装
shell 的 `PATH`（见[常驻服务](operations-server-daemon.zh-CN.md#常驻服务macos-与-linux)）。

## 把凭据绑定到 runtime instance

```bash
ha runtime instance github-credential set <instance-id> --ref credential:v1:<slug>
ha runtime instance github-credential unset <instance-id>
ha runtime instance show <instance-id>
```

`--ref` 接受指向本机原生凭据库的不透明引用，不接受 token 本身。
`credential:v1:<slug>` 是现行语法；旧式 `keychain:<service>/<account>` 只在
macOS 上继续解析。`show` 只投影 `githubCredentialState: configured`——回执
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
| 创建或更新 pull request | `ha task pr` | Pull requests: Read and write |
| 读 check runs | `ha task ci` | Checks: Read |
| 读 workflow runs、jobs、失败日志 | `ha task ci` | Actions: Read |
| 读仓库、分支、pull request 元数据 | `ha task ci` | Metadata: Read |

classic personal access token 用 `repo` scope 覆盖同一组操作。没有推送权限的
token 在 `ha task push` 失败；缺 pull request 或 CI 读权限的 token 在
`ha task pr` / `ha task ci` 失败。轮换 token 即存新条目并改绑；daemon 只有在
没有其他 instance 或凭据设置还引用某条目时才会删除它。

## 当前限制

目前这些命令只面向 GitHub。任务绑定环境使用的 askpass 助手只应答
`github.com` 的凭据提示，`github-credential` 命令也没有 GitLab 对应物。
GitLab 支持落地后，其 token 类型与最小权限将在本页补充。
