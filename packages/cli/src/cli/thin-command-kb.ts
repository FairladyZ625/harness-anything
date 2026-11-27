import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { nonEmpty, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import { isRecord } from "./receipt-render-values.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseKb(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const needsDocId = route.id === "kb-outline" || route.id === "kb-read" || route.id === "kb-put";
  const docId = needsDocId ? args[2] : undefined;
  if (needsDocId && (!nonEmpty(docId) || docId!.startsWith("--"))) {
    return rejected("missing_field", `Use ${route.usage}.`, json);
  }
  return parseProjected(
    route.id,
    args.slice(needsDocId ? 3 : 2),
    rootDir,
    repoId,
    json,
    inputs,
    needsDocId ? { docId } : {},
    {},
    route.method,
  );
}

export function renderKbCatalog(receipt: Record<string, unknown>, payload: Record<string, unknown> | null): string {
  if (!payload || payload.schema !== "kb-catalog/v1" || !Array.isArray(payload.items)) {
    return String(receipt.summary ?? "kb-catalog: applied");
  }
  const items = payload.items.filter(isRecord);
  if (items.length === 0) return "No KB documents.";
  const lines = [
    "DOC_ID\tSCOPE\tSTATUS\tDOMAIN\tTITLE\tSUMMARY",
    ...items.map((item) =>
      [
        String(item.docId ?? ""),
        String(item.scope ?? ""),
        String(item.status ?? ""),
        String(item.domain ?? ""),
        String(item.title ?? ""),
        String(item.summary ?? ""),
      ].join("\t"),
    ),
  ];
  if (typeof payload.nextCursor === "string" && payload.nextCursor.length > 0) {
    lines.push(`more: use --cursor ${payload.nextCursor}`);
  }
  return lines.join("\n");
}

export function renderKbOutline(receipt: Record<string, unknown>, payload: Record<string, unknown> | null): string {
  if (!payload || payload.schema !== "kb-outline/v1" || !Array.isArray(payload.outline)) {
    return String(receipt.summary ?? "kb-outline: applied");
  }
  const header = `${String(payload.docId)} [${String(payload.scope)}] (${String(payload.status)}) — ${String(payload.title)} (${String(payload.lineCount)} lines)`;
  const headings = payload.outline.filter(isRecord);
  if (headings.length === 0) return `${header}\n(no headings)`;
  const rows = headings.map((node) => {
    const level = Math.max(1, Number(node.level ?? 1));
    const indent = "  ".repeat(level - 1);
    const page = typeof node.page === "number" ? ` [p.${node.page}]` : "";
    return `${indent}${"#".repeat(level)} ${String(node.heading)} (L${String(node.startLine)}..L${String(node.endLine)})${page}`;
  });
  return [header, ...rows].join("\n");
}

export function renderKbRead(receipt: Record<string, unknown>, payload: Record<string, unknown> | null): string {
  if (!payload || payload.schema !== "kb-read/v1" || typeof payload.content !== "string") {
    return String(receipt.summary ?? "kb-read: applied");
  }
  const sectionLabel = typeof payload.section === "string" ? ` section=${JSON.stringify(payload.section)}` : "";
  const header = `${String(payload.docId)} [${String(payload.scope)}] (${String(payload.mode)}${sectionLabel} L${String(payload.startLine)}..L${String(payload.endLine)}/${String(payload.totalLines)})`;
  return `${header}\n${payload.content}`;
}

export function renderKbPut(receipt: Record<string, unknown>, payload: Record<string, unknown> | null): string {
  if (!payload || payload.schema !== "kb-put/v1" || !isRecord(payload.bundle)) {
    return String(receipt.summary ?? "kb-put: applied");
  }
  const bundle = payload.bundle;
  const manifest = isRecord(bundle.manifest) ? bundle.manifest : {};
  return `kb-put: ${String(bundle.docId)} [${String(payload.scope)}] rev=${String(bundle.revision)} status=${String(manifest.status ?? "active")} title=${JSON.stringify(String(manifest.title ?? ""))}`;
}

export function renderKbMount(receipt: Record<string, unknown>, payload: Record<string, unknown> | null): string {
  if (!payload || payload.schema !== "kb-mount/v1") {
    return String(receipt.summary ?? "kb-mount: applied");
  }
  if (payload.operation === "list" && Array.isArray(payload.mounts)) {
    const mounts = payload.mounts.filter(isRecord);
    if (mounts.length === 0) return "No local KB mounts.";
    return [
      "MOUNT_ID\tMODE\tDOMAIN\tROOT_PATH",
      ...mounts.map((m) =>
        [String(m.mountId ?? ""), String(m.mode ?? ""), String(m.domain ?? ""), String(m.rootPath ?? "")].join("\t"),
      ),
    ].join("\n");
  }
  if (payload.operation === "add" && isRecord(payload.mount)) {
    return `kb-mount: added ${String(payload.mount.mountId)} (${String(payload.mount.mode)}) -> ${String(payload.mount.rootPath)}`;
  }
  if (payload.operation === "remove") {
    return `kb-mount: removed ${String(payload.mountId)} (changed=${String(payload.removed)})`;
  }
  return String(receipt.summary ?? "kb-mount: applied");
}
