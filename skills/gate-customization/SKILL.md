---
name: gate-customization
description: 在目标仓库 harness.yaml 的 settings.gates 里声明与定制任务完成门：local-command 本地命令见证、manual-attest 人工签字、github-actions CI 见证、none 显式免除，治理字段 mandatorySignoff（双控签注）与 allowOverride（owner 特批），以及 appliesTo（submission/code/artifacts）适用范围与 merged-to 合并门。Use when 为新接入或既有仓库配置完成门、把内置 ci 门改用本地见证、配置人工签注或 break-glass 特批、或排查 gate_mapping_invalid、witness_unavailable、invalid_proof、signoff_missing、gate missing 类收口阻塞。
---

# Gate 定制（settings.gates 完成门）

本技能教你在目标仓库的 `harness.yaml` 里声明任务完成门：挂本地测试、设人工签字卡点、配双控与特批、免除内置门。所有字段与行为以当前源码为准——契约在 `packages/kernel/src/domain/completion-contract.ts`，YAML 读写与校验在 `packages/kernel/src/domain/settings.ts`，逐门判定在 `packages/kernel/src/domain/closeout-readiness.ts`（`judgeGateWitnesses`），适配器执行与人工见证准入在 `packages/daemon/src/repo-cell-witness-adapters.ts`。改配置前先读这几个文件里你要用的部分，不凭记忆写。

## 模型：声明 × 映射 × 冻结

完成门是三层拼起来的，缺一层都不工作：

| 层 | 谁声明 | 在哪里 |
| --- | --- | --- |
| 任务声明 gate id | 任务所用 preset 的 profile `completionGates` | preset 包（内置见 `packages/preset/assets/software-coding/presets/*/preset.json`） |
| 仓库映射 witness | `settings.gates.<gateId>` → 适配器 | 本仓 `harness.yaml` |
| 提交时冻结 | submit 把解析结果连同 adapterOptions 冻进 `completionContract` | 随提交 cut 走，改 YAML 不影响在审 cut |

判定规则（fail-closed）：

- 任务声明了 gate 而 `settings.gates` 没有它的映射 → submit 报 `gate_mapping_invalid`，不是静默跳过。
- 映射到 `none` → 该需求被移除，不铸造虚假 pass。
- 仓库映射了一个没有任何任务声明的 gate id → 合法但惰性，不产生任何要求。
- 未知适配器、未知字段、字段集不精确 → 读设置即报错。

内置 preset 只声明两个 gate id：`ci` 与 `code-doc-reconciliation`。要用自定义 id（如 `lint`、`signoff`、`merged-to.main`），任务侧必须有一个声明了它的 preset：按 [preset-creator](../preset-creator/SKILL.md) 打包（profile 的 `completionGates` 写入自定义 id），`ha preset install --source <包目录>` 安装，`ha task create --preset <id>` 使用。只改 `settings.gates` 不换 preset，自定义 gate 不会被任何任务要求。

两个编译期剔除规则（在任务创建时就生效，先于任何映射）：

- `settings.ci.workflows` 为空数组（或缺整个 `ci:` 段）→ preset 解析把 `ci` 从任务的 completionGateIds 里剔除（`packages/preset/src/preset-runtime.ts` profile.completionGateIds 处）。无 GitHub CI 的仓想让测试在本地见证，用自定义 gate id 配 preset，不要指望 `ci` 映射。
- `workKind: docs` 的任务 → `ci` 与 `code-doc-reconciliation` 都被剔除（`packages/preset/src/preset-bootstrap.ts` withoutCodeDeliveryGates）。

## settings.gates 语法

写在 `harness.yaml` 的 `settings:` 下。缩进敏感：`gates:` 两空格、gate id 四空格、字段六空格；字段行顺序任意；值后可跟注释。

```yaml
settings:
  ci:
    workflows: [rewrite-ci]        # github-actions 适配器共用的 workflow 注册表
  gates:
    ci:                            # 块形式：下面六空格字段
      adapter: github-actions
      appliesTo: code
      branch: main
      event: push
      coverage: descendant
      selection: newest
    lint:                          # 自定义 id（需 preset 声明）
      appliesTo: code
      adapter: local-command
      command: npm ci && npm run lint
    signoff:
      appliesTo: submission
      adapter: manual-attest
    code-doc-reconciliation: none  # none 只能内联，后面不许再跟字段
```

解析规则（`settings.ts` readGateSettings/gateSettingsSchema/gateWitnessMappingIssues）：

