import { existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import type { EngineError, WriteError } from "../../../../kernel/src/index.ts";
import { resolveTaskSchema } from "../../../../kernel/src/index.ts";
import { taskDocumentPath } from "../../../../kernel/src/index.ts";
import { readFrontmatter, readScalar } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { bundledVerticalDefinition } from "../extensions/bundled.ts";

type TaskAmendAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-amend" }>;
type BundledVertical = NonNullable<ReturnType<typeof bundledVerticalDefinition>>;

export function runTaskAmend(
  context: CommandRunnerContext,
  action: TaskAmendAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const indexPath = taskDocumentPath(context.layoutInput, action.taskId, "INDEX.md");
    if (!existsSync(indexPath)) return taskAmendInvalid(action.taskId, `task not found: ${action.taskId}`, CliErrorCode.TaskNotFound);

    const body = readFileSync(indexPath, "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter) return taskAmendInvalid(action.taskId, `INDEX.md missing frontmatter: ${action.taskId}`, CliErrorCode.MalformedSnapshot);

    const vertical = bundledVerticalDefinition(readScalar(frontmatter, "vertical"));
    const extensionByField = new Map((vertical?.entityFieldExtensions ?? [])
      .filter((extension) => extension.extends === "task")
      .map((extension) => [extension.field, extension]));
    for (const patch of action.patches) {
      const extension = extensionByField.get(patch.field);
      if (!extension) return taskAmendInvalid(action.taskId, `task field is not declared by the active vertical: ${patch.field}`);
      if (extension.mutability !== "amendable") return taskAmendInvalid(action.taskId, `task field is not amendable: ${patch.field}`);
    }

    let nextFrontmatter: string;
    try {
      nextFrontmatter = action.patches.reduce(
        (current, patch) => upsertFrontmatterScalar(current, patch.field, patch.value),
        frontmatter
      );
    } catch (error) {
      return taskAmendInvalid(action.taskId, error instanceof Error ? error.message : "invalid task amend patch");
    }
    const validationError = validateTaskFrontmatter(nextFrontmatter, vertical);
    if (validationError) return taskAmendInvalid(action.taskId, validationError);

    const result = yield* context.engine.replaceTaskDocument({
      taskId: action.taskId,
      path: "INDEX.md",
      body: replaceFrontmatter(body, frontmatter, nextFrontmatter)
    });
    return {
      ok: true,
      command: "task-amend",
      taskId: result.taskId,
      path: result.path,
      report: {
        schema: "task-amend-report/v1",
        fields: action.patches.map((patch) => patch.field)
      }
    } satisfies CliResult;
  });
}

function taskAmendInvalid(taskId: string, hint: string, code: CliErrorCode = CliErrorCode.InvalidTaskMetadata): CliResult {
  return {
    ok: false,
    command: "task-amend",
    taskId,
    error: cliError(code, hint)
  };
}

function validateTaskFrontmatter(frontmatter: string, vertical: BundledVertical | undefined): string | undefined {
  if (!vertical) return "active task vertical definition was not found.";
  try {
    Schema.decodeUnknownSync(resolveTaskSchema(vertical))(taskFrontmatterObject(frontmatter, vertical));
    return undefined;
  } catch {
    const invalidExtension = (vertical.entityFieldExtensions ?? []).find((extension) => {
      const value = readScalar(frontmatter, extension.field);
      return value.length > 0 && !extension.values.includes(value);
    });
    if (!invalidExtension) return "task frontmatter failed vertical-aware schema validation.";
    const value = readScalar(frontmatter, invalidExtension.field);
    return `invalid enum value for ${invalidExtension.field}: ${value}; expected one of ${invalidExtension.values.join(", ")}`;
  }
}

