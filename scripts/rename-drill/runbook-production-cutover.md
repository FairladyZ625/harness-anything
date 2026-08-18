# CH3 状态词改名——生产切换 Runbook

适用对象:CEO 亲自执行(worker 不碰生产台账)。生产台账 = 生产仓根下的 `harness/`;运行时状态 = 生产仓根下的 `.harness/`;生产 daemon 政体 = `~/.harness-production` 命名空间。**切换与回退的最小单元是 {harness, .harness} 一对目录,永远一起动。**

演练依据:2026-08-18 副本演练(本机 scratch 副本)+ 对抗复核(Opus)裁定「修复后可切换」。replayer=`scripts/rename-drill/replay.mjs`,五条验收 + 五件套验证在副本上绿。演练冻结点 `176ef9fb`/revision 22871;**生产执行时所有数字必须冻结后重取,本文数字只是演练参考**。

## 前置条件(全部满足才开始)

- [ ] 改名 PR(groups 1-4 commit + op_rejected commit)已开好、GitHub CI 全绿,**但不合 main**。合 main 发生在切换完成之后(见步骤 7):post-merge hook 会全局安装新 `ha`,合早了会造出「新代码全局 ha + 旧词台账」的 716-issues 无人看守窗口。
- [ ] 执行全程使用改名分支的 worktree checkout 跑本目录全部脚本(`ledger-walk / census / replay / cold-export / normalize-compare / projection-rebuild / decision-digest-pair / classify-tree-diff`)——replayer 直接 import kernel 源码,必须与新代码同版本。
- [ ] 预约停机窗口:全程无人写台账(实测重放 4 分钟 + 验证约 20 分钟,窗口建议 ≥1 小时)。
- [ ] 异机备份目的地可写。

## 步骤

### 1. 冻结 writer

0. **先停编排面**:loop/定时任务(scheduled tasks)/其它 worktree 里可能写台账的 agent 会话,全部停下或确认不会在窗口内动台账。
1. 停 GUI/dev:electron(防复活链:先查 `ps` 里 dev:electron 的 ppid,先停父再停 daemon)。
2. `ha daemon stop`(生产政体 + 项目 daemon 全部);删 launch-spec 防重启。**daemon 枚举以 `ps` 为准**:stop 返回 `daemon_unavailable` 不代表进程死了。
3. 确认无残留:`ps aux | grep -E "daemon serve|dev:electron"`;`ls <root>/../*.harness-anything-writer.lock`——存在则核对 pid 已死后删除。
4. **窗口纪律:窗口内全局 `ha` 本身视为写入器,禁止敲**(包括"只是查一下"——autostart 会拉起 daemon)。
5. 清点在途:`git -C harness status --porcelain` 记录未提交 worktree 漂移(演练发现:生产 worktree 会有未入账 task 目录/prose 漂移,属正常;重放只重放 canonical 树,漂移文件由步骤 6.3 按清单处置)。
- **中止条件**:有 lease 处于未释放状态且 holder 进程还活着 → 不是冻结,回去先停干净。

### 2. 记录冻结点 C0 + 备份(含 .harness)

```bash
set -euo pipefail
cd <生产根>
git -C harness rev-parse refs/ha/canonical             # C0
git -C harness show refs/ha/canonical:events/head.json # revision + eventDigest
git -C harness bundle create /backup/harness-pre-rename-$(date +%Y%m%d).bundle --all
cp -Rc harness /backup/harness-pre-rename-copy
cp -Rc .harness /backup/dot-harness-pre-rename-copy    # 运行时状态与台账同批备份
# 异机备份 bundle;并验证:git clone <bundle> /tmp/verify && git -C /tmp/verify rev-parse <C0>
```
- **中止条件**:bundle 无法 clone 或 C0 不可 checkout。

### 3. 冻结点存量重取(一条命令)+ 旧代码基线