- gate id 模式 `^[A-Za-z0-9][A-Za-z0-9/_.@-]*$`：不含空格和冒号。合并门写 `merged-to.main`，不写 `merged-to:main`。
- 行内值只允许 `none`；`ci: github-actions` 这种行内写法直接报 `settings.gates cannot read line`。
- 每个适配器的字段集是**精确**的，多一个少一个都报 `must declare exactly`：

| adapter | 必填字段（恰好这些） | 可选治理字段 |
| --- | --- | --- |
| `github-actions` | `appliesTo` `branch` `event` `coverage` `selection` | `mandatorySignoff` `allowOverride` |
| `local-command` | `appliesTo` `command` | `mandatorySignoff` `allowOverride` |
| `manual-attest` | `appliesTo` | 无（见下） |
| `none` | 无（只能内联） | 无 |

- `mandatorySignoff` / `allowOverride` 是治理修饰字段，不计入上面的精确集：只许写在 `github-actions` 与 `local-command` 上，写在 `manual-attest` 或 `none` 上会报 `cannot declare mandatorySignoff or allowOverride`（人工见证的门不再需要这两个修饰）。值必须是 YAML 布尔 `true`/`false`，其他写法（如 `yes`）被 schema 拒；只有 `true` 会进入冻结契约，写 `false` 等价于不写。

- `github-actions` 的 workflow 清单不写在 gate 映射里，统一来自 `settings.ci.workflows`（内联数组 `[a, b]`，名字不带 `.yml`）；映射了 github-actions 而 workflows 为空 → 解析报错。
- `branch`/`event` 值受 `^[A-Za-z0-9][A-Za-z0-9/_.@-]*$` 限制；`coverage` 只认 `exact`（run 的 head SHA 必须就是提交 SHA）或 `descendant`（run 的 head SHA 以提交 SHA 为祖先）；`selection` 只认 `newest`。
- 同一 gate 内字段重复、六空格字段出现在 gate 行之前、未知行 → `cannot read line`。
- `#` 在任何行内都起注释作用并被剥离——命令值里不能出现 `#`（`command: echo a#b` 会变成 `echo a`）。
- `code-doc-reconciliation` 是 Harness 内部检查器，只能映射 `none`，映射任何适配器都报错。
- `gates` 是 repository-owned 设置；`ha settings update` 的输入字段不含 gates，手工编辑 `harness.yaml` 是正式通道，重写其他设置不会动 gates 段。改完用 `ha settings show` 回读校验。

## appliesTo 选择

枚举就三个（`completion-contract.ts` gateAppliesTo），按提交 cut 的形状生效：

| 值 | 何时适用 | 典型用途 |
| --- | --- | --- |
| `submission` | 每个提交 cut 都适用 | 人工签字、交付物本身的检查 |
| `code` | cut 带交付 commit（`commitSha` 非空） | 测试、lint、构建、CI、合并门 |
| `artifacts` | cut 带至少一个已接受 artifact 锚 | 产物签字、报告审阅 |

判定语义：不适用的 gate 在该 cut 上记 `not_applicable`，不阻塞也不需要证据。混合交付（commit + artifact）同时承载两类 gate。

实践规则：

- `local-command` 需要 commit cut（它要把提交物化成沙箱）；artifact-only 交付上它会报 `witness_unavailable`。纯文档/产物型交付用 `manual-attest`。
- 仓库同时有代码任务和文档任务时，把代码门圈成 `appliesTo: code`，文档任务不会被卡死；交付级卡点（如 owner 签字）用 `submission`。

## 场景：local-command（本地命令见证）

把一条 shell 命令当作 gate 的见证人。执行语义（`repo-cell-witness-adapters.ts` collectLocalCommand）：

- **触发时点**：`task-submit` 与 `task-complete` 的写队列之前自动采集；每次都重新采集，直到该 gate 已有绑定当前 cut 的 accepted pass 见证（或已被 owner 特批为 waived——waived 门不再重采）。上次的 fail 不会被冻结成终局——修好后重跑 `task complete` 会采到新的 pass。
- **沙箱**：daemon 把**精确的提交 commit**用 `git archive` 解到全新临时目录再运行命令。命令看到的是提交时的内容，不是工作树；目录里**没有 `.git`**。临时目录用后即删，两次运行之间不保留任何状态（依赖装了什么都不会留下）。
- **命令形式**：`sh -c "<command> 2>&1"`，stdout 与 stderr 合并。
- **环境变量**：只有 `PATH` 加下面三个，父进程其余环境（HOME、node/npm 配置等）一概不传：