function taskFrontmatterObject(frontmatter: string, vertical: BundledVertical): Record<string, unknown> {
  return {
    schema: readScalar(frontmatter, "schema", { required: true }),
    task_id: readScalar(frontmatter, "task_id", { required: true }),
    title: readScalar(frontmatter, "title", { required: true }),
    ...optionalScalar(frontmatter, "parent"),
    lifecycle: {
      bindingSchema: readScalar(frontmatter, "  bindingSchema", { required: true }),
      engine: readScalar(frontmatter, "  engine", { required: true }),
      ...optionalScalar(frontmatter, "  status", "status"),
      ref: nullIfEmpty(readScalar(frontmatter, "  ref", { required: true })),
      titleSnapshot: nullIfEmpty(readScalar(frontmatter, "  titleSnapshot", { required: true })),
      url: nullIfEmpty(readScalar(frontmatter, "  url", { required: true })),
      bindingCreatedAt: readScalar(frontmatter, "  bindingCreatedAt", { required: true }),
      bindingFingerprint: readScalar(frontmatter, "  bindingFingerprint", { required: true })
    },
    packageDisposition: readScalar(frontmatter, "packageDisposition", { required: true }),
    ...optionalScalar(frontmatter, "workKind"),
    ...optionalScalar(frontmatter, "riskTier"),
    ...optionalScalar(frontmatter, "urgency"),
    vertical: readScalar(frontmatter, "vertical", { required: true }),
    preset: readScalar(frontmatter, "preset", { required: true }),
    provenance: readProvenance(frontmatter),
    ...optionalScalar(frontmatter, "profile"),
    ...readCreatedByObject(frontmatter),
    ...taskFieldExtensionObject(frontmatter, vertical)
  };
}

function optionalScalar(frontmatter: string, key: string, outputKey = key.trim()): Record<string, string> {
  const value = readScalar(frontmatter, key);
  return value.length > 0 ? { [outputKey]: value } : {};
}

function taskFieldExtensionObject(frontmatter: string, vertical: BundledVertical): Record<string, string> {
  return Object.fromEntries((vertical.entityFieldExtensions ?? []).flatMap((extension) => {
    const value = readScalar(frontmatter, extension.field);
    return value.length > 0 ? [[extension.field, value]] : [];
  }));
}

function readProvenance(frontmatter: string): ReadonlyArray<Record<string, string>> {
  const block = frontmatter.match(/^provenance:\r?\n((?:[ \t]+-\s*\{[^\r\n]*\}(?:\r?\n|$))*)/mu)?.[1] ?? "";
  return [...block.matchAll(/-\s*\{([^}]*)\}/gmu)].map((match) => parseFlowObject(match[1] ?? ""));
}

function readCreatedByObject(frontmatter: string): Record<string, { readonly name: string; readonly email: string }> {
  const block = frontmatter.match(/^createdBy:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/mu)?.[1];
  if (!block) return {};
  const name = readScalar(block, "  name");
  const email = readScalar(block, "  email");
  return name && email ? { createdBy: { name, email } } : {};
}

function parseFlowObject(value: string): Record<string, string> {
  return Object.fromEntries(value.split(",").flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) return [];
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    return key ? [[key, unquoteFlowScalar(rawValue)]] : [];
  }));
}

function unquoteFlowScalar(value: string): string {
  if (!value.startsWith("\"")) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function nullIfEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

function upsertFrontmatterScalar(frontmatter: string, field: string, value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(field)) throw new Error(`invalid task frontmatter field: ${field}`);
  const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const line = `${field}: ${value}`;
  const fieldPattern = new RegExp(`^${escapeTaskFieldRegExp(field)}:[^\\r\\n]*(?:\\r?\\n|$)`, "mu");
  if (fieldPattern.test(frontmatter)) {
    return frontmatter.replace(fieldPattern, (current) => `${line}${current.endsWith("\n") ? newline : ""}`);
  }
  return /^vertical:/mu.test(frontmatter)
    ? frontmatter.replace(/^vertical:/mu, `${line}${newline}vertical:`)
    : `${frontmatter}${newline}${line}`;
}

function replaceFrontmatter(body: string, previous: string, next: string): string {
  const openingNewline = body.startsWith("---\r\n") ? "\r\n" : "\n";
  const previousBlockPattern = new RegExp(`^---\\r?\\n${escapeTaskFieldRegExp(previous)}\\r?\\n---`, "u");
  return body.replace(previousBlockPattern, `---${openingNewline}${next}${openingNewline}---`);
}

function escapeTaskFieldRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
