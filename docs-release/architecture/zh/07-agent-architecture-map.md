# 给 coding Agent 一张架构地图

software/coding vertical 可以显式启用一套由仓库自己维护的架构地图。它服务于跨
package、service、写路径或 runtime 边界的修改：Agent 在编辑最近的调用点之前先定位
canonical owner，再用确定性检查把 authored intent 与实际 JavaScript/TypeScript import
进行比较。

这项能力不是 required completion gate。未初始化的仓库继续走普通 coding 流程；其他
vertical 不会加载这些资产和脚本。

## 谁是事实源

模型与代码 snapshot 分工不同：

- `harness/context/architecture/architecture-manifest.json` 选择模型、稳定 source scope、
  view 与固定 extractor。
- `harness/context/architecture/model/**/*.c4` 是人维护的架构意图。组件和关系用稳定的
  `metadata.archId` 标识；显示名称和布局可以变化。
- task 自有的 `artifacts/architecture/architecture-snapshot.json` 是派生代码证据，记录
  公开仓 commit、model/source digest、工具版本、mapping 与 finding。它可以重建，绝不能
  自动反写模型。

节点粒度应是组件或 package，而不是文件海。一个源码路径必须恰好命中一个 scope。只有
代码、ADR/decision 或 runtime 证据支持时才建立关系。

## 显式初始化

在源码 checkout 中安装 lockfile 固定的依赖，并使用当前 workspace 的 CLI build：

```bash
npm ci
npm run build -w @harness-anything/cli
node packages/cli/dist/cli/src/index.js script run \
  vertical:software-coding:architecture-init
```

初始化遵守 no-overwrite：只有所有目标都安全时，才创建 manifest、LikeC4 scaffold，以及
landscape、write-path、runtime 三个 view。生成 snapshot 前，必须用仓库证据替换全部
`draft` placeholder。Harness 不会在 sandbox 内自动安装 LikeC4 或 extractor。

当前 bundled adapter 要求 workspace 固定的版本：

- `likec4@1.58.0`：解析 authored model；
- `dependency-cruiser@17.4.3`：提取 JavaScript/TypeScript import 事实；
- Node.js 24 或更高版本，与仓库 engine contract 一致。

## Snapshot 与检查

Snapshot 归属于拥有这次观察的 task：

```bash
ha script run vertical:software-coding:architecture-snapshot \
  --task <task-id> --json
ha script run vertical:software-coding:architecture-check \
  --task <task-id> --json
```

建立 baseline 时连续运行两次 snapshot。两次的 snapshot digest、source/model digest、
commit 和工具版本应完全一致。检查只返回五种显式状态：

- `not-configured`：仓库没有 opt in；
- `fresh`：commit、source、model、工具和语义比较全部匹配；
- `drifted`：provenance 改变或比较产生 finding；
- `invalid`：manifest、模型、mapping 或 snapshot 非法；
- `tool-missing`：固定的 provider 或 extractor 不可用。

`forbidden-dependency`、`reverse-dependency`、`unexpected-dependency`、
`missing-required-dependency`、`unmapped-*` 与 `architecture-cycle` 都是 review 输入。
应判断是修代码、用证据更新 authored intent，还是建立有 owner 的架构债 task；不能为了变绿
把 import 图直接抄进模型。

## Agent 查询路径

对适用的修改，记录稳定 node、相关 view/flow、直接 incomers/outgoers、选择的修改层级、
snapshot digest 与 ADR/decision 引用。`code-impact-analysis` preset 已提供这些字段。

如果环境已经提供 LikeC4 MCP，Agent 可以使用 element search、view read 与 graph query。
MCP 只是加速器。确定性 fallback 是读取 manifest 和 `.c4` 文本，再运行
`architecture-check`。不能为了完成普通 task 自动安装或启动联网工具。

## 维护与故障恢复

仓库维护者拥有 authored model。source scope、跨组件依赖、provider 输入或固定工具版本变化
后重新生成 snapshot；只改标题或布局时保持 `archId` 稳定。

常见失败都是有意的：

- scaffold placeholder 未清理时，配置返回 `invalid`。
- 全局安装的 `ha` 与更新的 workspace script 可能不处于同一可信 package boundary。应构建并
  调用上面的 workspace CLI，或从该 build 重启本地 daemon；不能扩大 sandbox 权限。
- 递归 architecture read scope 遇到 symlink 会 fail closed，包括嵌套 `node_modules`。生成的
  依赖和 prototype build output 不应放在 authored architecture context 内。
- 工具版本不匹配必须保持可见。运行 `npm ci` 恢复 lockfile 版本，不能静默接受其他 parser。

卸载时，在经过 review 的变更中移除仓库自有的 architecture manifest 与 model，并按仓库的
证据保留策略删除 task snapshot。无需卸载 Kernel entity、数据库记录、CI requirement 或全局配置。
