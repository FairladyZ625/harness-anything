# {{title}} — 生命周期黑盒验收

## Consumer Contract

你是未读源码的 Consumer。只允许通过 `ha --help`、`ha <command> --help` 与
`ha explain` 发现 CLI；可以执行从这些公开表面发现的生命周期命令。禁止读取、
搜索、列举或检查 `packages/` 及任何 Harness Anything 源文件；禁止用源码级先验
知识猜测命令或 payload 字段。

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

创建一个一次性 Task，启动 Execution，追加带 evidence 的 progress，提交完整的
typed result，记录独立的 approved review，提供所需的 owner consent，最后完成
Task。跟随命令回执及其 next-step 指引，在转换之间执行 `ha task show`；只有规范
Task status 为 `done` 才算完成。

若公开 CLI 无法发现、回执缺少下一必需步骤、或 help/schema/receipt 的字段名不一致，
在第一个 CLI 表面缺陷处停止并原样报告。若失败属于 lifecycle、authority、storage
或 runtime 缺陷，立即停止且不得绕过。

## Evidence

返回每条命令及其未编辑输出的时间顺序记录、创建的 Task 与 Execution id、首个失败
分类（如有）和最终 Task projection；另给出足以证明从未读取 `packages/` 路径的
tool-call 清单。
