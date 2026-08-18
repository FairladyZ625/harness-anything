# PLT-Center Docker 全栈测试台

为 PLT-Center M1-E/M2 验证搭的可一键起停的 Docker 台子：一个中心权威 daemon + 多个
edge 节点 + 一个 harness 化测试项目 + 腾讯 GitLab 中心仓对接。W3-B 起本台同时承载
**写回冒烟**：edge 的 `ha task create|start|progress append|submit|release` 经 fleet TLS
自动获取/排队 task lease（`smoke-write.sh`，五场景全真容器）。

拓扑（对照 `harness/tasks/task_856697c1a1b98d751bbe09034f-plt-center` design-v2 的 M1-E/M2 节）：

```text
                 ┌────────────────────────────┐
                 │ GitLab 43.142.81.196:8929  │   canonical ledger（harness/ 授权台账，
                 │ root/plt-center-testbed    │   refs/heads/main + refs/ha/canonical）
                 └──────┬─────────────▲───────┘
             clone (拉) │             │ push (推, seed bootstrap)
                        │             │
 ┌──────────────────┐   │   ┌─────────┴──────────────────────────────┐
 │ seed (一次性)     │───┘   │ center 容器                             │
 │ ha init 测试项目  │──────▶│ ha daemon serve（本容器 socket 命名空间）│
 │ task/decision/   │       │ repo register + 冷投影重建               │
 │ fact/progress 写入│      │ ha daemon fleet center start (TLS :7443) │
 └──────────────────┘       └───────────────┬─────────────────────────┘
                                            │ fleet TLS（snapshot/delta + ACK）
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                     ┌────────────────┐          ┌────────────────┐
                     │ edge-1 容器     │          │ edge-2 容器     │
                     │ ha daemon serve │          │ ha daemon serve │
                     │ fleet edge sync │          │ fleet edge sync │
                     │ → /data/view    │          │ → /data/view    │
                     │ 只读 replica 视图│          │ 只读 replica 视图│
                     └────────────────┘          └────────────────┘
```

角色说明：

| 容器 | 角色 | 关键内容 |
| --- | --- | --- |
| `seed`（跑完即退） | 测试项目工厂 | `ha init` 全新 harness 化小项目；写入真实 task、execution、decision、fact、progress；经 GitLab API 建仓并推 canonical ledger；生成 fleet TLS 证书 + roster（edge 节点凭证与 assignment，每个 edge 独立 principal）写入共享卷；bump 台子 generation 供 center 区分冷/热启动 |
| `center` | 中心权威 daemon | 冷启动从 GitLab clone canonical ledger → `daemon repo register` → 冷投影重建 → `daemon fleet center start`（bind 0.0.0.0:7443，`--state-root /data/fleet-state` 持久 lease/队列态）；同 generation 重启走**热路径**（不 wipe、不重 clone），lease 表幸存。ready 后落 `/data/center-ready` 标记翻转 healthcheck |
| `edge-1` / `edge-2` | collaborator 节点 | 各自容器内 daemon（socket 命名空间互相隔离）；`daemon fleet edge sync` 拉取中心投影到 `/data/view`；入口 `/data/workspace/fleet-edge.json` 把该 root 标记为 remote-edge 镜像（凭证不复制，运行时从共享 roster 解析），`ha task ...` 写命令自动改道 center |

语义对齐：center/edge 是同一个 daemon 二进制对不同 repo 的 **mode**，不是不同程序；
本台已覆盖 M2-B 的自动 task lease（获取/排队/孤儿回收/重启幸存）；A/B 两类同步与其余
M2 语义仍在后续任务里叠上。

## 一键命令

```bash
export GITLAB_TOKEN=$(cat ~/.harness-secrets-center-testbed-token)

cd tools/center-testbed
docker compose build            # 首次构建（npm ci + CLI build，几分钟）
docker compose up -d --wait     # seed 跑完 → center healthy → edges 起来
bash smoke-read.sh              # 读链路冒烟（edge 拉取 + GitLab 可见性 + 日志）
bash smoke-write.sh             # 写链路冒烟（自动 lease 五场景，见下）
```

`docker compose down` 停止；`docker compose down -v` 连卷一起清（彻底重置，含 lease 态）。

读冒烟通过标准：

1. 两个 edge 各自打印 `SMOKE PASS: edge-N reads the center ledger projection through fleet TLS`；
2. edge 视图里能读到 seed 写入的 task/decision/fact 文档内容（逐字断言）；
3. 第二次 sync 返回 `fleet.replica.current/v1`（幂等，无传输）；
4. GitLab 上 `root/plt-center-testbed` 可见，`main` HEAD 与 seed 推送的 canonical 一致。

写冒烟（`smoke-write.sh`）通过标准——全部真容器、无 mock：

1. edge-1 在 remote-edge 仓跑 `task create → start → progress append → submit` 最小闭环，
   无任何显式 lease 命令；center 台账推进，效果自动拉回 edge-1 镜像，edge-2 sync 后视图
   逐字可见该 progress 条目；
2. edge-1 持有期间 edge-2 同 task 的 `task start` 在 center FIFO 排队挂起；edge-1 release
   后 edge-2 **自动**获得 lease 并能继续写入；
