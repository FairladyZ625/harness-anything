import type { GuiActionResult } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import type { EntityLocator } from "./entity-locator-renderer.ts";

/**
 * 实体 locator 的内容读 + 声明实体的新建写。
 *
 * 读:`repo.entity.locator.read` 按 locator 取仓内内容(文件文本 / 目录一层条目)。
 * 写:`repo.entity.import` 就是 CLI `ha entity import` 的那条 center 单写路,GUI 不另开。
 */
export type EntityLocatorOutcome = "file" | "directory" | "missing" | "unsupported" | "too-large" | "binary";

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
  }) => Promise<unknown>;
};

const bridge = (): Partial<LocatorBridge> => (window.harness as unknown as Partial<LocatorBridge> | undefined) ?? {};

export async function readEntityLocatorContent(repoId: string, locator: EntityLocator): Promise<EntityLocatorContent> {
  const channel = bridge().readEntityLocator;
  if (!channel) throw new Error("Entity locator bridge is unavailable.");
  const value = await channel({ repoId, locatorKind: locator.kind, locatorValue: locator.value });
  if (!isRendererRecord(value) || value.schema !== "entity-locator-read/v1" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity locator bridge returned an invalid result."));
  return value as unknown as EntityLocatorContent;
}

export interface EntityImportInput {
  readonly repoId: string;
  readonly entityKind: string;
  readonly locator: string;
  readonly title?: string;
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
  });
  if (!isRendererRecord(value) || value.schema !== "command-receipt/v2" || typeof value.outcome !== "string")
    throw new Error(rendererErrorHint(value, "Entity import bridge returned an invalid result."));
  return value as unknown as GuiActionResult;
}
