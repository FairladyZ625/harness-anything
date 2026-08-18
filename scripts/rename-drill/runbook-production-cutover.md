# CH3 状态词改名——生产切换 Runbook

适用对象:CEO 亲自执行(worker 不碰生产台账)。生产台账 = 生产仓根下的 `harness/`;生产 daemon 政体 = `~/.harness-production` 命名空间。

演练依据:2026-08-18 副本演练(本机 scratch 副本),replayer=`scripts/rename-drill/replay.mjs`,全部五条验收在副本上绿。演练用的冻结点为 `176ef9fb`/revision 22871;**生产执行时所有数字必须在冻结后重取,本文数字只是演练参考**。

## 前置条件(全部满足才开始)

- [ ] 改名代码(groups 1-4 commit + op_rejected commit)已合入 main,GitHub CI 全绿。
- [ ] 本 runbook 所在 commit 的 `scripts/rename-drill/{ledger-walk,census,replay,cold-export,normalize-compare,projection-rebuild}.mjs` 与代码同版本(replayer 直接 import kernel 源码,必须用切换后代码跑)。
- [ ] 预约停机窗口:全程无人写台账(实测重放 4 分钟 + 验证约 20 分钟,窗口建议 ≥1 小时)。
- [ ] 异机备份目的地可写。

## 步骤

### 1. 冻结 writer

1. 停 GUI/dev:electron(防复活链:先查 `ps` 里 dev:electron 的 ppid,先停父再停 daemon)。
2. `ha daemon stop`(生产政体 + 项目 daemon 全部);删 launch-spec 防重启。
3. 确认无残留:`ps aux | grep -E "daemon serve|dev:electron"`;`ls <root>/../*.harness-anything-writer.lock`——存在则核对 pid 已死后删除。
4. 清点在途:`git -C harness status --porcelain` 记录未提交 worktree 漂移(演练发现:生产 worktree 会有未入账的 task 目录/prose 漂移,属正常;重放只重放 canonical 树,漂移文件在切换后原样保留或由 CEO 判定丢弃)。
- **中止条件**:有 lease 处于未释放状态且 holder 进程还活着 → 不是冻结,回去先停干净。

### 2. 记录冻结点 C0 + 备份

```bash
cd <生产仓># harness ledger repo
git rev-parse refs/ha/canonical            # C0
git show refs/ha/canonical:events/head.json # revision + eventDigest
git bundle create /backup/harness-pre-rename-$(date +%Y%m%d).bundle --all
cp -Rc harness /backup/harness-pre-rename-copy   # APFS clone
# 异机备份 bundle;并验证:git clone <bundle> /tmp/verify && git -C /tmp/verify rev-parse <C0>
```
- **中止条件**:bundle 无法 clone 或 C0 不可 checkout。

### 3. 冻结点存量重取(一条命令)

```bash
node scripts/rename-drill/census.mjs --repo <生产harness> --workspace <生产root> --json > census-freeze.json
```
- 记录五组数字;`unclassifiedTypedPaths` 必须为 0(fail-closed:出现未分类 typed path 立即中止——说明冻结后出现了演练没见过的事件形状,需先扩规则表)。
- 顺带取旧代码冷重建基线(**用旧代码 checkout 跑**):
  `node scripts/rename-drill/cold-export.mjs --workspace <生产root> --out cold-old-baseline.json`
  必须 `complete=true, issues=0`;不绿则先修台账再谈迁移。
  注意:基线必须在**干净 checkout**(`git clone <生产harness> + checkout master`)上取,不要在带 worktree 漂移的生产树上取(演练教训:漂移目录会污染 tasks 对账)。

### 4. Genesis 重放到全新 destination