```bash
set -euo pipefail
node scripts/rename-drill/census.mjs --repo <生产harness> --workspace <生产根> --json > census-freeze.json
```
- 记录五组数字;`unclassifiedTypedPaths` 必须为 0(fail-closed:出现未分类 typed path 立即中止——冻结后出现了演练没见过的事件形状,先扩规则表)。
- 旧代码冷重建基线(**用旧代码 checkout,即当前 main**):`node scripts/rename-drill/cold-export.mjs --workspace <干净checkout根> --out cold-old-baseline.json`,必须 `complete=true, issues=0`;不绿则先修台账再谈迁移。
- 基线必须在**干净 checkout**(`git clone <生产harness> && checkout master`)上取,不要在带 worktree 漂移的生产树上取(演练教训:漂移目录会污染 tasks 对账)。

### 4a. Verify-only(不写任何东西,先证明规则可重建)

```bash
set -euo pipefail
node scripts/rename-drill/replay.mjs --verify-only --source <生产harness>
```
- 在冻结后的生产台账上跑源侧全部证明:每个 consent/pin digest 用 kernel `decisionMachineDigest` 从源文档复算并与存量相等、baseDocumentSha256 链、layout-migration `preEventsTreeSha` 审计字段、typed path 分类全覆盖。演练实测 20 秒。
- **中止条件**:非零退出。一个都不许失败;失败说明冻结后的台账上 digest 重建规则不成立,回到设计层。

### 4b. Genesis 重放到全新 destination

```bash
set -euo pipefail
mkdir <dest-root> && git clone <生产harness> <dest-root>/harness
node scripts/rename-drill/replay.mjs --source <生产harness> --dest <dest-root>/harness --manifest migration-manifest.json
git -C <dest-root>/harness checkout -f master
```
- replayer 自校验(任一失败即非零退出,**中止**):事件按新词表 schema 重新验证;未改动事件字节与源逐字节相同;4a 的 digest 证明在重放中逐事件复跑;两侧链不断裂;doc-sync 若曾写过 machine-owned 文档即失败;结束时最终文档对账(实际改写的当前文档集合 == typed 扫描判定必须改写的集合,按 decision.md/facts.md/INDEX.md 分桶)。
- **replay 非零退出 ⇒ 整个 `<dest-root>` 删掉重建,不得复用**(脚本会尽力删掉半成品分支,但唯一可信的恢复是重新 clone)。
- 记录 manifest:cut map、各组改写计数、digest 变化表、最终文档对账。

### 5. 副本验证五件套(全绿才许切换)

```bash
set -euo pipefail
# 5a) 新代际 census:旧词五组必须全 0,新词分布与冻结 census 一一对应
node scripts/rename-drill/census.mjs --repo <dest-root>/harness --json > census-new.json
# 5b) 双冷重建:两次 byte-identical 且 complete=true/0 issues
node scripts/rename-drill/cold-export.mjs --workspace <dest-root> --out cold-new-1.json
node scripts/rename-drill/cold-export.mjs --workspace <dest-root> --out cold-new-2.json
cmp cold-new-1.json cold-new-2.json
# 5c) 跨代等价:旧基线经词表归一化 == 新导出(deep equal)
node scripts/rename-drill/normalize-compare.mjs --old cold-old-baseline.json --new cold-new-1.json
# 5d) SQLite 全量投影重建:完整读路走通,watermark 必须到头(注意:digest 断言不在此处,由 4a/4b/5e 覆盖)
node scripts/rename-drill/projection-rebuild.mjs --workspace <dest-root>
# 5e) 跨代 decision machineDigest 配对:全部 decision.md 逐一 kernel 复算,归一化旧 == 新
node scripts/rename-drill/decision-digest-pair.mjs --old-repo <生产harness> --new-repo <dest-root>/harness
# 5f) 全树逐字节可解释分类:OTHER 路径 ≠ 0 即非零退出
node scripts/rename-drill/classify-tree-diff.mjs --repo <dest-root>/harness --old <C0> --new <newHead>
```
- 词汇门/DDD 门在代码仓复跑确认。
- **任何一步非零 ⇒ 中止,不切换,不加 fallback 放行。**

