---
name: harness-install
description: 将已经可用的 Harness Anything 接入一个尚无台账的目标仓库：检查项目、确认身份、初始化、合并 Agent 入口、建立主控知识位置，并用一个真实任务验证完整流程。缺少源码或 CLI 时先使用 harness-download 完成工具准备，再返回本流程；不重复维护下载步骤。
---

# Harness 仓库初始化

本技能负责把 Harness 接入具体项目。机器环境、持久源码与用户级技能链接由 [harness-download](../harness-download/SKILL.md) 负责；本技能从可用 CLI 开始。完整引导过程中由同一个 Agent 连续执行，不要求用户在阶段之间重新发指令。

## 入口与版本

使用本次安装所选源码中的完整技能包，不混用不同版本的技能与 CLI。正式源码分发来自 `main`，可用 `git show origin/main:skills/harness-install/SKILL.md` 核对发布分支；明确验证候选分支时使用该候选包并记录版本。

读取项目之前不写入。检查已有 `harness/`、`.harness/`、配置及 CLI 可读状态：

- 已有当前可用台账：复用工作区，转入主控初始化和用户任务，不重新 `init`。
- 明确为旧代台账且用户要迁移：转 [harness-migration](../harness-migration/SKILL.md)，保留它的数据处置审批。
- `harness/` 是无关业务目录，或无法判断已有内容：展示真实冲突，先澄清，不覆盖。
- 没有台账：继续。

## 0. 先读项目

读取项目布局、Git 状态和历史、现有 `AGENTS.md` / `CLAUDE.md`、忽略规则、CI、构建和测试入口。能从磁盘得到的答案不问用户。

| 观察 | 对下一步的影响 |
| --- | --- |
| 当前初始化方式要求 Git，但项目无仓库或提交 | 在用户授权的目标内先建立必要基础，不操作其他目录 |
| 已有 Agent 指令 | 预备合并草案，保留原指令并取得具体合并批准 |
| 已有忽略规则 | 初始化后回读差异，确认私有台账不会进入公开项目 |
| 有 CI | 记录真实验证入口，首任务按实际结果收口 |
| 没有 CI | 不把完成参数当成真实运行证据；按任务类型取得可验证结果，明确未运行 CI |
| 多人协作 | 提前说明 owner 与评审身份的实际绑定，不能把环境变量当作另一个人 |
| 用户已给首任务 | 直接复用，不再造一个名为“安装测试”的占位任务 |

只合并询问尚缺少的项目标识、首次任务等信息。owner 身份与指令文件合并仍按下文保留具体审批。

## 1. 取得当前 CLI 入口

复用 `harness-download` 传来的绝对源码入口和 Node 路径。工具未准备好时读取同一技能包里的下载技能，完成其环境、源码、链接阶段后返回；不在这里再复制 clone 或 npm 安装配方。

下面用 `ha` 表示本次已核实的 CLI。若使用源码，后续调用均展开为 `node "<源码目录>/packages/cli/src/index.ts" ...`；临时 shell 函数不会跨工具调用自动保留，不把“node 加参数”装进一个字符串再当命令执行。

检查目标是否已有中心注册和在飞初始化，使用正常的服务根。不要通过 `HARNESS_DAEMON_USER_ROOT` 为正式安装切换到测试根；若发现现有环境指向隔离根，先核实用途，明确选择正式入口，不能静默把用户已有配置清掉。

## 2. 确认初始 owner

读取当前 `ha init --help`。向用户展示将写入的人员标识、显示名和当前传输身份绑定，再取得明确答复。已对同一内容确认过就复用，不能从 `git config user.name` 猜出 owner 并直接写入。

例如本地 Unix socket 传输可能使用以下绑定；实际字段由当前初始化能力提供：

```json
{
  "personId": "<用户确认的标识>",
  "displayName": "<用户确认的显示名>",
  "roles": ["owner"],
  "credentials": [{ "kind": "unix-socket-owner-boundary", "issuer": "host:<主机>", "subject": "<uid>" }]
}
```

说明一个系统账号与一个人类身份的对应边界；改环境变量不会变成另一位用户。后续人员变更走 `ha people` 的现有写入入口，不手改 `people.yaml`，也不用通用文档同步绕过人员注册契约。

