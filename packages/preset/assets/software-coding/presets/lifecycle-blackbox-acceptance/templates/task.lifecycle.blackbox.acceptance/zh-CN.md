# {{title}} — 生命周期黑盒验收

## Consumer Contract

你是未读源码的 Consumer owner/executor。必须由另一个不同 principal 担任独立
reviewer：Consumer/owner/executor 不得撰写该 review，reviewer 也不得提供 owner
consent 或完成 Task。只允许通过 `ha --help`、`ha <command> --help` 与 `ha explain`
发现 CLI；可以执行从这些公开表面发现的生命周期命令。

源码盲的含义是禁止读取、搜索、列举或检查仓库源码路径，包括 `packages/`、
`tools/`、`docs-release/` 和任何其他 Harness Anything 源码路径；禁止用源码级先验
知识猜测命令或 payload 字段。可以使用任意编辑器读取或编辑仅属于该一次性 Task 的
harness 文档（`task_plan.md`、`closeout.md` 与该 Task `artifacts/` 目录中的文件），
之后在需要时走文档化的 CLI sync 流程。

## Isolated Setup

只在派工方提供的一次性仓库中工作。先确认当前目录，在该目录执行 `ha init`，
不得访问或修改其他仓库的台账。创建任务时选用无 gate 的 preset，避免把本地 CI
混入本次 CLI 验收。

## Hooks Negative Case

在 happy path 前，只用获准的发现表面判断：已声明的 hook 是否能挂接到 runtime
dispatch 并在运行时到达。原样记录发现命令与输出。预期观察是：hook 可以存在于
声明面，但公开 runtime 工作流没有可到达的 hook 桥。不得绕过这一缺口，也不得
通过修改配置或源码制造桥。

## Lifecycle Scenario

以 Consumer owner/executor 身份创建一个一次性 Task，启动 Execution，追加带
evidence 的 progress，并提交完整的 typed result。必须由不同身份的独立 reviewer
记录 approved review；Consumer/owner 随后提供所需的 owner consent 并完成 Task。
跟随命令回执及其 next-step 指引，在转换之间执行 `ha task show`；只有规范 Task
status 为 `done` 才算完成。

若公开 CLI 无法发现、回执缺少下一必需步骤、或 help/schema/receipt 的字段名不一致，
在第一个 CLI 表面缺陷处停止并原样报告。若失败属于 lifecycle、authority、storage
或 runtime 缺陷，立即停止且不得绕过。

## Evidence

返回每条命令及其未编辑输出的时间顺序记录、创建的 Task 与 Execution id、首个失败
分类（如有）和最终 Task projection；解码每个 tool-call payload，并给出清单证明其中
不含任何仓库源码路径（包括 `packages/`、`tools/`、`docs-release/`）。不得把原始
JSONL 文本 grep 当作判据：约束文本和 Task 自有文档的内容可以为说明边界而合法提及
这些路径。
