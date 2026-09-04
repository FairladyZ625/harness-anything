## Harness CLI (software/coding)

- 使用 `ha <command>` 或 `npx harness-anything <command>`，组装写入前先查看命令帮助。
- 用 `ha task create --title "<title>"` 创建 task package；不要手工搭建 task 目录，并在派工前写实 `task_plan.md` 的每个必填占位，否则 `runtime run` 会以 `plan_placeholder` 拒绝。
- 通过 `ha preset list` 从 effective catalog 选择 preset。标为 unavailable 的 package 不得用于发布 guidance 或创建 task。
- milestone 创建必须显式传入 `--task-class milestone`；preset ID 不推断 task class。
- 带值选项同时接受 `--opt value` 与 `--opt=value`；不支持的选项会以 `unknown_field` 拒绝。
- `runtime run --mission` 接受已同步的 mission 名称而非文件路径；必须先用 `ha doc sync --submit` 提交，否则派工会以 `mission_not_found` 拒绝。
- 收口链序为 start → submit → 独立 `review-execution` → `review-consent` → complete；乱序生命周期操作会是 `invalid_transition`，自己复核会是 `actor_unauthorized`。
- `ha task complete --path` 以项目仓库根为基准解析路径；路径不在已提交 commit 内时以 `invalid_proof` 拒绝。
- complete 前须把 `closeout.md` 写实为固定四节：`## Summary`、`## Verification`、`## Residual Risk`、`## Same Mechanism Elsewhere`，否则以 `closeout_placeholder` 拒绝。

## Repository Scaffolds

- context 位于 `harness/context/`。
- standards 只位于 `harness/governance/standards/`。
- Artifact 源文档通过通用实体描述符定位；milestone 文档与 canonical decision package 保留在配置的 authored root 下。
- 读取各目录自己的 README，不要在此复制规则。

## Architecture-aware Changes

- 广泛搜索源码前，检查 `harness/context/architecture/architecture-manifest.json` 是否存在。
- 存在时先读 architecture README，再只读取相关的 stable view 或 flow，然后选择实现层级。
- 不存在时 architecture 保持 opt-in；普通 coding work 继续执行，不得伪造模型。

## Governance Routing

- 仓库工作流与保留规则：`harness/governance/standards/repository-governance.md`。
- decision 写作：`harness/governance/standards/decision-writing.md`。
- 只加载当前任务适用的 standards。

## Script Discovery

- 使用 `ha script list` 与 `ha script inspect <id>` 查看 vertical script declaration。
- 声明不代表已支持执行。只有 inspect 明确报告 execution available 时才可运行。