## 3. 初始化并回读

命令形状以当前帮助为准，在明确的目标仓库执行：

```bash
ha --root "<目标仓库绝对路径>" init --repo-id <项目标识> --person-id <人员标识> --display-name "<显示名>"
```

初次本地安装若要求 Git 基础，先核实是否已有仓库与提交，只补真正缺失的部分，不重置原历史。多个边缘节点不能各自初始化同一个逻辑工作区；由当前有权协调者完成中心写入，其他节点接入已有记录。

回读而不是只看成功回执：

- `preserved` / `drifted` 中有原 Agent 文件时，确认新入口是否尚未进入，继续下一节。
- 用 `git check-ignore -v harness .harness` 和 `git ls-files harness .harness` 核对私有目录边界，检查实际忽略差异。`git check-ignore -q` 一次只传一个路径。
- 用当前 JSON 状态入口核对工作区是否已注册、已附着，不机械重做回执里的下一步。
- 台账自动提交与目标项目提交是两件事。列出项目中新建或修改的指令、忽略文件；是否提交项目变更按用户范围处理。
- 台账分支可能与项目分支不同；不为了名字统一重命名正在服务的分支。

失败时先识别哪些写入已完成、是否有当前持有者及可用恢复路径。不能自动删台账、清锁或重启服务重来。必要的破坏性清理由用户对具体对象与影响确认；不能影响同一服务下其他项目。

## 4. 合并既有 Agent 指令

只有原文件存在且 Harness 入口尚未接入时才合并。通过当前 `template render` 读取仓库模板，如 `template://repository/agent-base@1`、`agent-overlay@1`、`claude-entry@1`，以返回的正文与必需锚点为准，不复制其他人的 AGENTS 文件。

保留原文与项目特有规则；先准备完整合并结果和差异，再让用户批准这一具体修改。保留明确要求的锚点，不用模板覆盖用户内容。同一差异已获批时不再确认。

## 5. 验证能读取，并初始化知识位置

```bash
ha --root "<目标仓库绝对路径>" --json daemon status
ha --root "<目标仓库绝对路径>" --json task list
```

查看目标工作区真实状态和错误，不因文本摘要过短就判断服务损坏。空任务集是新工作区的正常结果。

部分 CLI 回执的 `evidence` 是 JSON 编码字符串。按实际类型解析，不直接假定字段在顶层；例如读取任务时先解析外层，再解析 `evidence`。报错与业务数据要分开判断。

随后读取 [harness-ceo](../harness-ceo/SKILL.md) 的[知识初始化方法](../harness-ceo/references/initialization.md)，建立或复用用户约定、模型矩阵、运行时问题、反馈与执行证据的落点。只建必要索引，不填满空表，不将公共技能中的建议当成用户事实。

## 6. 由主控带完一个真实任务

复用用户给的首任务，在主控方法下完成真实工作和仓库要求的收口。本阶段与下载引导的首任务是同一个任务。

### 真实的评审独立性

当前完成契约若要求独立执行评审，应在实施前明确可用评审身份与负责人。可能的拒绝为：

```text
Execution Review requires an independent transport-bound arbiter.
```

`HARNESS_ACTOR=agent:...` 是身份声明，不是创造独立评审者的方法。不能同一个执行者改名批准自己，也不能清空变量冒充用户的判断。需另一真实执行者、用户判断或宿主支持的独立评审通道时，交付可审阅材料后由该身份完成。只有一个模型不等于只有一个身份，但是否独立必须符合当前契约。

### 创建、执行和取证

先读 [preset-trigger](../preset-trigger/SKILL.md) 选择当前预设；一般任务形状如下：

```bash
ha --root "<目标仓库绝对路径>" task create --title "<真实任务>" --vertical software/coding --preset standard-task
ha --root "<目标仓库绝对路径>" task start <任务标识>
```

从回执取得真实任务路径，不能手拼派生的 slug。按当前生命周期要求执行，重复启动前先回读已有执行。若启动回执未带执行标识，查询 `task show`；部分版本将其放在 `evidence.lease.executionId`，需先解析 `evidence` 字符串，再读取 `["lease"]["executionId"]`。