3. 显式 `--ttl-ms` 调短持有期，center reaper 回收孤儿 lease（写 `lease_released` 审计事件、
   不自动 complete、不回滚），edge-2 可认领；
4. `docker compose restart center`（热路径）后 `/data/fleet-state/leases.json` 的授予行、
   域内 lease、原持有者写权、等待队列全部幸存，release 仍唤醒队首。
5. edge-1/edge-2 对同一未持有 task 并发 `task start`，恰一方立即授予、另一方只出现一条
   FIFO 等待行；赢家 release 后输家自动获得 lease。

## 凭证与安全边界

- `GITLAB_TOKEN` 只经环境变量注入 seed/center 两个服务；不进镜像层、不进 compose 文件、不进任何被 git 跟踪的文件。git 推拉用一次性 credential helper（`git -c credential.helper=...`），token 不落任何 `.git/config`。
- fleet TLS 证书/私钥与 edge 机器凭证由 seed bootstrap 在运行时生成，落在 `testbed-shared` 卷里，同样不进 git。
- 每个容器的 daemon socket 在容器自己的 tmp 命名空间（`/tmp/harness-anything/…`），与宿主机生产 daemon、本仓 `.harness/` 完全隔离；宿主机不跑任何测试用 daemon。
- seed 复用 GitLab 上同名测试项目（不存在则经 API 创建；若路径被删除计划中的 tombstone 占用则先 restore 回收路径），复跑时对 `main` 与 `refs/ha/canonical` 做 force-push 覆盖；不要把真实项目放在 `root/plt-center-testbed` 路径下。

## 如何把新构建的 dist 滚进容器重测

完整重建（干净、可复现）：

```bash
npm run build -w @harness-anything/cli     # 或改完源码直接重建镜像（COPY 的是源码，镜像内自会 build）
cd tools/center-testbed
docker compose build center edge-1 edge-2
docker compose up -d --force-recreate --wait
bash smoke-read.sh
```

快速热替换（不动镜像，仅验证 dist 改动）：

```bash
npm run build -w @harness-anything/cli
docker compose cp ../../packages/cli/dist center:/opt/harness-anything/packages/cli/dist
docker compose cp ../../packages/cli/dist edge-1:/opt/harness-anything/packages/cli/dist
docker compose cp ../../packages/cli/dist edge-2:/opt/harness-anything/packages/cli/dist
docker compose up -d --force-recreate --wait
bash smoke-read.sh
```

注意：center/edge 每次启动都清掉自己的 daemon-user 与工作区（确定性冷启动），所以
restart 即等价于换 dist 后的全新一轮；edge 的 `/data/view` 跨 restart 保留，用于观察
delta/current 路径。

## 手动探针（可选）

edge 侧直接用产品写入口（与冒烟同一通道，便于手工复现）：

```bash
docker compose exec edge-1 ha --json --root /data/workspace task create --title "probe" --preset standard-task
docker compose exec edge-1 ha --json --root /data/workspace task start <task-id>
docker compose exec edge-1 ha --json --root /data/workspace task progress append <task-id> --text "probe"
docker compose exec edge-2 ha --json daemon fleet edge sync --host center --port 7443 --ca /data/shared/fleet/fleet.crt --node-id edge-2 --credential edge-2-machine-secret --assignment assignment-edge-2 --view-root /data/view --quota-bytes 268435456
```

（task-id 等参数见共享卷里的 `/data/shared/testbed-state.json`；center 的 lease/队列态在
`/data/fleet-state/leases.json`。）

## 文件

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` / `Dockerfile.dockerignore` | 基础镜像（node:24-bookworm-slim + 本仓源码 npm ci + CLI build，复用 coldstart 镜像配方） |
| `docker-compose.yml` | seed → center(healthcheck) → edge-1/edge-2 拓扑与卷/网络；center 带 `HARNESS_LEASE_REAP_INTERVAL_MS=2000` |
| `bootstrap.mjs` | seed 入口：建项目、写台账、建/推 GitLab、铸 TLS+roster（每 edge 独立 principal）、bump generation |
| `entrypoint-center.mjs` | center 入口：冷启动 clone/register/重建；同 generation 重启走热路径；fleet center start（`--state-root /data/fleet-state`） |
| `entrypoint-edge.mjs` | edge 入口：常驻 daemon + 隔离管理壳注册为 remote-edge + 写 `/data/workspace/fleet-edge.json` |
| `smoke-edge.mjs` / `smoke-read.sh` | 容器内单边读冒烟 / 宿主机一键读冒烟 |
| `smoke-write.sh` | 宿主机一键写冒烟（自动 lease 五场景） |
| `lib/testbed.mjs` | 容器内共享 helper（ha 调用、receipt 解包、daemon 生命周期） |

## 已知边界

- 读链路（edge pull）、写链路（edge → center 自动 lease → ledger）已验收；center 写后向
  GitLab 的 canonical 自动推送仍未接（手动探针那类 push 仍需手工），M2-F 的聚合推送是后续面。
- center 冷启动（首次或 reseed 后）会做投影重建（分钟级属正常）；healthcheck 预算 10 分钟；
  同 generation 重启走热路径，秒级。
- GitLab 侧只做建仓/删仓/推拉，不做任何服务器级配置变更。