| 变量 | 值 |
| --- | --- |
| `HARNESS_WITNESS_CUT` | 被见证的提交 SHA |
| `HARNESS_WITNESS_GATE` | gate id |
| `HARNESS_WITNESS_REPO` | 源仓库根（含 `.git`），供仓库级观察（如合并祖先检查）使用 |

- **退出码即裁决**：`0` = pass；非零 = fail（complete 时以 `invalid_proof` 阻塞完成；门声明了 `allowOverride` 时 fail 先作为正式回执落库，blocker 改给特批命令）；启动失败、被信号杀死或超过 **10 分钟** = `witness_unavailable`（证据不可得，不是 pass 也不是 fail，任务停在 gate 未满足上）。
- **防陈旧**：观测绑定 `commitSha + submissionDigest`；提交被 amend 或契约变化后，旧观测作废、需要重采。
- **可达性**：提交必须存在于本节点可读的仓库（仓库根或该任务派工的 worktree）。worker 在 worktree 里 commit 而没让 daemon 读得到，会报 `witness_unavailable`。
- **留痕**：provenance 记 `exit N; output sha256:…; tail "…"`（输出摘要 + 最后约 500 字符），不存全量输出。

写命令的守则：

1. 自带依赖安装（沙箱每次都是新的）：`npm ci && npm test`、`python3 -m venv .venv && …`。
2. 不要依赖 HOME 类缓存。实测在最小环境下：Go 必须显式 `export GOCACHE="$PWD/.gocache"`，否则报 `GOCACHE is not defined and $HOME is not defined`；Rust 建议显式 `export CARGO_HOME="$PWD/.cargo-home"`（有依赖时注册表也走它）。
3. 需要读 git 历史的检查（合并门、tag 检查）用 `git -C "$HARNESS_WITNESS_REPO"`，不要指望工作目录里有 `.git`。
4. 超时是 10 分钟：全量安装+全量测试放不进一条命令时，拆成多个 gate 或让命令自建缓存目录。

**合并门示例**（决策 dec_59FA45A407F850E2B167A192D7 的 `merged-to` 形态，用自定义 gate id 配 preset 声明后生效）：

```yaml
  gates:
    merged-to.main:
      appliesTo: code
      adapter: local-command
      command: git -C "$HARNESS_WITNESS_REPO" merge-base --is-ancestor "$HARNESS_WITNESS_CUT" refs/heads/main
```

行为：提交时 main 还没包含该 cut → 采到 fail（不阻塞 submit，verdict 在 complete 时判）；合并进 main 后重跑 `task complete` → pass。

## 场景：manual-attest（人工签字卡点）

适配器本身不采集任何观测：见证由人通过 CLI 写入。

```bash
ha task attest <task-id> --gate <gate-id> --result pass --note "审阅意见"
```

- `--result` 只认 `pass` 或 `fail`；`--note` 可选，会进证据的 rawResult；`--mode` 缺省为 `approve`。
- 前置条件（缺一即拒）：任务当前 iteration 有已提交的 execution；该 gate 在**冻结契约**里；该 gate 声明的适配器就是 `manual-attest`（给声明为 `github-actions` 且无 `mandatorySignoff` 的门 attesting 会以 `invalid_command` 拒绝——人工 pass 不能顶替声明的见证来源）；`appliesTo` 与该 cut 匹配（code 门不能在 artifact-only cut 上签字）。
- 证据 provenance 为 `source: human`，绑定当时的执行身份。带 executor 的 runtime 会话永远不能以人工身份签注（`actor_unauthorized`）——签注只认人类 principal。它不替代 Review/Consent 流程，只是 gate 见证。

适合：无自动化环境的签字卡点、artifact-only 交付的人工审阅、上线前 owner 批准。

## 场景：mandatorySignoff（自动见证 + 强制人工签注，双控）

在 `github-actions` 或 `local-command` 门上加 `mandatorySignoff: true`：

```yaml
  gates:
    ci:
      adapter: github-actions
      appliesTo: code
      branch: main
      event: push
      coverage: descendant
      selection: newest
      mandatorySignoff: true
```

行为（`judgeGateWitnesses`）：自动见证 pass 后门状态是 `signoff_missing` 而不是 `passed`——complete 的 blocker 直接给出签注命令：

```bash
ha task attest <task-id> --gate ci --result pass
```

