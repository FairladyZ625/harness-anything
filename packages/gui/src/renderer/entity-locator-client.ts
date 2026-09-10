import type { GuiActionResult } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import type { EntityLocator, EntityLocatorReadOutcome } from "./entity-locator-renderer.ts";

/**
 * 实体 locator 的内容读 + 声明实体的新建写。
 *
 * 读:`repo.entity.locator.read` 按 locator 取仓内内容(文件文本 / 目录一层条目)。
 * 写:`repo.entity.import` 就是 CLI `ha entity import` 的那条 center 单写路,GUI 不另开。
 */
/** 读面 outcome 的词表住在渲染器选择表那一侧:选表按它分支,这里只是同一个词表的别名。 */
export type EntityLocatorOutcome = EntityLocatorReadOutcome;

export interface EntityLocatorContent {
  readonly outcome: EntityLocatorOutcome;
  readonly path: string;
  readonly content: string | null;
  readonly sizeBytes: number | null;
  readonly entries: readonly { readonly path: string; readonly directory: boolean }[];
  readonly truncated: boolean;
}

type LocatorBridge = {
  readonly readEntityLocator: (payload: {
    readonly repoId: string;
    readonly locatorKind: string;
    readonly locatorValue: string;
  }) => Promise<unknown>;
  readonly importEntity: (payload: {
    readonly repoId: string;
    readonly entityKind: string;
    readonly locator: string;
    readonly expectedVersion: number;
    readonly title?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  readonly updateEntity: (payload: {
    readonly repoId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly expectedVersion: number;
    readonly title?: string;
    readonly locator?: string;
    readonly contentVersion?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  readonly archiveEntity: (payload: {
    readonly repoId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }) => Promise<unknown>;
  readonly deleteEntity: (payload: {
    readonly repoId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly expectedVersion: number;
    readonly reason: string;
  }) => Promise<unknown>;
};

const bridge = (): Partial<LocatorBridge> => (window.harness as unknown as Partial<LocatorBridge> | undefined) ?? {};

/**
 * locator 正文读的 query 声明。渲染面与深链接预取共用同一份 key / 读函数 / 新鲜度 /
 * 适用判定,不在两处各拼一份——两处拼出不同的 key 就会各读一次,拼出不同的适用
 * 判定就会给渲染不了的指针白发一次 IPC。
 */
export function entityLocatorContentQuery(repoId: string, locator: EntityLocator) {
  return {
    queryKey: ["entity-locator", repoId, locator.kind, locator.value] as const,
    queryFn: () => readEntityLocatorContent(repoId, locator),
    // 只有仓内路径指针能读出正文;别的指针走元数据卡,没有可读的内容。
    enabled: locator.kind === "repository-path",
    staleTime: 4_000,
  };
}

export async function readEntityLocatorContent(repoId: string, locator: EntityLocator): Promise<EntityLocatorContent> {
  const channel = bridge().readEntityLocator;
  if (!channel) throw new Error("Entity locator bridge is unavailable.");
  const value = await channel({ repoId, locatorKind: locator.kind, locatorValue: locator.value });
  if (!isRendererRecord(value) || value.schema !== "entity-locator-read/v1" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity locator bridge returned an invalid result."));
  return value as unknown as EntityLocatorContent;
}

/**
 * 目录列举的 query 声明。路径选择器与目录树的懒展开共用这一份 key / 读函数 / 新鲜度
 * ——两处各拼一份就会出现「同目录双读」或「展开态与缓存态错位」。
 *
 * 注意读面边界:仓根本身列举不了(空路径/`.` 被读面拒绝),浏览器的起点必须是一个
 * 真实子目录;`entries` 只有一层,子目录的条目靠对子路径再发同一条读。
 */
export function repoDirectoryQuery(repoId: string, directoryPath: string) {
  return {
    queryKey: ["entity-locator", repoId, "repository-path", directoryPath] as const,
    queryFn: () => readEntityLocatorContent(repoId, { kind: "repository-path", value: directoryPath }),
    staleTime: 4_000,
  };
}

export interface EntityImportInput {
  readonly repoId: string;
  readonly entityKind: string;
  readonly locator: string;
  readonly title?: string;
  /** 按实例钉住的那一版属性声明填出来的值;这个种类没有声明属性时不递。 */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * 新建 = 首次 import,因此 expectedVersion 恒为 0(新实体没有既有 revision)。
 * 撞上已存在的同一 locator 时,center 的 revision fence 会以 op_rejected 回报冲突;
 * GUI 如实显示这个结果,不重试、不改写 expectedVersion。
 */
export async function importEntity(input: EntityImportInput): Promise<GuiActionResult> {
  const channel = bridge().importEntity;
  if (!channel) throw new Error("Entity import bridge is unavailable.");
  const value = await channel({
    repoId: input.repoId,
    entityKind: input.entityKind,
    locator: input.locator,
    expectedVersion: 0,
    ...(input.title ? { title: input.title } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  });
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity import bridge returned an invalid result."));
  return value as unknown as GuiActionResult;
}

async function mutationResult(channel: ((payload: never) => Promise<unknown>) | undefined, payload: object) {
  if (!channel) throw new Error("Entity mutation bridge is unavailable.");
  const value = await channel(payload as never);
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity mutation bridge returned an invalid result."));
  return value as unknown as GuiActionResult;
}

/**
 * 描述符更新。属性值按**这个实例钉住的那一版**声明填,版本号与当前值都来自行读面
 * (`repo.entity.rows.read` 的 `descriptor`),不由这里推断——中心按它真正钉的那一版判定,
 * 猜一版就是把人填的值送去被拒。
 */
export function updateEntity(input: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly locator?: string;
  readonly contentVersion?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}): Promise<GuiActionResult> {
  return mutationResult(bridge().updateEntity as ((payload: never) => Promise<unknown>) | undefined, input);
}

export function archiveEntity(input: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}): Promise<GuiActionResult> {
  return mutationResult(bridge().archiveEntity as ((payload: never) => Promise<unknown>) | undefined, input);
}

/**
 * 删除:描述符与这个实体收管的每一份文件一起退役。归档留下它们,删除不留——两件不同的
 * 事各有一条中心动作,GUI 不把其中一条当另一条用。
 *
 * 退役的只有**这个实体自己那一份**:来源文件不归它所有,中心的接受清单里也没有它,
 * 所以删这个实体不会动到来源,也不会动到别的实体引用的东西。
 */
export function deleteEntity(input: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}): Promise<GuiActionResult> {
  return mutationResult(bridge().deleteEntity as ((payload: never) => Promise<unknown>) | undefined, input);
}

/** 回执不是 applied/no_changes 时的人话:优先中心给的 rejectionExplanation,否则报 outcome+code。 */
export function receiptFailureText(receipt: { readonly outcome: string; readonly [key: string]: unknown }): string {
  const explanation = receipt.rejectionExplanation;
  const code = receiptCode(receipt);
  return typeof explanation === "string" && explanation.length > 0
    ? explanation
    : `命令返回 ${receipt.outcome}${code ? `(${code})` : ""}。`;
}

/**
 * 一份实体写回执落到哪一态。**`ok` 不是判据**——中心接受了一次写,和这次写已经在 canonical
 * 可见,是两件事,回执把它们分开说了:`outcome` 说中心怎么处置这次意图,`proof.canonicalVisible`
 * 说落定的那一刀有没有推进到能读出来。界面把这两件事合成一句「成功」,人就分不清「已生效」
 * 与「已接受、还没到」。
 *
 * - `applied`:中心接受,并且已经在 canonical 可见。`no_changes` 是同一意图的重放,同样落定。
 * - `pending`:中心接受了,canonical 还没跟上(回执带 opId,凭它查,不重放这次写)。
 * - `conflict`:这一条在你读到它之后被别人改过,fence 因此不成立。重读再改,不是重试。
 * - `rejected`:中心拒了这次意图本身,理由用中心自己的话。
 *
 * 连接断掉/超时那一类**不是拒绝**:没有回答就说不出中心做了什么,只能按 pending 处理。
 */
export type EntityWriteState = "applied" | "pending" | "conflict" | "rejected";

export interface EntityWriteSettlement {
  readonly state: EntityWriteState;
  readonly opId: string | null;
  /** 界面可以直接显示的一句话;`applied` 也有,因为「已生效」本身要被说出来。 */
  readonly text: string;
}

const CONFLICT_CODES = ["revision_conflict", "version_conflict", "op_conflict"];
/**
 * 这一批码说的是**没拿到中心的回答**,不是中心拒了这次意图:连接断了、请求超时、根本没连上。
 * 写有没有落定,回答不了的一方是调用者——所以它是 indeterminate,不是 rejected。
 * 把它说成「被拒」,人会照着「没写进去」去重发;而这次写可能已经被接受了。
 */
const UNANSWERED_CODES = [
  "daemon_closed",
  "daemon_response_timeout",
  "daemon_request_failed",
  "daemon_unavailable",
  "ECONNRESET",
];

export function entityWriteSettlement(receipt: {
  readonly outcome: string;
  readonly [key: string]: unknown;
}): EntityWriteSettlement {
  const opId = typeof receipt.opId === "string" && receipt.opId !== "N/A" ? receipt.opId : null,
    code = receiptCode(receipt),
    proof = receipt.proof as { readonly canonicalVisible?: unknown } | undefined;
  if (receipt.outcome === "applied" || receipt.outcome === "no_changes") {
    // 老回执可以完全不带 proof;那种回执说不出可见性,按它说得出的那一层(已接受)算落定。
    if (proof === undefined || proof.canonicalVisible !== false) return { state: "applied", opId, text: "已生效。" };
    return {
      state: "pending",
      opId,
      text: `已被中心接受,canonical 还没读到这一刀${opId ? `;凭 ${opId} 查回执,不要重发。` : "。"}`,
    };
  }
  if (receipt.outcome === "pending" || receipt.outcome === "indeterminate")
    return {
      state: "pending",
      opId,
      text: `中心尚未给出结果${opId ? `;凭 ${opId} 查回执,不要重发。` : "。"}`,
    };
  if (code !== null && CONFLICT_CODES.includes(code))
    return { state: "conflict", opId, text: `${receiptFailureText(receipt)}这一条已经被改过,请重新读取后再改。` };
  if (code !== null && UNANSWERED_CODES.includes(code))
    return {
      state: "pending",
      opId,
      text: `没拿到中心的回答(${code}):这次写可能已经落定,也可能没有。重新读取这一条再决定,不要直接重发。`,
    };
  return { state: "rejected", opId, text: receiptFailureText(receipt) };
}

/** 回执里的错误码:中心把它放在顶层,授权面另外包一层 `error.code`。 */
function receiptCode(receipt: { readonly [key: string]: unknown }): string | null {
  const nested = (receipt.error as { readonly code?: unknown } | undefined)?.code;
  if (typeof nested === "string" && nested) return nested;
  return typeof receipt.code === "string" && receipt.code ? receipt.code : null;
}
