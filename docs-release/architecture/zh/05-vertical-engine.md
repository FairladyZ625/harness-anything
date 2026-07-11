# 场景合同：声明引擎

[扩展模型](../../learn/zh/04-verticals-and-extension.md)许下一个承诺：你可以加一百个领域概念,内核代码一行都不用动,因为场景合同是一份声明式工件,而不是编译出来的代码。这一页展示这份工件和读它的引擎:`vertical.json` 要通过哪个 schema 校验,以及引擎怎么把这份 JSON 变成实体种类、具体化的文档,和一个搭好的仓库。

## 工件:一个 JSON,一个 schema

一个场景合同就是单个 `vertical.json` 文件。引擎动手之前,这份文件会先经过 `packages/kernel/src/schemas/vertical-definition.ts` 里的 `VerticalDefinitionSchema` 校验。这个 schema 用 effect-Schema 写成,所以校验是完全的:一份不合法的场景合同,会在任何目录被碰到之前就被拒绝,而不是搭到一半才暴露出来。

场景合同必须声明的顶层形状是固定的。下面每个字段都是这个结构体的必需成员(标注除外):

| 字段 | 声明了什么 |
|------|------------|
| `schema` | 字面量 `"vertical-definition/v1"`——一个版本戳 |
| `id`、`title`、`version` | 场景合同的身份(`"software/coding"` 等) |
| `entityKinds[]` | 这个领域关心的种类,每个是 `lifecycle` 或 `schema` |
| `contractEntityKinds[]` | 其中哪些种类是承重的合同实体 |
| `packageScaffolds[]` | 按实体种类,声明它的文档包具体化出哪些文档 |
| `repositoryScaffold` | 顶层目录布局、种子文档、agents 入口 |
| `scripts[]` | 场景合同附带的声明式脚本条目 |
| `templateSelections[]` | 不属于任何文档包的、场景合同级模板选择 |
| `checkerProfile` | 守护这个场景合同的检查器档案的名字 |
| `projectionSchemas[]` | 投影用来校验行的前置元数据 schema |

引擎从不自己编造这些东西;它读的就是 JSON 声明的内容。这一页接下来走一遍承载业务的四个部分:实体种类、模板选择、仓库脚手架,和 agents 入口。

## Preset profile 声明 completion gates

vertical 定义领域；选中的 preset/profile 定义某个 Task 适用哪些确定性 completion gate。
`preset-manifest/v2` 的每个 profile 都必须携带 `completionGates`，即使它是显式空数组。
kernel 只校验可移植的非空 gate-ID 语法；application 拥有已实现 ID，并拒绝未知或重复 gate。
内置 coding profile 声明 `ci` 与 `code-doc-reconciliation`；其他 profile 可以两者都不声明，
所以 `--ci` 是 coding 契约的要求，不是 CLI 的全局要求（ADR-0027 D7）。

真实 Task 的 preset/profile 无法解析，或用 v1 preset 提供 completion contract 时，完成路径会
fail closed。文档化的 legacy metadata fallback 保留旧 task 行为，但新的 v2 manifest 必须明确
声明契约，不能依赖 fallback（ADR-0027 D7）。

## 实体种类:生命周期 vs. schema

`entityKinds[]` 是一个可辨识联合(discriminated union)。每一项是两种形状之一,由 `entityType` 字段来区分:

- **生命周期(lifecycle)**种类声明 `packageKind`——它的文档包所依据的前置元数据合同(`task-package/v2`、`decision-package/v1`)。生命周期种类会拿到一个完整的文档包。
- **schema** 种类声明 `schemaRef`——一个指向字段 schema 的指针(`schema://fact-record`),仅此而已。schema 种类约束字段;它不拿文档模板。

当一个种类是承重的时候,两者都带 `contractEntity: true`。在真实的 `software/coding` 场景合同里,这个联合正好解析成三条:`task` 和 `decision` 是生命周期种类,`fact` 是 schema 种类,三者又都列进了 `contractEntityKinds`。这个映射——生命周期拿到文档包,schema 只拿到字段——正是 [learn/04](../../learn/zh/04-verticals-and-extension.md) 描述的那套拆分,在这里表达为一个 schema 联合的两条分支。

## 模板选择:从 slot 到文档

**模板选择(template selection)**是引擎判断把哪份文档写到哪里的依据。`TemplateSelectionSchema` 有四个必需成员,外加一个可选守卫:

```text
slot            文档角色的稳定名字      ("task.plan")
templateRef     从哪份目录模板取用      ("template://planning/task-plan@1")
materializeAs   落到磁盘上的文件名       ("task_plan.md")
localePolicy    怎么挑语言正文           { prefer, fallback }
requiredWhen    可选的键/值选择守卫
```

语言策略就住在 `localePolicy` 里。`prefer` 是 `project`、`preset`、`explicit` 之一——引擎查找语言偏好的顺序;`fallback` 是字面量 `zh-CN` 或 `en-US`,当首选语言缺失时降级到的正文。模板正文本身住在场景合同的 `template-catalog.json` 里;目录里每份文档都列出 `zh-CN` 和 `en-US` 两个语言,各自带一个 `bodyPath`。所以一条选择声明的是 slot 和策略;真正的本地化文本由目录持有。如果首选语言没有正文,引擎会具体化 fallback,而不是产出一份残缺的文档。

