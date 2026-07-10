# 归属（Actor Attribution）

每一次承重写入都会带上 actor，以及提供这份身份的通道。它不是方便检索的标签，而是
审计数据：写 journal 会持久化 `actor.kind`、`actor.id` 与 `actor.source`。

## Actor kind 与 source

系统有三种 actor kind，也有三种 source。kind 回答“是谁”，source 回答“进程是从哪里
拿到这份身份的”。

| Actor kind    | `HARNESS_ACTOR` 环境变量 | 全局 `--actor` flag | 已认证 daemon                                                             |
| ------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------- |
| `human:<id>`  | 拒绝                     | 可以                | 可以，前提是 daemon 认证解析到这个人                                      |
| `agent:<id>`  | 可以                     | 可以                | 不会成为 daemon journal actor；命令支持时，agent 可作为 executor 另行记录 |
| `system:<id>` | 可以                     | 可以                | 不会成为 daemon journal actor                                             |

本地 CLI 会先解析显式 flag，才会读取 `HARNESS_ACTOR`。因此即使父进程提供了环境变量，
明确写出的 flag 仍然优先。除 actor 归属外，本地写入还需要 git author 的姓名与邮箱。示例
和自动化应设置 `HARNESS_GIT_AUTHOR_NAME`、`HARNESS_GIT_AUTHOR_EMAIL`；CLI 也接受对应的
Git author 环境变量作为 fallback。

### 人类发起的命令

人类写入请使用全局 flag：

```bash
ha --actor human:alice task create --title "Review the release notes"
```

**不要** `export HARNESS_ACTOR=human:alice`。环境变量会被子进程继承，所以 child agent
可能带着父 shell 的 human 值写入。这个值只能证明“它被继承了”，不能证明“这次写入有人
在场”。CLI 因此会对 `HARNESS_ACTOR` 里的 human 值 fail-closed。

agent 与 system 的自动化仍可使用一次命令的环境变量：

```bash
HARNESS_ACTOR=agent:release-bot ha task list
HARNESS_ACTOR=system:nightly ha fact record --task task_01ABC --statement "Nightly check passed" --source ci --confidence high
```

### 安全的交互 shell 包装

每次交互命令都手写 flag 很繁琐，但一个天真的 shell function 并不安全。agent source 的
shell snapshot 能看见交互 shell 中的 `ha()` function；若该 function 总是追加 human flag，
agent 在非交互环境运行裸 `ha` 时就会静默继承人类身份。

请改用带交互门的包装（以下为 zsh）：

```zsh
ha() { if [[ -o interactive ]]; then command ha --actor human:<你的id> "$@"; else command ha "$@"; fi }
```

把 `<你的id>` 替换为稳定的 person id。它只会在人的交互 shell 中添加 flag；非交互进程
会原样调用真实二进制，所以 agent 必须自行提供 `HARNESS_ACTOR=agent:<id>` 或显式
`--actor`。不要把 human 身份变成可 export 的环境变量。

### Daemon 归属

通过 daemon 的写入使用 `source: daemon`，不是客户端提供的 human 环境变量。daemon 会
认证一个人，在 `harness/people.yaml` 中解析该人，并以解析出的 display name 和 primary
email 作为 commit author。认证后的 daemon actor 总是 human journal actor；命令携带的
agent executor（若支持）与 daemon principal 是两回事。

远程 SSH 接入见[服务器 Daemon 运维](operations-server-daemon.zh-CN.md)。

## 检查历史 journal 记录

`ha check` 会把 `human_actor_from_inherited_env` 当作 hard failure。它表示 journal 中有一条
历史记录：actor 的 `kind` 是 `human`，而 `source` 是 `env`。请保留这条记录作为审计
证据，不要为了让检查安静而改写历史。后续人类命令改为 `--actor human:<id>`（或使用上面的
交互包装）；之后的写入使用合规 source 后，再运行 `ha check`。
