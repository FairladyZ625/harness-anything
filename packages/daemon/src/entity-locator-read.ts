import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeRelativeDocumentPath } from "../../kernel/src/index.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

/**
 * 实体 locator 的内容读面(task_0df76ed3fb 设计页 §2)。
 *
 * 实体的正文不住在账本里,locator 只是一个指向仓内路径的指针。GUI 要「点击即渲染」,
 * 就需要一条按 locator 取内容的读——既有的文档读面都在 task 包内寻址,取不到
 * `harness/adr/ADR-0020-….md` 这样的仓内任意路径。
 *
 * 边界与 `resolveArtifactSource` 同判据:只接 `repository-path`,归一后必须仍在仓根内,
 * 逃逸即拒。目录返回一层条目(喂既有文件树),文件返回文本;二进制与超限文件 typed
 * 拒绝,不把字节塞进渲染层。本模块不含任何写路。
 */
export const ENTITY_LOCATOR_READ_SCHEMA = "entity-locator-read/v1" as const;

/** 单文件读取上限:与 GUI 本机文档阅读面同一量级,超限给 typed 结果而非卡死渲染。 */
export const ENTITY_LOCATOR_MAX_BYTES = 2 * 1024 * 1024;

/** 目录一层条目上限:超出只截断并如实标注,不静默丢。 */
export const ENTITY_LOCATOR_MAX_ENTRIES = 500;

export class EntityLocatorReadContractError extends Error {
  readonly code = "invalid_result";
  constructor(message: string) {
    super(message);
    this.name = "EntityLocatorReadContractError";
  }
}

export type EntityLocatorOutcome = "file" | "directory" | "missing" | "unsupported" | "too-large" | "binary";

export interface EntityLocatorEntryV1 {
  readonly path: string;
  readonly directory: boolean;
}

export interface EntityLocatorReadV1 {
  readonly schema: typeof ENTITY_LOCATOR_READ_SCHEMA;
  readonly ok: true;
  readonly outcome: EntityLocatorOutcome;
  /** 归一后的仓内相对路径;unsupported 时是原样 locator 值。 */
  readonly path: string;
  readonly content: string | null;
  readonly sizeBytes: number | null;
  readonly entries: readonly EntityLocatorEntryV1[];
  readonly truncated: boolean;
}

export function readEntityLocator(input: {
  readonly rootDir: string;
  readonly locatorKind: string;
  readonly locatorValue: string;
  readonly maxBytes?: number;
}): EntityLocatorReadV1 {
  if (input.locatorKind !== "repository-path") return locatorResult("unsupported", input.locatorValue);
  const relative = normalizeRelativeDocumentPath(input.locatorValue),
    target = path.resolve(input.rootDir, relative),
    rootPrefix = `${path.resolve(input.rootDir)}${path.sep}`;
  if (!target.startsWith(rootPrefix)) return locatorResult("unsupported", relative);
  if (!existsSync(target)) return locatorResult("missing", relative);
  const stats = statSync(target);
  if (stats.isDirectory()) return directoryResult(relative, target);
  const limit = input.maxBytes ?? ENTITY_LOCATOR_MAX_BYTES;
  if (stats.size > limit) return { ...locatorResult("too-large", relative), sizeBytes: stats.size };
  const text = readFileSync(target, "utf8");
  if (text.includes("\u0000")) return { ...locatorResult("binary", relative), sizeBytes: stats.size };
  return { ...locatorResult("file", relative), content: text, sizeBytes: stats.size };
}

function directoryResult(relative: string, target: string): EntityLocatorReadV1 {
  const names = readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const kept = names.slice(0, ENTITY_LOCATOR_MAX_ENTRIES);
  return {
    ...locatorResult("directory", relative),
    entries: kept.map((entry) => ({ path: `${relative}/${entry.name}`, directory: entry.isDirectory() })),
    truncated: names.length > kept.length,
  };
}

function locatorResult(outcome: EntityLocatorOutcome, locatorPath: string): EntityLocatorReadV1 {
  return {
    schema: ENTITY_LOCATOR_READ_SCHEMA,
    ok: true,
    outcome,
    path: locatorPath,
    content: null,
    sizeBytes: null,
    entries: [],
    truncated: false,
  };
}

const outcomes: readonly EntityLocatorOutcome[] = [
  "file",
  "directory",
  "missing",
  "unsupported",
  "too-large",
  "binary",
];

export function validateEntityLocatorRead(value: unknown): readonly string[] {
  if (!isJsonObject(value) || value.schema !== ENTITY_LOCATOR_READ_SCHEMA || value.ok !== true)
    return ["Entity locator read envelope is invalid"];
  const errors: string[] = [];
  if (!outcomes.includes(value.outcome as EntityLocatorOutcome)) errors.push("outcome is invalid");
  if (typeof value.path !== "string" || !value.path) errors.push("path must be a non-empty string");
  if (value.content !== null && typeof value.content !== "string") errors.push("content must be a string or null");
  if (value.outcome === "file" && typeof value.content !== "string") errors.push("file outcome requires content");
  if (value.outcome !== "file" && value.content !== null) errors.push("only a file outcome carries content");
  if (value.sizeBytes !== null && (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0))
    errors.push("sizeBytes must be a non-negative integer or null");
  if (!Array.isArray(value.entries)) errors.push("entries must be an array");
  else if (value.outcome !== "directory" && value.entries.length > 0)
    errors.push("only a directory outcome carries entries");
  else
    for (const [index, entry] of value.entries.entries())
      if (!isJsonObject(entry) || typeof entry.path !== "string" || typeof entry.directory !== "boolean")
        errors.push(`entries[${index}]: entry must carry path and directory`);
  if (typeof value.truncated !== "boolean") errors.push("truncated must be a boolean");
  return errors;
}

export function serializeEntityLocatorRead(value: unknown): string {
  const errors = validateEntityLocatorRead(value);
  if (errors.length) throw new EntityLocatorReadContractError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