在 `software/coding` 场景合同里,`task` 文档包脚手架列了六条选择——`task_plan.md`、`progress.md`、`facts.md`、`review.md`、`closeout.md`,再加 `artifacts/` 目录的 `.gitkeep` slot——每一条都首选项目语言,fallback 到 `en-US`。Reference 改为按需生成:`reference-task` preset 只在任务需要持久输入快照时,追加现有的本地化 `references/INDEX.md` 模板。`decision` 文档包列的是一个空选择数组:decision 的 `INDEX.md` 由它的文档包合同具体化出来,所以场景合同不再给它添加额外的正文文档。

## 仓库脚手架

`repositoryScaffold` 描述项目采用这个场景合同时,引擎铺下的顶层布局。它有四个部分:

- **`entityRoots[]`**——每个实体种类一条,都是 `{ entityKind, path, create }` 三元组。`path` 是像 `{{paths.tasksRoot}}` 这样的模板,在搭建时解析;`create` 是 `init` 或 `lazy`。`init` 根目录一开始就建好;`lazy` 根目录只在该种类的第一个实体出现时才建。在 `software/coding` 里,task 根是 `init`,decision 根是 `lazy`——task 从一开始就存在,decision 按需到来。
- **`dirs[]`**——普通目录,用同样的 `init`|`lazy` 建立模式,用于那些不是实体根的布局(放辅助文档的目录、上下文树、记录累积的地方)。
- **`seededDocs[]`**——搭建时就放进去的文档。每一份都是一个 `RepositorySeededDoc`:和模板选择相同的 `slot`/`templateRef`/`materializeAs`/`localePolicy` 字段,再加一个可选的 `overwrite` 布尔,决定已存在的文件是否被替换。种子文档就是一个全新仓库为何一到手就已经带好 README 文件和初始文档的原因。
- **`agentsEntry`**——一个可选的复合体,下面细说。

`create: init | lazy` 就是"提前建 vs. 延后建"策略的全部:引擎要么立刻铺下一个目录,要么等第一个占用者出现。

## agents 入口:一个分层复合体

`agentsEntry` 是唯一一个不是"模板直接复制成文件"的具体化。它是三层拼装进单个文件的复合体。`AgentsEntrySchema` 声明:

```text
materializeAs         落成的文件            ("AGENTS.md")
localePolicy          语言选择              { prefer, fallback }
baseRef               第 1 层:基础正文
overlayRef            第 2 层:场景合同叠加层
repoSpecificsAnchor   可选:仓库特定内容追加到哪个标题之下
overwrite             可选
```

引擎把 `baseRef`(基础层)和 `overlayRef`(场景合同叠加层)拼成一份文档。`repoSpecificsAnchor` 指名一个标题——在 `software/coding` 里它是 `"## Repository Specifics"`——仓库本地的内容追加在这个标题之下,而不会重写它上面拼好的两层。所以基础层和叠加层从模板重新生成,而项目写在锚点之下的任何内容,在重新生成时都被保留。这是场景合同 schema 里唯一描述"把一份正文叠到另一份之上"的地方;其他每一处,模板都是一对一映射到文件。

## 脚本与投影 schema

两个更小的数组收尾这份工件。

`scripts[]` 声明场景合同附带的脚本条目——每一条是一个 `{ id, type: "script", command, reads[], writes[], inputs, metadata }` 记录。`reads`/`writes` 数组是 glob 模板(`{{paths.docsRoot}}/**`),声明脚本会碰哪些路径;`metadata.purpose` 是 `scaffold`、`generate`、`transform`、`audit` 之一。在 `software/coding` 里,这些脚本从 decision 渲染文档并种进仓库。声明陈述的是每个脚本读什么、写什么、产出什么;它不内嵌脚本的逻辑。

`projectionSchemas[]` 指名投影用来校验的前置元数据 schema——`schema://task-frontmatter`、`schema://decision-frontmatter`、`schema://fact-record`——把场景合同的实体种类,和[投影](03-projection.md)校验每一行所用的 schema 绑在一起。

## 约定优于声明,落在 schema 上

JSON 之所以能保持精简,靠的是 [learn/04](../../learn/zh/04-verticals-and-extension.md) 点出的那套拆分:引擎只声明它推断不出来的东西,其余全靠检测。这条界线,你能直接从 schema 携带什么、不携带什么里看出来。

**检测——交给约定。** 目录结构、文件是否已存在、一份文档填的是哪个命名 slot、前置元数据是否通过它的 schema——这些全从文件系统里读出来。引擎扫描确认这些,结构不合法就 fail-closed——不合法的 `vertical.json` 永远校验不过,种子文档模板正文缺失也会暴露成一个错误,而不是写出一个空文件。

**声明——纯粹的意图。** 文件系统揭示不出的东西必须陈述,而且仅限这些:一个种类是不是承重的 `contractEntity`、哪个 `checkerProfile` 守护这个场景合同、某个语言缺失时怎么降级(`localePolicy.fallback`)、一个目录是提前还是延后创建(`create`),以及 agents 入口怎么分层(`baseRef`、`overlayRef`、`repoSpecificsAnchor`)。这些是几个字段,不是几段配置。

引擎就是一个在约定之上运作的声明解析器:它校验 JSON、解析路径模板、从目录读出本地化正文、写出脚手架——而且对每一个场景合同,它做的都是同一件事。加一个实体种类、一个文档 slot,或者一整个新领域,你改的是 `vertical.json`。读它的内核,不动。
