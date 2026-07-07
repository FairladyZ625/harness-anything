# 任务包合同模板 (Task Packet Contract Template)

- **状态**: canonical
- **日期**: 2026-06-12
- **用途**: 所有 milestone 任务包在派工前必须继承本模板结构，填充具体内容后方可分配 worker。

---

## 模板结构

每个可派工的任务包必须包含以下字段：

```yaml
packet_id: TP-M<N>-<seq>
title: <一句话目标>
milestone: M<N>
status: draft | ready-for-dispatch | in-progress | completed

# --- 核心合同 ---

goal_alignment: |
  本包如何推进里程碑目标；与哪条验收标准对应。

inputs:
  - <前置产物路径或 packet_id，含预期交付物描述>

reading_list:
  - <worker 开工前必须阅读的具体架构/合同/路线图/ADR 路径；不得只写目录名或 README 总入口>

outputs:
  - <本包交付物路径及格式要求>

forbidden:
  - <本包 worker 不得触碰的边界（文件/模块/轴/概念）>

gates:
  entry:
    - <开工前必须满足的条件（前置 packet 完成 / contract 存在 / 裁决锁定）>
  exit:
    - <完成判定条件（测试通过 / 代码审查 / CI 绿 / 文档就位）>

stop_condition: |
  何时应停下来升级而非继续：遇到 <X> 时立即报告，不自行裁决。

# --- 流程约束 ---

review_route: |
  完成后走哪条审查路径（self-review / peer-review / arch-review）。

public_private_write_range:
  public: <可写入公开仓库的路径 glob>
  private: <仅写入 harness 的路径 glob>

scaffold_provenance: |
  本包依赖的 scaffold/骨架来源（哪个 ADR / contract / 前置 packet 产出）。

needs_decision_refs:
  - <本包依赖的 needs-decision 编号；未裁决则 entry gate 不满足>
```

---

## 使用规则

1. **派工前必填**：`goal_alignment`、`inputs`、`reading_list`、`outputs`、`forbidden`、`gates`、`stop_condition` 为必填字段。留空则不可进入 ready-for-dispatch。
2. **Worker 不可自行扩展 outputs**：交付物范围由合同锁定，超出需升级。
3. **needs-decision 阻塞**：若 `needs_decision_refs` 中任一项未裁决，entry gate 不满足，packet 停留 draft。
4. **review_route 不可省略**：每个 packet 必须明确审查路径，防止 worker 自审自过。
5. **public_private_write_range 必须与 PublicPromotionGate 对齐**：私有路径不得出现在 public glob 中。
6. **reading_list 必须具体**：README 可以作为入口，但不能作为唯一阅读项；packet 必须列出会约束实现的 ADR、contract、roadmap/status checklist 和 governance standard。若 worker 发现 reading_list 与任务实际不匹配，应先回到 coordinator 补 packet，不靠自行考古扩大上下文。

---

## 与现有 breakdown 的关系

`harness/milestones/m*/01-feature-breakdown*.md` 中的"任务包切分建议"是分组建议，不是可派工合同。派工流程：

1. 从 breakdown 的分组建议中选取一个 packet
2. 按本模板创建具体合同文件（建议放 `m*/packets/TP-M<N>-<seq>.md`）
3. 填充所有必填字段
4. 状态改为 `ready-for-dispatch`
5. 分配 worker

---

## 示例（M1 P0 基线 ADR）

```yaml
packet_id: TP-M1-00
title: 基线 ADR（Supersession + harness-anything bootstrap）
milestone: M1
status: ready-for-dispatch

goal_alignment: |
  M1 验收标准第 1 条"00-index 设计包已定稿"的前置；
  为后续所有 packet 提供旧代码定性与新仓库骨架。

inputs:
  - 10-foundation/00-index（设计包目录，已存在）
  - 36-harness-anything-bootstrap.md（ADR 草案）

reading_list:
  - ha decision show E<n>
  - 30-implementation-start/36-harness-anything-bootstrap.md
  - harness/contracts/28-review-protocol.md

outputs:
  - harness/adr/ADR-0003-supersession.md（status: accepted）
  - harness-anything 仓库骨架（package.json / tsconfig / 目录结构）

forbidden:
  - 不得写任何 kernel domain 代码
  - 不得引入运行时依赖（devDependencies only）

gates:
  entry:
    - 相关 `decision/<id>` 已 active
  exit:
    - ADR 经 arch-review 通过
    - 仓库骨架 `npm run build` 零错误

stop_condition: |
  若相关承重 decision/ADR 有争议未裁决，停下等裁决。

review_route: arch-review（协调者审阅）
public_private_write_range:
  public: harness-anything/packages/**
  private: harness/adr/**

scaffold_provenance: 36-harness-anything-bootstrap.md
needs_decision_refs:
  - decision/<id>
```
