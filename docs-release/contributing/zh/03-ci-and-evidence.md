# CI 与证据

每份贡献都需要证据。证据不是“我觉得可以”，而是 reviewer 能检查的命令、测试结果、CI run、diff、review
note，或有理由的 “not run” 记录。

## 本地检查

最小有用的 pre-PR loop 是：

```bash
git diff --check
```

公开 docs 改动还要运行：

```bash
npm run harness:check-private-boundary
npm run harness:check-docs-release-map
```

package、CLI、kernel、tool、GUI 或 contract 改动，运行 PR-sized gate：

```bash
npm run check:pr
```

对范围较大的公开改动声明 implementation readiness 前，运行：

```bash
npm run check
```

如果某条命令没跑，PR 必须写清哪条命令跳过、为什么跳过。“不需要”不够；要写明 scope 原因。

## 测试分层

仓库使用分层测试 lane：

| 命令 | 用途 |
| --- | --- |
| `npm run test:fast` | 纯或近纯行为测试。 |
| `npm run test:contract` | public API、schema、跨 package contract。 |
| `npm run test:integration` | CLI、filesystem、store、migration 和较慢行为。 |
| `npm test` | 全量 Node test suite。 |
| `npm run test:gui` | GUI 测试 lane。 |

新增 `packages/**` 或 `tools/**` 测试必须登记到 `tools/test-tier-manifest.mjs`；
runner 设计上会拒绝未分类测试。

## CI lanes

Pull request 运行 `rewrite-ci` workflow。Required PR signals 包括仓库配置里的 typecheck、fast/contract、
integration、boundary、package-policy、GUI build、Node 26 compatibility、supply-chain 和 PR body lint lanes。

完整聚合 `npm run check` lane 保留给 `main`、scheduled run 和 manual dispatch。pull request 上 full-check
job 按设计 skipped 时，不要把它当失败。

## PR 里的证据

PR 模板要求填写：

- base `origin/main` SHA 和 merge-base；
- 最近一次 fetch 时间和同步方式；
- public diff command；
- 本地验证命令；
- GitHub Actions `rewrite-ci` run URL；
- reviewer evidence 和 blocking findings；
- residual risk。

如实填写这些字段。空 verification section 会拖慢 review，因为 maintainer 必须从零重建证据。

## 检查失败时

检查失败时：

1. 读失败内容，不只看 job 名字。
2. 修 PR branch。
3. 重跑能证明修复成立的最小本地命令。
4. 正常 push，等待 CI 重跑。

不要 force-push 或 direct-push 到 `main` 来逃避失败。失败的 gate 是贡献的一部分，解决它也是工作的一部分。
