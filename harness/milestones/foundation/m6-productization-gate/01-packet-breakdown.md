# M6 · 实现 Packet 拆解（01-packet-breakdown）

- **状态**: canonical（2026-07-07 CEO 拆解落库；任务树在 ledger 建立）
- **上游**: `00-overview.md`（四主轴范围）、`dec_M6_CHARTER_PRODUCTIZATION_GATE`（章程，active）、`dec_NPX_ONBOARDING_M6_FIRST_PRIORITY`（A 主轴头号）、`dec_GOV_MILESTONE_SCOPE_TASK_DERIVATION`（B1 执法依据）
- **根任务**: `task_01KWWYYFGG2QE4BPB8CT339SAP`（taskClass=milestone；15 packet 为其直接子任务，`ha task tree task_01KWWYYFGG2QE4BPB8CT339SAP` 可验）
- **定位**: GUI 前最后一步 · 产品化第一步 · exit = 0.1 npm 发布就绪

## 任务族总表（15 packet）

| 包 | 主轴 | 标题要点 | 依赖 | 风险 | 波次 |
| --- | --- | --- | --- | --- | --- |
| **A1** | 发布 | npx 一键 onboarding：`npx harness-anything init` 真实可用 + 30 秒引爆路径脚本化（init→演示门拦假完成）；ADR-0010 Foundation 切片（Scaffold+Configure-Verify） | 无（首发头号） | high | 0 |
| **A2** | 发布 | npm 公发前置：去 `private:true@0.0.0` + supply-chain 门全绿（OSV/SBOM/license/audit/Dependabot/AGPL）+ `npm publish --dry-run` 演练 + 包元数据 | B2*, A1（需全绿） | high | 3 |
| **A3** | 发布 | 对外叙事收尾：README/onboarding 对齐 accountability-layer（#203 续） | A1 | med | 2 |
| **B1** | 一致性 | decision-conformance preset（process-action JS 脚本，`ha check` 收集）：decision↔code/doc/task/fact 四面漂移 + supersede 链 + proposed 滞留 + **accepted 无 task/defer 边** + milestone checklist↔merged PR 对账 | 无（kickoff，自查其余包） | high | 0 |
| **B2a** | 一致性 | template-catalog schema v2 单源：JSON Schema + Effect schema 升 v2，loader 停止静默降级回 v1（E74 单源）+ 防回归门 | 无 | med | 0 |
| **B2b** | 一致性 | capabilities 去硬编码：解析侧 entity kinds 从 registry 派生（去 `parsers/capabilities.ts:6` 的 19-kind 集合）+ 防回归门 | 无 | med | 0 |
| **B2c** | 一致性 | zh-CN 模板英文清零（现 6 残留）+ locale 内容门（防再漂） | 无 | low | 0 |
| **B3** | 一致性 | ADR-0022 enforcement debt 收编：F5/F6/F8 gates + D4 夜扫（既有 active 任务并入） | 无 | med | 1 |
| **C1** | 采用 | preset-trigger skill（desc≈"构建 harness task 时须看此 skill"，可用户直调）+ `ha task create` help 主动列 preset（含 brief） | 无 | med | 1 |
| **C2** | 采用 | preset/vertical creator skills 升 v2（repo /skills 停在 06-14，对齐 E77/E78/manifest v2） | C1 | low | 2 |
| **C3** | 采用 | docmap 收缩：砍 brief/tags/owner 留精简 routing-index + 新鲜度门；实证观察 1-2 milestone 不用则删 | 无 | low | 1 |
| **C4** | 采用 | contracts 自宿主搬迁：`harness/contracts/` → `harness/contracts/`（同 adr/milestones），ADR 引用重定向 | 无 | med | 0 |
| **D1** | 收纳 | W5：closeout+fact 即蒸馏原料（派生标记，不另写；泽宇 2026-07-07 定） | hygiene ✅ | low | 1 |
| **D2** | 收纳 | archive-distill 实装：阶段选集→蒸馏锚点 task→fact/decision 重锚定→批量 D2 归档（走既有 WriteCoordinator op） | D1 | high | 2 |
| **D3** | 收纳 | Q1 152-islands 重梳：D2 首个真实 dogfood 用例（含清账后的终态任务批量蒸馏归档，降 islands，前后对比证据） | D2, hygiene ✅ | med | 2 |

依赖边落 ledger（`ha task relate … depends-on …`）；`dec_M6_CHARTER_PRODUCTIZATION_GATE` `derives → 根任务` 及各 packet。

## 波次排程（Commander 调度基准）

- **Wave 0（立即并行，文件面不撞）**: A1（cli/init + 脚本）· B1（新 preset 资产）· B2a（kernel schema）· B2c（模板资产）· C4（文档迁移）。
  - ⚠️ **B2b（capabilities parser）与 C1（task create help）同踩 `packages/cli/src/cli/`**——B2b 排 Wave 0 尾、C1 排 Wave 1，不同波次错开；或先切分文件面。
- **Wave 1**: B2b · C1 · C3（docmap）· B3（enforcement）· D1（distill 标记）。
- **Wave 2**: A3（叙事）· C2（creator skills）· D2（archive-distill）· D3（islands 重梳）。
- **Wave 3**: **A2（npm 公发门——最后）**：需 B2* 清零 + conformance 0 漂移 + usability PASS 后才跑 dry-run publish。

## 与 daemon 线避撞（红/黄区）

- **红区不碰**: `packages/daemon/`、`harness/people.yaml`、command-receipt/v2 schema、`dec_mr9a*`。
- **黄区先协调**: B2a/B2b 动 `packages/kernel` schema 与 `packages/cli` 时，注意 daemon W6（投影增量化）同踩 `packages/kernel/src/projection`——排程避开或先通报。新增 entity kind 通报 daemon 路由。

## Exit 判据（承 00-overview，= 0.1 发布就绪）

1. `npx harness-anything init` 冷启动真实可用 + 30 秒引爆路径脚本化验证 + **泽宇亲跑满意**（使用满意度前置门）。
2. supply-chain 门全绿 + `npm publish --dry-run` 通过 + 包元数据齐全。
3. conformance preset 在 M6 自身跑出 0 条未解释漂移；B2a/b/c 三漂移清零且各有防回归门。
4. usability 门按新 completion-gate 口径（P0-P3 schema、transition in_review→complete）复跑 PASS。
5. M6 每条 accepted decision 都有 task/defer 边（B1 自证）。
6. 收纳闭环真跑通：D2 archive-distill 实装 + D3 islands 降低有前后对比证据。

## 前置条件核验（2026-07-07）

1. ✅ 章程 accepted→active（`dec_M6_CHARTER_PRODUCTIZATION_GATE`，arbiter human:zeyuli）。
2. ✅ 任务树原语可用：`ha task create --parent` / `ha task tree`（#198/#200）。
3. ✅ M5 exit-green：#240 合并（两阻断修复）、`ha status` 绿、账本占位 closeout 债清零。
4. ✅ D 主轴前置：closeout hygiene 完成（原料就绪，M6-D depends-on hygiene）。
5. ⏳ daemon 线并行不阻塞：文件面红/黄区已定界，排程避撞。
