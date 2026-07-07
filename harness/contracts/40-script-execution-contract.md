# 40 · 脚本执行契约 (Script Execution Contract)

- **状态**: proposed（ADR-0008 D8 的承重子交付;待泽宇审）
- **日期**: 2026-07-01
- **出处**: `harness/adr/ADR-0008-generic-entity-framework-and-substrate.md` D8;E50（安全边界哲学）;泽宇 2026-07-01 裁决（通用 Executor、`harness script list/run` 门面、回执落 `.harness`）
- **落地归属**: M3 `TP-M3-00d 通用脚本执行宿主`（见 `harness/milestones/foundation/m3-triadic-kernel/01-feature-breakdown.md`）
- **现状雏形**: `packages/cli/src/commands/extensions/preset-script-runner.ts` + `script-scope.ts`（preset 专属，本契约将其去 preset 化 + 正式化 + 写作用域放宽）

---

## 0. 这份契约定义什么

"一条外挂 JS 脚本进沙箱执行、产出受控、错误结构化、不污染内核"的**端到端规范**。它是"非 Kernel 能力不写死在仓库代码里"（ADR-0008 D8）的地基：ADR seeding、骨架物化、自动编号、以及未来任意 vertical/preset/user 级扩展，都是本契约下的**消费者脚本**，内核零专用代码。

**核心原则（不可破）**：
1. **内核只写死"扩展点机制"，不写死"扩展内容"**。ScriptHost 是 Kernel 级；脚本逻辑全在 vertical/preset/user 层。
2. **执行模型 = sandboxed 子进程 Executor，不是 parser/求值器**。脚本是真跑的独立进程，靠 Node `--permission` 沙箱。
3. **脚本不带元数据不让跑**（fail-closed）。元数据有真实消费者（`harness script list`）。
4. **沙箱硬边界不可放宽**：始终关在 `rootDir` 内、始终声明式 scope、始终事后扫越界。放宽的只是"写区从单个 task 包扩到整个 harness 骨架"。

## 1. 三面模型（声明 / 运行 / 脚本，必须分开）

现状把三面耦合在 preset 语义里（context 叫 `preset-context`、result 叫 `preset-result`、错误码带 `Preset` 前缀、scope 锁 task-outputRoot）。本契约去耦，让三面通用。