### 6. 原子切换(单元 = {harness, .harness})

```bash
set -euo pipefail
cd <生产根>
mv harness  harness-old-generation-<date>      # 只读封存,与 bundle 一起构成旧代际审计入口
mv .harness .harness-old-generation-<date>     # 陈旧投影 cache 只有 revision 数字、无台账身份绑定,而两代 revision 相同——留下它会自称 ready 并静默供旧词
mv <dest-root>/harness  harness
# 新代际身份验证:不匹配立即回退(把两个 old-generation 目录 mv 回来)
test "$(git -C harness rev-parse refs/ha/canonical)" = "<manifest.destination.head>"
```
1. 把步骤 1.5 清点的 worktree 漂移按清单逐个拷回或判弃。
2. **此时才合 main**(admin merge 已全绿的 PR;post-merge hook 全局安装新 `ha` 正好接上新台账)。
3. 启动 daemon:`ha daemon start --authority-manifest ...`(canonical 变更后 daemon 必须重启;`.harness` 是新的空运行时,首次读走冷重建)。
4. 首笔金丝雀写入:`ha fact record`/`ha task show` 各一,回执 `applied` 且新查询命令能读回。

### 7. 不可逆点与回退

- 合 main 前、新代际第一笔写入前:整体回退 = 两个 `*-old-generation-*` 目录 mv 回原名({harness, .harness} 必须一起回),重启 daemon,零损失。
- 已合 main 但需要回退:先 revert main(或全局装回旧版 CLI),再回退目录对;**永远不允许「新代码 + 旧台账」或「旧代码 + 新台账」的混配长时间存活**。
- 第一笔 post-cutover 写入后:两代分叉,回退只能显式反向重放,默认不做。
- 旧代际外部 receipt/sha 引用由 cut map + archive 解释,不回写。

### 8. 收尾

- manifest、census、冷重建证据、五件套输出、切换时间线全部落任务 artifacts;迁移任务关闭前删除一次性 replayer(`scripts/rename-drill/`)与所有旧词分支,不留 fallback。

## 演练与方案的两处已裁差异(执行时按此为准)

1. **facts.md 采用逐版本 typed 重渲染,而非方案 §2.2 的"末尾一次 current 重渲染"**:追加重渲染 claim 会破坏 §6"事件总数相同"门,且新代际历史 blob 内会残留旧词;演练实测逐版本重渲染全部落位、逐字节可解释。
2. **`ledger_layout_migrated` 的 `preEventsTreeSha` 按新代际重算**(方案未提及;不重算则新代际内部自相矛盾)。演练先在源上验证该字段==父树 sha 再替换。

## 演练教训(收官材料需引用)

- **改名类任务的本地停止点必须显式包含 integration tier 的受影响文件**:`check:local` fast tier 与 GUI tier 都不跑 integration shards,而 integration 层恰恰是「生产吐新词、断言仍旧词」缺陷的唯一本地捕获面——本轮 PR 五个 shard 红全部属于这一形态,其中还压着两处真生产缺陷(standing-policy coverage 仍判 `active`;migration importer 拒收全部旧词 legacy 源)。停止点写法:改名 diff 触到的实体,按实体 grep 出 integration/store/application 层测试文件清单,`node --test <files>` 显式实跑(不要裸 `--prefix`)。

## 已知残留(有意不迁,收官材料需点名)

- `.harness/generated/runtime-events/` 约 707 个文件保留旧词:已退役的 runtime-events 平面,无读路径,census 不覆盖;随 `.harness` 整目录封存进旧代际。
- 台账内 2 个人写散文文件(prose)含旧词字样:散文不在 typed 改名范围,按方案原则不动 prose。
- `active` 在 RelationEdge / Execution / Task 三个平面仍各有一个含义:属批准范围(本轮只消歧 Lease/Decision 的 active 与三处 retired),词表 register 已按 divergent 标注。
