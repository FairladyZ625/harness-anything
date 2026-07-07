# 17 · Effect TS 实现合同

- **状态**: canonical implementation contract
- **日期**: 2026-06-10
- **外部依据**: Effect 官方文档：Schema、Services、Layers、Queue、Semaphore。
- **工具链锚点(2026-06-11,以根 package.json 为准)**: `effect` 3.21.x、TypeScript 5.9.x、Node ≥24(`node --test` + type stripping;全包 `erasableSyntaxOnly`)。升级需过 `npm run check` 后单独提交。

## 1. 为什么使用 Effect

CAH rewrite 的高风险点集中在：typed error、外部 adapter decode、并发写、资源生命周期、可替换实现、CLI composition root。Effect 的优势正好对应这些问题：

- `Effect<A, E, R>` 显式表达成功值、错误通道、依赖环境；
- `Layer`/Service 可表达三端口及其实现注入；
- `Schema` 可在边界 decode/encode/assert；
- `Queue`/`Semaphore` 可建模 WriteCoordinator；
- Scope/Resource 管理适合文件锁、SQLite connection、临时目录、child process。

## 2. 分层使用规则

| 层 | 是否可用 Effect | 规则 |
| --- | --- | --- |
| `kernel/domain` | 尽量不用；允许纯类型/Schema/ADT | 纯函数、零 IO、零 Layer。 |
| `kernel/ports` | 是 | 定义 Service tags、DTO、错误类型、Schema。 |
| `kernel/application` | 是 | 编排 use case；依赖 ports；不 import 实现。 |
| `adapters/*` | 是 | adapter decode、retry、timeout、CLI child process。 |
| `store/*` | 是 | 文件 IO、lock、journal、SQLite resource。 |
| `cli` | 是 | composition root，把 Layer 组起来运行。 |

## 3. Port as Service

```ts
import { Effect, Context, Schema } from "effect"

export class LifecycleEngine extends Context.Tag("LifecycleEngine")<
  LifecycleEngine,
  {
    readonly name: EngineId
    readonly capabilities: Effect.Effect<EngineCaps, never>
    readonly snapshot: (ref: TaskRef) => Effect.Effect<TaskSnapshot, EngineError>
    readonly listTasks?: (filter: TaskFilter) => Effect.Effect<ReadonlyArray<TaskSnapshot>, EngineError>
    readonly publishNote?: (ref: TaskRef, note: PublishableProjection) => Effect.Effect<NoteRef, EngineError>
  }
>() {}
```

硬规则：

- `LifecycleEngine` 无 `transition` / `assign` / `rerun` / `cancel`。
- local 状态命令属于 `LocalLifecycleCommandService`，只在 `adapters/local` 暴露给 CLI application use case；不进入 provider-neutral port。
- 外部 adapter 的 `publishNote` 是 optional advisory write，不得被 closeout readiness 或 done 判定依赖。

## 4. Schema 边界

所有外部输入都必须 decode：

```ts
export const DomainStatus = Schema.Literal(
  "planned", "active", "blocked", "in_review", "done", "cancelled"
)

export const SnapshotStatus = Schema.Union(
  DomainStatus,
  Schema.Literal("unknown")
)

export const TaskSnapshot = Schema.Struct({
  canonicalStatus: SnapshotStatus,
  rawStatus: Schema.String,
  freshness: Schema.Literal("fresh", "stale-but-usable", "unavailable-no-cache"),
  fetchedAt: Schema.String,
  expiresAt: Schema.optional(Schema.String),
  staleReason: Schema.optional(Schema.String),
  source: Schema.Literal("local-document", "external-engine", "snapshot-cache"),
  engine: Schema.String,
  ref: Schema.optional(Schema.String),
  assignee: Schema.optional(Schema.String),
  parentRef: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String)
})
```

必须 decode 的边界：

- `harness.yaml`
- Task `INDEX.md` frontmatter
- external adapter raw JSON
- SQLite projection rows read back from DB
- journal/WAL entries
- PublishableProjection
- template catalog

Duplicate external binding detection is not a `LifecycleEngine` method. It is a local `ArtifactStore.findBindingByExternalRef` query over authored Task frontmatter:

```ts
findBindingByExternalRef(engine: EngineId, ref: ExternalRef): Effect.Effect<Option.Option<TaskId>, StoreError>
```

## 5. Error ADT

错误不可用 string throw：

```ts
type EngineError =
  | { readonly _tag: "EngineNotEnabled"; readonly engine: string }
  | { readonly _tag: "AdapterUnavailable"; readonly engine: string; readonly cause?: unknown }
  | { readonly _tag: "AuthMissing"; readonly engine: string }
  | { readonly _tag: "RefNotFound"; readonly ref: string }
  | { readonly _tag: "MalformedSnapshot"; readonly raw: unknown }
  | { readonly _tag: "StatusUnmapped"; readonly rawStatus: string }
  | { readonly _tag: "EngineOwnsStatus"; readonly engine: string; readonly ref: string }
  | { readonly _tag: "RateLimited"; readonly engine: string; readonly retryAfterMs?: number }
  | { readonly _tag: "EngineUnreachable"; readonly engine: string; readonly cause?: unknown }
  | { readonly _tag: "Timeout"; readonly ms: number }
```

CLI output 把 ADT 映射成稳定 `code`，不要反过来让 domain 依赖 CLI code。

**构造形式(2026-06-11 锁定,Slice 1 `errors.ts` 即用)**:错误类型分两层——

- `kernel/src/domain/errors.ts`:**plain readonly object + `_tag` 判别联合**(如上),零依赖、可结构化序列化,domain 不引入 Effect 类层级;
- `kernel/src/ports` 及以下(application/store/adapters):允许用 `Data.TaggedError` 包装 domain 错误以获得 Effect channel 集成,但 `_tag` 词表与 domain 定义逐字一致,catch 侧只依赖 `_tag` 判别,不依赖 instanceof。

## 6. WriteCoordinator shape

```ts
export class WriteCoordinator extends Context.Tag("WriteCoordinator")<
  WriteCoordinator,
  {
    readonly enqueue: (op: WriteOp) => Effect.Effect<Ack, WriteError>
    readonly flush: (reason: FlushReason) => Effect.Effect<FlushReport, WriteError>
    readonly recover: Effect.Effect<RecoveryReport, WriteError>
  }
>() {}
```

Implementation hints：

- `Queue<WriteOp>` 只承载内存排队；durability 来自 journal append。
- `Semaphore` / file lock 保证 same-task FIFO 与 single committer。
- `Scope` 管理 lock release、SQLite connection、temporary files。
- `flush` 内部顺序：apply ops → git add touched → commit → incremental projection rebuild → watermark advance → archive journal segment。

## 7. Testing with Effect

- Service contract tests 使用 in-memory Layer；store tests 使用 temp directory Layer。
- External adapters 使用 fixture Layer，不打真实网络。
- Time-sensitive stale tests 使用 controllable clock；不要在测试里 sleep。
- Crash recovery tests 用 child process 或 explicit journal partial flush fixture。

## 8. 禁止模式

- `Effect.runPromise` 出现在 domain/application 内部；只能在 CLI composition root。
- adapter 返回 `any` 并在上层再猜字段。
- `catchAll` 吞掉 `StatusUnmapped` 并返回 active。
- Store 直接 import Engine 实现。
- CLI 直接写 frontmatter 绕过 WriteCoordinator。
- public publish API 接收 raw markdown body。
