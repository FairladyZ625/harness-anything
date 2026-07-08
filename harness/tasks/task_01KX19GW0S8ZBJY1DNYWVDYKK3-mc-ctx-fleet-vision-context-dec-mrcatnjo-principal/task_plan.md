# MC-CTX fleet-vision context 对齐 dec_mrcatnjo:写入发起面 principal 层

Task Contract: harness-task v1

## Brief

文档对齐任务：把 2026-07-09 的协作形状裁决（`dec_mrcatnjo` active / `dec_mrc9dgik` rejected）写入 `harness/context/architecture/fleet-vision-2026-07/` 文档族——凡把边缘节点单义地描述为"哑执行器/最低权/只能报告自身"的地方，补上发起面 principal 层的表述；同步更新决策 crosswalk 与 glossary。**这是措辞对齐，不是重新设计**（设计深化归 MC-B4）。

## Goal

可验证结果：
1. fleet-vision 文档族中关于节点模型的表述与 dec_mrcatnjo 一致：执行面（runner 出站拉取、中心派活验收入账）表述**保持原样不动**；凡涉及"节点权力/身份"处，区分 node 身份（机器，最低权）与 principal 身份（节点背后的人+agent，有 authorship）。
2. `internal/14-decision-crosswalk.md` 新增 dec_mrcatnjo 行（含它 supersedes dec_mrc9dgik 的关系）；若 crosswalk 记录决策终态,同步 dec_mrc9dpxk/dec_mrc9dyd5/dec_mrc9e600/dec_mrc9ef3g 的 2026-07-09 终态。
3. `appendix/glossary.md` 增补三词条:principal / node identity / authorship（定义从 dec_mrcatnjo 原文抽取，不自由发挥）。
4. 修订处均以 `dec_mrcatnjo` 为引用锚（读者能从文档回溯到决策）。

交付物：文档修订（此为 harness ledger 内 context 文档——按该仓惯例在 canonical 主仓直接修订并 commit，**不需要 worktree**（dec_HARNESS_LEDGER_NO_WORKTREE），但 commit 信息规范、逐文件可回溯）。第一个使用者：MC-B4 的设计者（在对齐后的文档上深化）；三位新协作者（读 fleet vision 时不再撞见与最新裁决相反的表述）。

## Context

为什么做：
- `dec_mrcatnjo`（active）裁决了平面拆分；fleet-vision 文档族成文于裁决前，其节点模型章节沿 `dec_mra363jk` 的执行面视角单义描述节点为最低权 runner——执行面描述仍正确，但缺发起面，且个别表述会被新读者误读为"节点背后的人也无发起权"。
- `dec_mrc9dgik` rejected 的教训要留痕：原案"翻转+边缘本地权威"为何被拒（会砸单写者/单一真相），crosswalk 里记一句，防止未来有人再提同款。

看哪里（修订面清单，逐个检查是否命中）：
1. `harness/context/architecture/fleet-vision-2026-07/internal/01-technical-architecture.md` —— 节点/调度角色章节。
2. `internal/02-evolution-and-boundaries.md` —— 演进边界叙述。
3. `internal/03-fleet-protocol-design.md`、`internal/05-worker-daemon-design.md` —— worker/协议章节中节点权力表述。
4. `internal/08-identity-rbac-extension.md` —— 身份章节（**只做措辞对齐+指向 dec_mrcatnjo 与 MC-B4,不做设计深化**）。
5. `internal/13-plt-fleet-charter-draft.md` —— charter 草稿中节点模型段;顺带把 dec_mrc9ef3g 裁决细化（M5-a 已提前、M5-c 仍为 charter 必答）反映进 charter 必答清单。
5b. `internal/04-dispatcher-design.md`、`internal/06-fleet-registry-design.md` —— dispatcher 与节点花名册文档中涉节点权力/身份表述处（06 的 nodes.yaml schema 与 01 §2.4"人/agent/机器三类 actor 同构"句是重点核对面;执行面 schema 字段不动，只对齐身份措辞）。
6. `internal/14-decision-crosswalk.md`、`appendix/glossary.md`、`README.md`（若有节点模型摘要）。
7. 决策原文:`harness/decisions/decision-dec_mrcatnjo/decision.md`（chosen/claims/rejected 全文——修订措辞的唯一语义来源）。

## Constraints

- **不改执行面设计**：dec_mra363jk 的全部裁决（拉取式调度、注册 token、出站长连接、调度器=特权客户端、开源/闭源切割）一字不动。
- 不做设计深化（MC-B4 的活）;不改代码;不动 gate。
- 措辞的语义来源只有 dec_mrcatnjo 原文;拿不准的表述宁可引用原文也不转述。
- 逐文件小 commit（每 commit 一个文档或一组同质修订），信息用 docs: 前缀,不提 AI。

## Checkpoint

- 发现某文档的节点表述改了会牵连执行面语义（改不动的耦合句）→ 停,把该句原文报给 CEO 定措辞。
- 发现 fleet-vision 文档与 dec_mra363jk 本身有既存矛盾（历史漂移,非本次裁决引起）→ 记 fact 上报,不顺手修。
- 计划性回报点：修订面清单核完（哪些文件命中、各几处）先报,再动笔。

## CI/Gate Authority Stop Condition

非 CI/gate 任务,不触碰 gate 权威面。

## Implementation Plan

1. 通读 dec_mrcatnjo 原文 + 修订面清单逐文件 grep 节点表述,产出命中清单报 CEO。
2. 逐文件修订:补 principal 层表述 + 决策引用锚;crosswalk/glossary/charter 必答清单更新。
3. 逐文件 commit;progress append + fact(修订清单与决策锚)。

## Verification

- 全文档族 grep:不存在与 dec_mrcatnjo 相悖的单义"节点=哑执行器且背后无发起权"表述;执行面章节 diff 为零(或仅加引用)。
- crosswalk 含五条决策终态与 supersedes 关系;glossary 三词条落位。
- CEO 语义验收要点：①执行面零改动（diff 审查重点）；②principal 措辞与决策原文一致,无自由发挥；③crosswalk 把 rejected 原因记了一句。