```
┌──────────────────────────────────────────────────────────────────────┐
│ A. 声明面 (manifest, 由 vertical/preset/user 作者写)                     │
│    scriptEntry {                                                       │
│      id, source(user|vertical|preset), type:"script", command,        │
│      reads[], writes[], inputs{},                                     │
│      metadata { description, purpose, contractVersion, produces[] }   │  ← 必填,否则 invalid
│    }                                                                   │
├──────────────────────────────────────────────────────────────────────┤
│ B. 运行面 (ScriptHost, Kernel 级端口)                                   │
│    ScriptHost.run(scriptEntry, invocation) → ScriptReceipt            │
│    ① 开回执目录 .harness/script-runs/<runId>/                          │
│    ② 写 context.json,经 env 注入                                       │
│    ③ spawn(node --permission --allow-fs-read/write, command)          │
│    ④ 读回执 result.json + 事后扫越界 + append log.jsonl               │
├──────────────────────────────────────────────────────────────────────┤
│ C. 脚本面 (外挂 JS, 契约消费者)                                          │
│    读 env HARNESS_SCRIPT_CONTEXT → 干活 → 写 env HARNESS_SCRIPT_RESULT │
│    结构化退出;只写声明的 writes scope;不假设 host 内部环境             │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. 声明面 —— scriptEntry schema（`script-entry/v1`）

脚本在 manifest（preset manifest 的 `entrypoints`，或 vertical 的新 `scripts[]`，或 user 级 `~/.harness` 脚本注册）里声明。字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 脚本唯一标识（`<source>:<name>`，如 `vertical:adr-seed`、`preset:milestone-closeout`） |
| `source` | ✅ | `user` \| `vertical` \| `preset`（决定 list 分组与信任层级） |
| `type` | ✅ | `"script"`（区别于 `template` 类 entrypoint） |
| `command` | ✅ | 脚本文件路径，**必须在其所属 manifest 包内**（`isPathInside(manifestRoot)`，防路径逃逸，现状 `preset-script-runner.ts:34` 已有） |
| `reads` | ✅ | 声明式读 scope 列表（`{{paths.*}}` 模板 + `/**` 递归 + `*` 展开，复用 `script-scope.ts`） |
| `writes` | ✅ | 声明式写 scope 列表（**放宽到骨架，见 §5**） |
| `inputs` | — | 键值参数，注入 context |
| **`metadata`** | ✅ | 见下，缺失 → `CONTRACT_INVALID` fail-closed |

**`metadata` 子结构（"框死"的核心）**：

| 字段 | 必填 | 消费者 |
|---|---|---|
| `description` | ✅ | 人读；`harness script list` 展示"这脚本干嘛" |
| `purpose` | ✅ | 机器读枚举：`scaffold` \| `generate` \| `transform` \| `audit`；list 分类、host 策略 |
| `contractVersion` | ✅ | 本契约版本（`script-entry/v1`）；向前兼容判据 |
| `produces` | ✅ | 声明会产出的路径模式列表；host 事后校验实际产出未越出（`DECLARED_PRODUCE_MISMATCH`） |

> **为什么 metadata 必填不是官僚主义**：`description`/`purpose` 是 `harness script list` 的**展示内容**，`produces` 是 host **越界校验的依据**。三者都有真实消费者（呼应 ADR-0007 消费透镜：产物必须被消费，否则不该存在）。不带元数据的脚本 = list 里一行看不懂的黑盒 + host 无法校验产出 → fail-closed 拒绝。

## 3. 触发/发现 —— `harness script` 通用门面（泽宇 2026-07-01）

**一个通用门面服务所有脚本，不给每个脚本造顶层动词**（延续 ADR-0008：拒的是 `harness new-adr` 这种专用动词，不是拒通用门面）。

```
harness script list [--source user|vertical|preset] [--purpose scaffold|...]
   → 列出当前可执行脚本:  id · source · description · purpose
     (消费 metadata;这是 metadata 必填的理由)

harness script inspect <id>
   → 单脚本详情: 完整 metadata + reads/writes scope + command 路径

harness script run <id> [--input k=v ...] [--dry-run]
   → 人挑一个执行,走 ScriptHost.run

harness script log [--history] [--id <id>]
   → 翻 .harness/script-runs/log.jsonl 的历史执行记录
```

**发现来源三层**（list 聚合）：
- `user`：`~/.harness` 或项目 user 层注册的脚本。
- `vertical`：当前 vertical 定义里 `scripts[]` / repositoryScaffold 关联的脚本。
- `preset`：已安装 preset 的 `entrypoints[type=script]`（现状 `preset-action` 归入此，成为门面下一个条目，不再是独立命令语义）。

> **闭环**：① `script list` 看有哪些脚本、各自作用 → ② `script run <id>` 人挑 → ③ ScriptHost 沙箱执行 + 回传（§4）。ADR seeding 就是这套下面的一个 `vertical:adr-seed` 条目，不是新动词。

## 4. 运行面 —— ScriptHost + 回传通道

### 4.1 回传通道：为什么脚本是进程不是函数

脚本是 host `spawn` 出的**独立子进程**。host 从子进程只能直接拿到两样：**退出码**（0/1）+ **stdout/stderr 文本**。二者都不足以结构化回答"产出了哪些文件、处理了几行、失败错误码是什么"。所以脚本把结构化结果**写成一个 JSON 文件**，host 跑完读它——这个"脚本写、host 读"的文件就是**回传通道**（现状 `preset-result.json` 的正式化）。

### 4.2 回执落点：`.harness/script-runs/`（localRoot，gitignore 内）

回执**不放脚本的产物工作区**，放 host 管理的独立目录。理由：写作用域放宽到骨架后，脚本没有单一"工作房间"（可能同时写 `adr/` 和别处），回执跟着产物走会污染产物目录、且让 scope 校验分不清"产物"与"回执"。故 host 开专用回执目录，**不计入脚本声明的 writes**。

落点 = `.harness/`（layout `localRoot`，实证 gitignore 内、已装 cache/generated/locks/write-journal 等 host 本地状态，语义一致）：

```
.harness/script-runs/
├── <runId>/                    ← 每次 run 一份(per-run receipt)
│   ├── context.json            ← host 写,脚本读(输入)
│   ├── result.json             ← 脚本写,host 读(回传通道核心)
│   ├── stdout.txt              ← host 留档
│   └── stderr.txt              ← host 留档
└── log.jsonl                   ← 全局 append 执行日志(可选,harness script log 消费)
```

> **两层，别混**：① per-run 回执（`<runId>/result.json`，**必需**，host 靠它拿结构化结果）；② 全局 append 日志（`log.jsonl`，审计增值，每次 run 追加一行 `{runId, id, source, startedAt, ok, error}`）。回执是"事件历史"（有审计价值、删了就没），与 `cache/`（可整删重建的状态快照）语义不同，故独立子目录。

### 4.3 context 注入（输入，`script-context/v1`）

host 写 `<runId>/context.json`，经 env `HARNESS_SCRIPT_CONTEXT`（路径）+ `HARNESS_SCRIPT_RESULT`（回执 result.json 目标路径）注入。结构（现状 `preset-context/v1` 去 preset 化）：

```json
{
  "schema": "script-context/v1",
  "scriptId": "vertical:adr-seed",
  "source": "vertical",
  "runId": "<runId>",
  "paths": { "rootDir": "...", "authoredRoot": "...", "tasksRoot": "...",
             "generatedRoot": "...", "localRoot": "..." },
  "inputs": { "...": "..." },
  "readScopes": ["..."], "writeScopes": ["..."],
  "resultPath": ".harness/script-runs/<runId>/result.json"
}
```

### 4.4 result（输出，`script-result/v1`）

脚本写 `HARNESS_SCRIPT_RESULT` 指向的文件：

```json
{
  "schema": "script-result/v1",
  "ok": true,
  "report": { "...": "..." },     // 人读产物摘要
  "warnings": ["..."],
  "rows": 12,                      // 机器读规模(可选)
  "produced": ["harness/.harness/adr/ADR-0009-x.md"],  // 仅供展示,host 不信它做安全校验(见下🔴)
  "error": null                   // 失败时 { code, hint, detail? }
}
```

> 🔴 **`produced` 不是安全边界（红队 C2/C5）**：脚本自写此文件、可少报（漏列它偷写的文件）。**host 的越界/`DECLARED_PRODUCE_MISMATCH` 校验一律基于 host 对 writeScope 做的 before/after 文件系统快照，禁止取自 `result.json.produced`**（后者仅展示用）。且 `metadata.produces` 由作者自声明、真正强制边界是 writeScope（Node permission），produces 仅作"写进 scope 但超出 produces 声明"的**防意外 lint**，不当安全边界。`metadata.produces` 与 writeScope **均不得包含 coordinator 实体 root**（否则等于把 §5 的旁路声明成"合规产出"给它盖章）。

### 4.5 错误码枚举（`ScriptErrorCode`，封闭）

host 侧错误与脚本自报错误分离，全部封闭枚举（现状散在 `CliErrorCode` 的 `Preset*` 去 preset 化 + 补充）：

| code | 触发 | 责任方 |
|---|---|---|
| `CONTRACT_INVALID` | scriptEntry 缺 metadata / 字段非法 | 声明面 |
| `SCRIPT_NOT_FOUND` | command 不在 manifest 包内或不存在 | 声明面 |
| `SCOPE_INVALID_READ` / `SCOPE_INVALID_WRITE` | 声明的 scope 解析失败或越出 rootDir | 声明面 |
| `SCOPE_VIOLATION_READ` / `SCOPE_VIOLATION_WRITE` | 运行时越界读/写（Node `--permission` 拦截） | 脚本面 |
| `DECLARED_PRODUCE_MISMATCH` | 实际产出超出 `metadata.produces` 声明 | 脚本面 |
| `SCRIPT_FAILED` | 脚本非零退出 | 脚本面 |
| `RESULT_INVALID` | result.json 缺失/非法 JSON/schema 不符 | 脚本面 |
| `RESULT_FAILED` | 脚本自报 `ok:false` | 脚本面（业务失败） |

## 5. 写作用域放宽（骨架非承重子树，硬性排除 coordinator 实体 root）

现状 `script-scope.ts` 两处约束：`:59` scope 必须在 `rootDir` 内、`:62` write 必须覆盖单个 task `outputRoot`。本契约的改法：

| 维度 | 现状（preset 专属） | 本契约（通用） |
|---|---|---|
| 读 scope | task outputRoot + 声明 reads（`{{paths.*}}`） | 不变 |
| **写 scope** | **必须覆盖单个 task outputRoot** | **放宽到 `authoredRoot` 下非承重骨架子树**（如 `adr/`、`context/` 说明目录），**但硬性减去 coordinator 拥有的实体 root**（见下 🔴） |
| rootDir 边界 | 必须在 rootDir 内 | **不变（硬边界）** |
| **coordinator 实体 root** | （task 包由 coordinator 管） | 🔴 **`tasksRoot`、未来 `decisionsRoot`/`sessionsRoot` 从 grant 中减去，脚本不可直写**（与 `.git/`、`.harness/` 同级保留） |
| 回执目录 | 混在 task outputRoot/artifacts | **独立 `.harness/script-runs/<runId>/`，不计入 writes** |
| 事后扫越界 | 只 `listGeneratedFiles(outputRoot)` | 🔴 **扫全部声明的 writeScope**（非仅 outputRoot），且校验基于 host 文件系统 before/after 快照 |
| 通配/realpath | `/**` 递归、`*` 展开、realpath | 不变 |

**🔴 为什么必须排除 coordinator 实体 root（红队 C1 Critical）**：`authoredRoot = harness/`，`decisions/`、`tasksRoot` 全在其下；WriteCoordinator 是**纯进程内约定**（raw `fs.writeFileSync` 不被 OS 拦，watermark 检查是**非阻断** lint）。若不排除，脚本声明 `writes:[".../decisions/**"]` → host `--allow-fs-write=harness/decisions/**` → raw 写 `decision.md` → **旁路 coordinator/watermark/preflight，0 provenance 进 git，ghost decision 静默进图**。所以：**承重实体（decision/task）的落盘只能经 WriteCoordinator 代写盖水印**（脚本产内容 → host 经 coordinator 落），脚本 grant 里没有这些 root。"coordinator root 不可脚本直写"是硬约束，非 defer。coordinator 拥有的 root 清单由 EntityKind 注册表（TP-00c）提供，不另造排除表。

**"放宽"≠"放开"**：脚本仍(a)关在 `rootDir` 内、(b)**不可写 coordinator 实体 root**、(c)必须声明写哪些子树（声明式、可审计）、(d)事后按 host 文件快照扫全部 writeScope 越界。放宽的只是"能写 adr/context 等非承重说明目录"。ADR 脚本因此能写 `adr/`，但写不了 `decisions/`、`tasks/`、`.git/`、`.harness/` 或 rootDir 之外。 且 **`writes` 声明只能命名 authoredRoot 下的授权内容子树:`{{paths.localRoot}}`/`.harness`(write-journal/watermark/projections.sqlite 所在)、`{{paths.generatedRoot}}`/`{{paths.cacheRoot}}` 等派生态模板一律非法写作用域(deny-by-default 白名单,不是"放宽再减")——否则脚本改 `writes.jsonl`/抬 watermark/毁 projection 即静默篡改 coordinator 持久态,比 ghost decision 更狠**。⚠️ 现 `script-scope.ts:49` 仍允许 `{{paths.localRoot}}` 作写模板、写作用域零排除——待修**实现洞**,归 R3 实现门(M3 落地时 script-scope 须 deny-by-default,只放行 authored 内容子树)。

## 6. 安全边界（承接 ADR-0008 D8 / E50，泽宇要求标注）

- **现在（本地单人 dogfood）**：写面放宽到骨架非承重子树可接受——脚本作者 = 使用者自己（user/vertical/preset 都是本地自写），非不可信第三方。按 E50 哲学，机械防御**主要防意外**（scope 声明防手误写错地方）。
- **沙箱强度（实测，勿低估——红队 C3 纠偏）**：Node `--permission` 下 `--allow-net`/`--allow-child-process`/`--allow-worker` **默认全拒**（Node 25.8 实测）——脚本**不能**开网络、不能 spawn 孙进程、不能起 worker。所以早前"脚本本可调任意 Node API、防作弊是幻觉"这句**是事实错误，删除**：沙箱恰恰拦住了这些逃逸面。硬边界：`rootDir` 关押 + realpath 防符号链接 + fs 权限强制 + net/child_process/worker 默认拒 + **coordinator 实体 root 不可写** + **localRoot/派生态(write-journal/watermark/projection)不可写**。
- **env 白名单（红队 C3 必修）**：host **不透传 `process.env`**（现状 `preset-script-runner.ts:108` 的 `{...process.env}` 会把 `ANTHROPIC_API_KEY` 等给子进程；虽然 net 被拒直接外传挡住，但密钥可被脚本洗进 writeScope 文件 → 提交 → 经仓库外泄）。只注入白名单：`HARNESS_SCRIPT_CONTEXT` / `HARNESS_SCRIPT_RESULT` + 声明的 `inputs`。
- **defer 到 COM 信任边界线**（第三方 preset 分发时）：(a) manifest 签名；(b) 写 scope 白名单进一步收紧（连 adr/ 等也逐项 grant）；(c) `run` 陌生 `source:preset` 脚本前展示解析后的 reads/writes + "本脚本可见的 env" 并要求确认。ADR-0008 C 段已备案此 defer，触发条件 = 出现不可信第三方脚本分发。多人协作(E52)下"可信队友经 git 分发、本地未审查的脚本"是灰色地带:沙箱仍有效,审查责任归脚本运行者;未达 COM 触发阈值。

## 7. M3 交付 vs defer

**M3（TP-M3-00d）做**：
- ScriptHost 从 preset 抽离为 Kernel 级端口（`ScriptHost.run`）。
- scriptEntry `script-entry/v1` schema + metadata 必填 fail-closed。
- 回传通道：`.harness/script-runs/<runId>/`（per-run 回执）+ context/result schema。
- `harness script list/inspect/run` 门面（`script log` 可 M3 内或紧随）。
- 写作用域放宽到骨架 + `produces` 校验。
- 现有 `preset-action`/`preset-run` 迁移为门面下的条目（不破坏现有 preset 脚本）。

**defer**：
- 全局 `log.jsonl` append 审计（②层）可 M3 后补，不阻塞核心回传通道（①层）。
- 第三方脚本签名/白名单/确认 → COM 信任边界线（§6）。
- vertical `scripts[]` 声明位与 user 级脚本注册的完整 schema → 由 **TP-M3-00c** 承接落地（vertical-definition/v2 加 `scripts[]`，承本契约 §2 scriptEntry；preset 脚本走既有 `entrypoints[type=script]`）。本契约定通用 run 面 + scriptEntry 形态，TP-00c 定它在 vertical.json 里的具体挂载位。

## 8. 关联

- ADR-0008 D8（通用 Executor 地基）、C 段（第三方 scope 收紧 defer）。
- E50 / [[mechanical-defense-only-for-accidents]]（防意外不防故意）。
- `37-write-coordination-contract.md`、`39-daemon-api-service-contract.md`（同属运行时契约族）。
- ADR-0007（操作型文档 skill 化）：skill 是"薄触发器 over CLI"，本契约的脚本是"薄触发器 over ScriptHost"，同源——skill/脚本都不自己写承重 markdown，都经受控通道。
- 现状实现 `preset-script-runner.ts` / `script-scope.ts`（本契约的去 preset 化 + 正式化目标）。
