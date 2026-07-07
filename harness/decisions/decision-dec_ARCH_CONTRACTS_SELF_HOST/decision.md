---
schema: decision-package/v1
decision_id: dec_ARCH_CONTRACTS_SELF_HOST
_coordinatorWatermark: 1783175196596-81d93aa2-efe5911ce03b2ebe
title: "20-contracts 抽出自宿主为 harness/contracts/(同 adr/milestones), 因 ADR↔contract 紧耦合=同一 canonical 层"
state: active
riskTier: medium
urgency: low
vertical: "software/coding"
preset: "architecture-decision"
applies_to:
  modules: []
  productLines: []
proposedBy: { kind: "agent", id: "fable" }
proposedAt: "2026-07-04T10:45:52.415Z"
arbiter: { kind: "human", id: "zeyuli" }
decidedAt: "2026-07-04T14:26:36.595Z"
provenance:
  - { runtime: "claude-code", sessionId: "add8176f-02a3-422a-b410-a9233d9f02dd", boundAt: "2026-07-04T10:45:52.415Z" }
question: "ADR 与 20-contracts 紧耦合(ADR-0016 refines contract-37 等), 引用该切到 decision, 还是 contract 也该像 ADR/milestone 抽出自宿主?"
chosen:
  - { id: "CH1", text: "contract 也抽出: harness/contracts/ 从 kernel-rewrite 设计树迁到自宿主 harness/contracts/(与 harness/adr、harness/milestones 同构)。ADR↔contract 的 refine 紧耦合恰证明 contract 与 ADR 同属活 canonical 层, 该同等对待。解决'两套文档同处引发歧义'(泽宇), 完成抽离模式。抽出后 ADR 的 contract 引用指向新自宿主路径; decision-log 引用已随 Q3 冻结指向内核台账" }
rejected:
  - { id: "RJ1", text: "contract 留在旧设计树, ADR 引用切成 decision 引用; 整树保留不动", why_not: "留旧树=歧义持续(活 canonical 埋在历史树里); 切成 decision 引用不解决 contract 正文该住哪; 整树不动=Q1/归档目标落空" }
claims:
  - { id: "C1", text: "contract 也抽出: harness/contracts/ 从 kernel-rewrite 设计树迁到自宿主 harness/contracts/(与 harness/adr、harness/milestones 同构)。ADR↔contract 的 refine 紧耦合恰证明 contract 与 ADR 同属活 canonical 层, 该同等对待。解决'两套文档同处引发歧义'(泽宇), 完成抽离模式。抽出后 ADR 的 contract 引用指向新自宿主路径; decision-log 引用已随 Q3 冻结指向内核台账" }
relations:
---

# 20-contracts 抽出自宿主为 harness/contracts/(同 adr/milestones), 因 ADR↔contract 紧耦合=同一 canonical 层