- 签注走同一个 `task attest` 入口，`--mode` 缺省 `approve`；它要求本 cut 已有**被接受的自动 pass**，否则拒 `invalid_transition`（先跑 `ha task complete` 让见证落库）。approve 不能带 `--rationale`（那是 override 的字段，`invalid_field`），可用 `--note`。
- 任何 human principal 都能签注（不限 owner）；runtime executor 不能。
- 签注与自动见证是两个独立证据槽位（lane）：人签不覆盖机器记录，机器重采也不覆盖人签。
- `manual-attest` 与 `none` 门不能声明此字段。

## 场景：allowOverride（owner break-glass 特批）

在 `github-actions` 或 `local-command` 门上加 `allowOverride: true`，给任务 owner 留一条「记录的失败可以豁免」的紧急通道：

```yaml
  gates:
    e2e:
      adapter: local-command
      appliesTo: code
      command: npm run e2e
      allowOverride: true
```

特批命令（complete 的 blocker 与采集失败时的拒绝信息都会给出它）：

```bash
ha task attest <task-id> --gate e2e --result pass --mode override --rationale "<为什么豁免，trim 后至少 10 字符>"
```

准入与语义（`attestGateWitness` / `judgeGateWitnesses`，逐条与源码核对）：

- 门的冻结契约必须声明了 `allowOverride`——提交后才补到 YAML 不影响在审 cut（`invalid_command`）。
- 只有任务 owner（`createdBy` 对应的 principal）能特批，其他人 `actor_unauthorized`；runtime executor 不能特批。
- 两种豁免形状：**有已记录的自动 fail** → 特批精确绑定该回执（证据里记 `waivedReceiptId: <receipt id>`）；**本 cut 没有任何自动回执**（runner 不可达、采集超时等，从未产生见证）→ `waivedReceiptId` 显式记 `null`，表示「豁免缺席的自动见证」。本 cut 已有自动 pass 或其他见证时 override 拒收 `invalid_transition`——真实通过不需要特批。
- **后续到达的任何机器回执都使旧特批失效**：新 fail → 门回到 `failed`，需对新回执重新特批；新 pass → `passed`（若门同时是 mandatorySignoff 则回 `signoff_missing`，需独立 approve）。已 waived 的门不再重新采集（local-command 不重跑、CI 不重拉），但已记录观测照常重判、新回执照常落库。
- **override 永远不算 signoff**：带 override 的人工见证不参与 mandatorySignoff 判定；但被特批的门整体记 `waived`（满足态，不显示为 passed），不再需要单独签注。
- 特批也绑定 `commitSha + submissionDigest`：cut 被 amend 或契约变化后需重新取证。
- `allowOverride` 门的自动 fail 会先作为正式回执落库（给 owner 留下可豁免的 receipt），再由 complete 的 blocker 给出特批命令；采集本身失败（gh 不可达、命令超时）时拒绝信息同样附 override 提示。

GUI 对应入口：daemon 注册了 `task.attest` GUI action（`repo.task.attest` / bridge 方法 `taskAttest` / `POST /api/tasks/:taskId/attest`），payload 为闭形状 `{ taskId, gateId, result, mode?, note?, rationale? }`——override 的理由必须放 `rationale`（放 `note` 会因缺 rationale 被拒）；renderer 按钮的显隐规则（仅 `failed`/`missing` 且冻结契约 `allowOverride` 的门出现特批，`waived` 展示为特批放行而非通过）由 GUI 侧实现。

## 场景：none（显式免除）

```yaml
  gates:
    ci: none
    code-doc-reconciliation: none
```

`none` 把任务声明的该 gate 需求移除：不运行任何东西、不铸造 pass、完成判定里不再出现。它是显式声明——「没写映射」和「写了 none」是两回事：前者对已声明的 gate 是配置错误，后者是仓库的裁决。`code-doc-reconciliation` 只能用 `none` 移除。

常见组合：内部工具仓不想被代码-文档对账卡住 → `code-doc-reconciliation: none`；无 GitHub CI 的仓 → `ci.workflows: []`（preset 侧会直接不给任务声明 `ci`，无需再写 none）。

## 场景：github-actions（内置 ci 门的默认见证）

`ci` 是唯一内置声明且默认走 GitHub Actions 的 gate。映射写法见上文语法节；要点：

- workflow 名单永远来自 `settings.ci.workflows`，映射里没有 `workflows` 字段。
- `coverage: descendant` 接受以提交 SHA 为祖先的后续 run（提合并 PR 后 CI 在 merge commit 上跑的场景）；`exact` 要求 run 就挂在提交 SHA 上。
- `selection: newest` 是当前唯一选取策略（最高 run/attempt 优先）。
- 本仓（harness-anything 自身）的基线映射就是 `ci → github-actions + rewrite-ci`，可作对照。