做实际工作并取得证据。交付日志和报告归本次执行；会支撑后续判断的可复核观察按当前事实入口记录，不为凑数量编造事实。仓库规定的事实与关系要求仍然有效。

### 确有承重选择时记录决策

读取当前决策能力和输入契约；以下展示常见结构，实际字段和合法值以所用版本为准：

```json
{
  "title": "<决策标题>",
  "question": "<要解决的问题>",
  "riskTier": "low",
  "urgency": "low",
  "decisionClass": "ordinary",
  "appliesTo": { "modules": [], "productLines": [] },
  "chosen": [{ "id": "CH1", "text": "<选择>", "rationale": "<理由>" }],
  "rejected": [{ "id": "RJ1", "text": "<真实替代>", "whyNot": "<未采用原因>" }],
  "claims": [], "fulfillments": [], "relations": []
}
```

`decisionClass` 常用 `ordinary` 或 `standing_policy`；不编造替代方案。输入文件放在工作区允许的任务产物位置。遇到 `fromFile must stay inside the workspace` 时修正输入落点，不能把临时目录当成有效来源。

原始观察先记录，再按当前 `ha relation` 契约将决策声明关联证据，选择关联派生任务。不要复制退役的 `decision relate` 命令。用户需要裁决时展示问题、选择、替代和证据后取得批准，由真实有权身份办理；不通过更换环境变量代替用户。

### 提交、独立评审、同意和完成

把收口材料写实，先 `doc status` 检查候选，再通过受支持的 `doc sync --submit` 登记本任务文档。不要提交无关候选；路径限定与执行身份的组合以当前能力为准。

提交材料示例：

```json
{
  "completionClaim": "<已成立的结果>",
  "deliverables": ["<真实产物>"],
  "outputs": ["<收口记录>"],
  "verificationNotes": ["<实际执行和结果>"],
  "knownGaps": [],
  "residualRisks": [],
  "commitSha": "<实际源码提交>"
}
```

```bash
ha --root "<目标仓库绝对路径>" task submit <任务标识> --execution-id <执行标识> --from-file "<工作区内提交材料>"
```

代码文档锚通过当前 `task code-doc reconcile` 在所需阶段产生，不手写机器文件。由真实独立评审者提交评审，其材料包含：

```json
{ "verdict": "approved", "reason": "<依据>", "evidenceChecked": ["<实际检查的证据>"] }
```

`verdict` 使用当前合法值，如 `approved`、`changes_requested`、`dismissed`。owner 的同意绑定实际已记录评审与内容版本，不把工作者的报告当作同意。使用当前 `task review-consent` 和 `task complete` 契约完成；不添加过期的提交版本参数或自己制造摘要。

`--ci passed` 是声明，不会替你运行 CI。没有真实证据就不能据此声称检查通过。所选任务无需 CI 时按实际契约处理；无法满足必需门时交付具体缺口，不伪造完成。

最后回读任务是否真的到 `done`，并检查原始目标确实实现。独立评审尚缺时，准确报告“环境和仓库已就绪，首任务待评审”，不能把整个引导说成已验证。

## 7. 交接

交付绝对 CLI 入口、目标工作区、用户知识索引、首任务与其证据、真实评审身份及未完成项。工具进入 PATH 的选项由下载技能统一负责，本技能不另提供第二套安装命令。

说明台账与项目各自的历史边界，不在台账里手工补 `git commit`。列出项目仍未提交的文件，不替用户隐瞒这些变化。下一次使用 `harness-ceo`，另一个新项目直接使用本技能。

## 完成条件

- CLI 和同版本技能可用；实际目标工作区可读写。
- 私有台账未进入公开项目；既有指令修改经过具体批准。
- 用户知识入口能找到模型、问题、反馈与证据位置。
- 一个用户指定的真实任务完成当前契约要求的取证、提交、独立评审与同意，回读状态为 `done`。
- 未提交文件、未验证部分和使用命令已如实交接；任一必需阶段仍受阻就报告该阶段，不提前宣称全流程完成。
