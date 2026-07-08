# Progress

进展必须通过 `ha task progress append ... --evidence type:PATH:summary` 记录；不得只保留模板内容。progress 是时间线，不是 fact。承重观察必须另用 `ha fact record --task <task-id> ...` 写入 `facts.md`。

## Log

- 记录关键实现步骤、验证结果和阻塞。

## Evidence

| ID | Type | Evidence | Status |
| --- | --- | --- | --- |
命中清单已核完: README.md 1 处; internal/01-technical-architecture.md 3 处; internal/02-evolution-and-boundaries.md 2 处; internal/03-fleet-protocol-design.md 3 处; internal/05-worker-daemon-design.md 2 处; internal/08-identity-rbac-extension.md 5 处; internal/13-plt-fleet-charter-draft.md 3 处; internal/14-decision-crosswalk.md 3 处; appendix/glossary.md 3 处。未命中即停条件:未发现必须改动 dec_mra363jk 执行面的耦合句,未发现本次范围内与 dec_mra363jk 的既存历史漂移。

Evidence: doc:harness/context/architecture/fleet-vision-2026-07:rg命中与逐文件阅读
增量核对: 当前 task_plan 脏工作树中新增 5b 核对面,已检查 internal/04-dispatcher-design.md 与 internal/06-fleet-registry-design.md;命中各 2 处,均为 dec_mrcatnjo 措辞锚点,未改 assignment 字段、registry schema 或执行面策略。

Evidence: doc:harness/context/architecture/fleet-vision-2026-07/internal/04-dispatcher-design.md:dispatcher与principal边界
文档修订已完成并提交: README c5661d2f; 01 6110eb2d; 02 086023e0; 03 35941fe6; 04 f14c2937; 05 57844858; 06 1dc8fc2b; 08 8befb3f6; 13 bfae2eff; 14 69b4d506; glossary 69ffae2e。验证: fleet-vision 工作面无未提交变更; rg 未命中'哑执行器'; '本地权威/边缘本地权威'仅出现在否定或 rejected/supersedes 说明。

Evidence: doc:harness/context/architecture/fleet-vision-2026-07:grep与git状态验证
验收返修完成: internal/14-decision-crosswalk.md §4.5 仅替换 dec_mrc9e600 与 dec_mrc9ef3g 两行 fleet 影响列。diff 为 2 insertions/2 deletions; dec_mrc9e600 改为已裁选项c立即上线+选项b第一fast-follow+3人/产品线拆分并发画像+A组写路径硬化并行开工; dec_mrc9ef3g 改为 M5-a 已提前派生、M5-b 已派生 doc-write-intent、仅 M5-c 读新鲜度留 PLT-Fleet charter 必答。commit eceb46f6。

Evidence: doc:harness/context/architecture/fleet-vision-2026-07/internal/14-decision-crosswalk.md:§4.5两行终态措辞修正