## 多语言示例

`examples/` 下是完整可解析的 `harness.yaml`（均通过 `readSettingsFacet` 校验；命令配方在最小环境 PATH-only 下实测）：

| 文件 | 场景 |
| --- | --- |
| `examples/harness-node.yaml` | Node 仓：GitHub CI 见证 `ci` + 本地命令见证 `lint` + 合并门 |
| `examples/harness-python.yaml` | Python 仓：无 GitHub CI，测试全本地命令见证 |
| `examples/harness-go.yaml` | Go 仓：本地 vet+test（显式 GOCACHE） |
| `examples/harness-rust.yaml` | Rust 仓：本地 cargo test --locked（显式 CARGO_HOME） |
| `examples/harness-manual-only.yaml` | 无自动化环境：免除内置门 + 人工签字卡点 |
| `examples/harness-docs-only.yaml` | 纯文档仓：artifact 交付 + 人工审阅签字 |
| `examples/harness-governance.yaml` | 治理字段：CI 双控签注（mandatorySignoff）+ e2e 特批（allowOverride） |

除 Node 示例的 `ci` 外，示例中的自定义 gate id 都需要配套 preset 声明才会被任务要求（见「模型」节）。

## 排错对照

| 症状 | 含义 | 处置 |
| --- | --- | --- |
| `Task declares completion gate X, but harness.yaml settings.gates maps no witness for it` | 任务声明了 gate、仓库没映射 | 补映射或写 `X: none` |
| `settings.gates.X with adapter Y must declare exactly: …` | 字段集不精确 | 按字段表补齐/删多余字段 |
| `settings.gates cannot read line: …` | 缩进错、行内值非 none、字段重复 | 对照语法节修 YAML |
| `Gate X is witnessed by github-actions, but settings.ci.workflows is empty` | workflows 注册表为空 | 填 `settings.ci.workflows` 或换适配器 |
| `witness_unavailable`（local-command） | 提交不可达 / artifact-only cut / 命令超时或启动失败 | 确认 commit 在 daemon 可读的仓库里；artifact 交付改 manual-attest；检查命令是否卡死；`allowOverride` 门下可按提示特批 |
| `Gate X receipt … reported fail`（invalid_proof，complete 时） | 命令非零退出或见证观测为 fail（门未声明 allowOverride） | 修到退出码 0（或合并/attest 后）重跑 `task complete` |
| gate 状态 `signoff_missing` | 自动见证已 pass，mandatorySignoff 门缺人工签注 | `ha task attest <task> --gate <g> --result pass` |
| gate 状态 `waived` | owner 已特批（满足态，不是 passed） | 无需动作；注意新自动回执会使其失效 |
| `invalid_command`（attest） | 门不在冻结契约 / 门未声明 allowOverride / 自动化门未声明 mandatorySignoff 却来 approve | 核对冻结契约（`ha task show`）；改治理字段需重新 submit 才生效 |
| `invalid_transition`（attest） | 无已提交 execution / appliesTo 不匹配 / approve 时无自动 pass / override 时已有自动见证 | 先 submit/complete 让见证落库；真实通过不需要特批 |
| `actor_unauthorized`（attest） | 带 executor 的会话签注 / 非 owner 尝试 override | 由人类 principal 执行；override 必须是任务创建者 |
| `invalid_field`（attest） | override 缺 `--result pass` 或 rationale 不足 10 字符 / approve 误带 `--rationale` | 按命令形态修正 |
| 任务停在 `incomplete`、blocker 是 gate | 该 gate 没有绑定当前 cut 的 pass 见证 | 跑 `ha task show` 看 gate 状态；按适配器补证据 |
| 映射了自定义 gate 却从不生效 | 没有任务声明它 | 给 preset 的 `completionGates` 加该 id |

## 边界与注意

- 契约随提交冻结：改 `harness.yaml` 只影响之后的 submit；在审 cut 按冻结契约判定。cut 被 amend 后 `commitSha + submissionDigest` 变化，旧观测（含人工签注与特批）作废重取。
- 迁移保留的历史结论（preserved verdict：无绑定证据的旧「已接受」）只在生命周期 replay 中被承认，**永远不能充当当前 cut 的门通过**——新 cut 必须重新取证或重新签注。
- 四形态一览：纯自动见证（默认）、`manual-attest` 纯人工、`mandatorySignoff` 自动+签注双控、`allowOverride` 自动失败可特批。两个治理字段可同挂一门（双控+特批）；被特批的门记 `waived` 满足态。
