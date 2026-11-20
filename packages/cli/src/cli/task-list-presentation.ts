import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol-identifiers";
import { isRecord } from "./receipt-render-values.ts";
import { parseProjected } from "./thin-command-projection.ts";
import type { ThinCliInput, ThinCliInputDirectory, ThinCommand, ThinParseResult } from "./thin-command-types.ts";

export const tasksOnlyInput = {
  name: "--tasks-only",
  description: "Exclude Work roots from each task-list page. Use its cursor to continue.",
  kind: "boolean",
  required: false,
  error: { code: "invalid_field" },
} satisfies ThinCliInput;

export function parseTaskList(
  tokens: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const id = "task-list",
    declaration = inputs.get(id)!;
  const parsed = parseProjected(
    id,
    tokens,
    rootDir,
    repoId,
    json,
    new Map([[id, { ...declaration, inputs: [...declaration.inputs, tasksOnlyInput] }]]),
  );
  if (!parsed.ok || parsed.command.action.tasksOnly !== true) return parsed;
  const { tasksOnly: _tasksOnly, ...action } = parsed.command.action;
  return { ok: true, command: { ...parsed.command, tasksOnly: true, action } };
}

export async function presentTaskList(
  receipt: Record<string, unknown>,
  command: ThinCommand,
  request: (command: ThinCommand) => Promise<JsonObject>,
): Promise<Record<string, unknown>> {
  if (receipt.ok !== true || !Array.isArray(receipt.rows) || (command.json && !command.tasksOnly)) return receipt;
  const rows = receipt.rows as readonly JsonObject[];
  const workIds = new Set<string>();
  if (rows.length > 0) {
    const index = await request({
      ...command,
      id: undefined,
      method: "repo.works.index",
      action: { kind: "work-index" },
    });
    if (index.ok !== true) return index;
    for (const work of index.works as readonly JsonObject[]) workIds.add(String(work.taskId));
  }
  const isWork = (row: JsonObject) => row.taskClass === "work" || workIds.has(String(row.taskId));
  const visible = command.tasksOnly ? executableRows(rows, isWork) : { rows, count: Number(receipt.count) };
  const cut = { ...receipt, ...(command.tasksOnly ? visible : {}) };
  const summary = renderTaskList(cut, visible.rows, isWork, command.tasksOnly === true);
  if (!command.tasksOnly) return { ...cut, summary };
  const evidence = JSON.parse(String(receipt.evidence));
  return { ...cut, summary, evidence: JSON.stringify({ ...evidence, ...visible }) };
}

/** A hidden container's children stay in the selected page and occupy its place in the tree. */
function executableRows(rows: readonly JsonObject[], isWork: (row: JsonObject) => boolean) {
  const visible: JsonObject[] = [],
    pending = rows.toReversed().map((row) => ({ row, output: visible }));
  let count = 0;
  while (pending.length) {
    const { row, output } = pending.pop()!;
    const children = row.children as readonly JsonObject[] | undefined;
    const work = isWork(row),
      descendants: JsonObject[] = [];
    if (!work) {
      output.push(children === undefined ? row : { ...row, children: descendants });
      count += 1;
    }
    for (const child of children?.toReversed() ?? []) pending.push({ row: child, output: work ? output : descendants });
  }
  return { rows: visible, count };
}

function renderTaskList(
  receipt: Record<string, unknown>,
  rows: readonly JsonObject[],
  isWork: (row: JsonObject) => boolean,
  tasksOnly: boolean,
): string {
  const tree = receipt.mode === "tree",
    lines: string[] = [],
    pending = rows.toReversed().map((row) => ({ row, depth: 0 }));
  while (pending.length) {
    const { row, depth } = pending.pop()!;
    const id = `${row.pinned === true ? "📌 " : ""}${String(row.taskId)}`;
    const title = `${isWork(row) ? "[work] " : ""}${String(row.title)}`;
    lines.push(
      tree
        ? `${"  ".repeat(depth)}${id} [${String(row.status)}] ${title}`
        : [
            id,
            row.status,
            title,
            row.updatedAt,
            row.workspacePackagePath ?? row.packagePath,
            row.packageDisposition,
            row.taskClass,
          ].join("\t"),
    );
    for (const child of (row.children as readonly JsonObject[] | undefined)?.toReversed() ?? [])
      pending.push({ row: child, depth: depth + 1 });
  }
  const page = isRecord(receipt.page) ? receipt.page : undefined;
  return [
    tree ? "tree:" : "rows:",
    lines.join("\n") || "(none)",
    `count=${String(receipt.count)}  status=${String(receipt.status)}  watermark=${String(receipt.watermark)}  ` +
      `sourceRevision=${String(receipt.sourceRevision)}${page ? `  page=${JSON.stringify(page)}` : ""}`,
    ...(typeof page?.nextCursor === "string"
      ? [`more: use ${tasksOnly ? "--tasks-only " : ""}--cursor ${page.nextCursor}`]
      : []),
    ...(isRecord(receipt.freshness)
      ? [
          `freshness=${String(receipt.freshness.state)}  confirmedAt=${String(receipt.freshness.confirmedAt ?? "never")}`,
          ...(Array.isArray(receipt.warnings) ? receipt.warnings.map(String) : []),
        ]
      : []),
  ].join("\n");
}