```bash
mkdir <dest-root> && git clone <生产harness> <dest-root>/harness
node scripts/rename-drill/replay.mjs \
  --source <生产harness> --dest <dest-root>/harness \
  --manifest migration-manifest.json
git -C <dest-root>/harness checkout -f master
```
- replayer 自校验(任一失败即退出非零,**中止**):
  - 每个事件按新词表 schema 重新验证(serializeCanonicalEvent);
  - 未改动事件字节必须与源逐字节相同;
  - 每个 consent/pin 先在**源**上用 kernel `decisionMachineDigest` 复算并与存量一致(digest 规则重建证明),再在新代际复算;
  - baseDocumentSha256 链、doc-event baseLedgerSha 链断裂即失败;
  - doc-sync 若曾写过 machine-owned 文档(region proof 无法保持)即失败。
- 记录 manifest:cut map、各组改写计数、digest 变化表。

### 5. 副本验证四件套(全绿才许切换)

```bash
# a) 新代际 census:旧词五组必须全 0,新词分布与冻结 census 一一对应
node scripts/rename-drill/census.mjs --repo <dest-root>/harness --json > census-new.json
# b) 双冷重建:两次 byte-identical 且 complete=true/0 issues
node scripts/rename-drill/cold-export.mjs --workspace <dest-root> --out cold-new-1.json
node scripts/rename-drill/cold-export.mjs --workspace <dest-root> --out cold-new-2.json
cmp cold-new-1.json cold-new-2.json
# c) 跨代等价:旧基线经词表归一化 == 新导出(deep equal)
node scripts/rename-drill/normalize-compare.mjs --old cold-old-baseline.json --new cold-new-1.json
# d) SQLite 全量投影重建(内含 consent/pin digest 断言)
node scripts/rename-drill/projection-rebuild.mjs --workspace <dest-root>
```
- 再做逐字节抽样:`git -C <dest-root>/harness diff --name-status <C0> <newHead>` 全量分类,只允许:event json / head.json / objects blob 迁移 / decision.md / facts.md / INDEX.md;出现任何 OTHER 路径即**中止**。
- 词汇门/DDD 门在代码仓跑:`npm run harness:check-status-vocabulary` 等(合码时已绿,此处复跑确认)。

### 6. 原子切换

1. 生产 harness 目录整体改名封存:`mv harness harness-old-generation-<date>`(只读,永久保留;与 bundle 一起构成旧代际审计入口)。
2. `mv <dest-root>/harness <生产root>/harness`。
3. 把第 1 步清点的 worktree 漂移(未入账 prose/task 目录)按清单逐个拷回或判弃。
4. 删除新 harness 下可能残留的 `.harness/cache`(让首次读走冷重建);启动 daemon:`ha daemon start --authority-manifest ...`(记住:canonical 变更后 daemon 必须重启拿新代码/新树)。
5. 首笔金丝雀写入:`ha fact record`/`ha task show` 各一,回执 `applied` 且新查询命令能读回(金丝雀必跑新查询命令)。

### 7. 不可逆点与回退

- **切换后、新代际第一笔写入前**:可整体回退(mv 回旧目录、重启 daemon),零损失。
- **第一笔 post-cutover 写入后**:两代分叉,回退只能显式反向重放,默认不做;此时只能前进修复。
- 旧代际所有外部 receipt/sha 引用由 cut map + archive 解释,不回写。

### 8. 收尾

- migration manifest、census-freeze/census-new、cold 基线/新导出、双冷重建 cmp 结果、切换时间线,全部落任务 artifacts。
- 按方案要求:迁移任务关闭前删除一次性 replayer(`scripts/rename-drill/`)与所有旧词分支;旧 enum 不留 fallback。

## 演练与方案的两处已裁差异(执行时按此为准)

1. **facts.md 采用逐版本 typed 重渲染,而非方案 §2.2 的"末尾一次 current 重渲染"**:追加一条重渲染 claim 会破坏 §6"事件总数相同"门,且会让新代际历史 blob 内仍残留旧词;演练实测逐版本重渲染 36 docs/79 行全部落位、逐字节可解释。
2. **ledger_layout_migrated 事件的 `preEventsTreeSha` 按新代际重算**(方案未提及;audit 字段指向父 commit 的 events 树,不重算则新代际内部自相矛盾)。演练中先在源上验证了该字段确实等于父树 sha 再替换。
