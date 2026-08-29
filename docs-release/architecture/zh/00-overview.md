# 系统的形状

[这解决的是什么问题?](../../learn/zh/00-overview.md) 押下了一个赌注:代理留下的那条持久
轨迹——选择、进度、观察——应该被提升为活在 git 里的结构化实体,以 Markdown 作为真相的载体。
这一页展示的是撑起这个赌注的那台机器的形状:有哪些层、每层做什么、真相到底落在哪里。

## 一切所依托的那一句话

有三种存储角色，而它们并不对等。

> Git 承载的 canonical 事件与撰写好的 Markdown 是已发布的记录；本地 WAL 在写入
> 物化到 Git 之前持久保存已接受的写入；SQLite 则是可重建的读投影。

三个知识原语——decision、task、fact——以带 YAML frontmatter 的纯 Markdown 撰写；执行链也
会被撰写：Session、Execution 与 Review 保存谁完成了某一轮交付、提交了什么、由谁裁决。每一次
被接受的变更还会成为 canonical 事件。在发布窗口内，`.harness/wal/` 可能含有尚未进入 Git
的已接受事件；读取会把它们与 Git 中的事件流合并。系统正确性不依赖 SQLite 数据库
存活，它仍是可丢弃的投影（ADR-0027 D1、D5）。

记住这处不对称。写入先跨过 daemon 边界，在 WAL 中变得持久，再发布到 Markdown 与 Git；
读取由投影提供，投影可以从合并后的 canonical 事件流追平或重建。

## 各个层

```text
写路径
  packages/cli/ + packages/gui/       薄协议客户端
                 |
                 v 本地 daemon RPC
  packages/daemon/src/                DaemonHost + 每仓 RepoCell
                 |
                 v 串行命令处理
  packages/application/               编排服务
  packages/kernel/src/domain/         契约 + 冻结写计划
                 |
                 v 先追加，后物化
  packages/kernel/src/store/          .harness/wal/ -> Git 台账

读路径
  合并后的 WAL + Git canonical 事件流
                 |
                 v 追平或重建
  packages/kernel/src/projection/     SQLite -> CLI / GUI
```

自上而下读这个栈,每一层都只干一件事。

**交付面 —— `packages/cli/` 与 `packages/gui/`。** `ha` 负责解析和呈现命令，但不会组合
application 或 kernel 写者。持久化命令都通过 daemon 协议发送；GUI 也是该协议的客户端。
这些交付面可以请求写入，但不拥有写状态。

**本地 daemon 与 RepoCell —— `packages/daemon/src/`。** Daemon host 把请求路由到其
canonical 仓库对应的 RepoCell。该 cell 解析归因与授权，持有活跃写者代际，并串行排队
写入，使同一时刻只有一个操作推进该仓库。这里是单一写路径的协调点。

**应用服务与 kernel domain。** `packages/application/` 里的服务和 daemon 中的专用
handler 编排各类命令。契约、迁移、schema 与冻结写计划位于 `packages/kernel/src/domain/`
和 `packages/kernel/src/schemas/`。无效或未授权的命令会在事件追加前被拒绝。

**Canonical 事件存储 —— `packages/kernel/src/store/`。** `wal-shadow-event-store.ts`
先把已接受的事件与内容 blob 追加到本地 WAL。`wal-git-materializer.ts` 再按修订号
将待处理事件发布到 Git，并一起推进 canonical ref 与 authored ref。在这个发布窗口内，
读取会合并 WAL 与 Git；恢复流程会重试任何未完成的 cut。

**已发布台账与投影。** Git 保存可供 clone、diff 与评审的已落定 canonical 事件和撰写好的
Markdown。本地 WAL 是已接受写入等待发布时的持久交接状态，不是已发布台账的对等副本。
`packages/kernel/src/projection/` 从 canonical 事件流构建 SQLite 读模型；数据库可以追平或重建。

**Adapters。** `packages/adapters/` 提供特定运行时的绑定，不会创造第二条写路或第二个真相来源。

## 一个请求如何流动

写和读共用 daemon 边界，此后走向不同的存储路径。

一次**写入**从薄客户端进入并跨过本地 daemon 协议。该仓库的 RepoCell 将其串行化；
application 与 domain handler 强制它的生命周期规则、授权与冻结写计划。如果被接受，
canonical 事件会先在 `.harness/wal/` 中变得持久，随后由 Git materializer 把待处理事件及其
撰写文档发布成有序 commit。claim、submit 与 review 仍是协调的领域命令（ADR-0027 D1-D3、D5）；
CLI 本身不写这些 Markdown 文件或 Git ref。

一次**读取**也经过 daemon，通常由 SQLite 投影提供。投影从 canonical 事件流追平；该事件流
会合并已发布的 Git cut 与 WAL 中仍在等待发布的已接受事件。如果数据库缺失，可以从该 canonical
事件流重建。无论哪种方式，答案都来自持久的结构化记录，绝不来自聊天记录里的文字。

## 接下来去哪

余下每一章都放大这个栈里的某一层。

- [01 · 三个实体在磁盘上如何存放](01-storage-model.md) —— decision、task、fact 的目录结构、
  frontmatter 模式与 ID 模式。
- [02 · 单一写路径](02-write-path.md) —— 每个承重写入都要经过的那道门,以及它一路上盖下的章。
- [03 · 投影:从 Markdown 到 SQLite](03-projection.md) —— 读缓存如何被重建、它持有哪些真实的
  表、陈旧如何被检测。
- [04 · 管线中的门](04-gates-in-the-pipeline.md) —— 守护生命周期迁移的那些 fail-closed 检查。
- [05 · 垂直域:声明式引擎](05-vertical-engine.md) —— 一个声明式的 `vertical.json` 如何在不碰
  内核的情况下加入领域概念。
- [06 · 出处、裁决与事件账本](06-provenance-and-events.md) —— 每个实体如何被绑定到产生它的
  东西,以及"发生了什么"如何被记录。

此外，[架构与项目解释页（单页 HTML，含 12 张图）](architecture-explainer.html) 用一份自包含页面把「这个项目是什么」与十个架构切面串在一起，适合一次性通读或对外分享。
