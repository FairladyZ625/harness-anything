import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, validateAgentDeclarationV1, type AgentDeclarationV1 } from "@harness-anything/kernel";
import { agentRuntimeSelectionIssue, type AgentRuntimeInstanceView } from "./agent-entities.ts";
import { daemonUserRoot } from "./client/local-daemon-target.ts";

export interface AgentDeclarationMigrationEntry {
  readonly file: string;
  readonly id?: string;
  readonly outcome: "converted" | "current" | "rejected";
  readonly issues?: readonly string[];
}

export interface AgentDeclarationMigrationRuntimeIssue {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface AgentDeclarationMigrationReceipt {
  readonly ok: boolean;
  readonly kind: "declaration" | "declarations";
  readonly source: string;
  readonly mode: "dry-run" | "convert";
  readonly destination?: string;
  readonly entries: readonly AgentDeclarationMigrationEntry[];
  readonly converted: number;
  readonly current: number;
  readonly rejected: number;
  readonly runtimeAvailability: "checked" | "unknown";
  readonly runtimeIssues: readonly AgentDeclarationMigrationRuntimeIssue[];
  readonly next: string;
}

type ConvertedDeclaration =
  | { readonly outcome: "current" | "converted"; readonly declaration: AgentDeclarationV1; readonly body: string }
  | { readonly outcome: "rejected"; readonly issues: readonly string[] };

/**
 * One pass of pre-runtimes agent declarations (`runtime_type` plus top-level `model`) to the
 * current runtimes shape, mirroring `ha migrate completion`: the source is never modified,
 * convert writes only to a fresh destination, and a file that is neither shape is rejected per
 * file — with its schema issues — instead of aborting the batch or guessing a mapping.
 */
export function migrateAgentDeclarations(input: {
  readonly source: string;
  readonly destination?: string;
  readonly dryRun: boolean;
  readonly userRoot?: string;
}): AgentDeclarationMigrationReceipt {
  const source = path.resolve(input.source),
    stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Migration source must be a regular file or directory.");
  const names = stat.isFile()
      ? [path.basename(source)]
      : readdirSync(source)
          .filter((name) => name.endsWith(".json"))
          .sort(),
    results = names.map((name) => ({
      name,
      result: convert(stat.isFile() ? source : path.join(source, name), name),
    })),
    instances = readRuntimeInstanceViews(input.userRoot ?? daemonUserRoot()),
    runtimeIssues: AgentDeclarationMigrationRuntimeIssue[] = [];
  for (const { result } of results) {
    if (result.outcome === "rejected" || instances === null) continue;
    // The same production check install and validate run, so the receipt names exactly the
    // rejection the operator would hit, not a second availability opinion.
    const issue = agentRuntimeSelectionIssue(result.declaration, instances);
    if (issue) runtimeIssues.push({ id: result.declaration.id, ...issue });
  }
  const entries = results.map(({ name, result }) =>
      result.outcome === "rejected"
        ? { file: name, outcome: result.outcome, issues: result.issues }
        : { file: name, id: result.declaration.id, outcome: result.outcome },
    ),
    counts = {
      converted: entries.filter(({ outcome }) => outcome === "converted").length,
      current: entries.filter(({ outcome }) => outcome === "current").length,
      rejected: entries.filter(({ outcome }) => outcome === "rejected").length,
    },
    writable = results.flatMap(({ name, result }) => (result.outcome === "rejected" ? [] : [{ name, result }]));
  let destination: string | undefined;
  if (!input.dryRun && writable.length > 0) {
    if (!input.destination) throw new Error("Declaration conversion requires --destination <new-file-or-directory>.");
    destination = path.resolve(input.destination);
    if (stat.isFile()) {
      writeFileSync(destination, writable[0]!.result.body, { flag: "wx" });
    } else {
      if (existsSync(destination)) throw new Error(`Migration destination already exists: ${destination}`);
      mkdirSync(destination, { recursive: true });
      for (const { name, result } of writable) writeFileSync(path.join(destination, name), result.body, { flag: "wx" });
    }
  }
  return {
    ok: counts.rejected === 0,
    kind: stat.isFile() ? "declaration" : "declarations",
    source,
    mode: input.dryRun ? "dry-run" : "convert",
    ...(destination === undefined ? {} : { destination }),
    entries,
    ...counts,
    runtimeAvailability: instances === null ? "unknown" : "checked",
    runtimeIssues,
    next: nextStep(input.dryRun, counts.rejected, runtimeIssues.length),
  };
}

function convert(file: string, name: string): ConvertedDeclaration {
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch (error) {
    return { outcome: "rejected", issues: [`${name} cannot be read: ${errorText(error)}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { outcome: "rejected", issues: [`${name} is not valid JSON.`] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { outcome: "rejected", issues: [`${name} must be one JSON object.`] };
  const record = value as Readonly<Record<string, unknown>>;
  if (record.schema !== "agent-declaration/v1")
    return { outcome: "rejected", issues: [`${name} must carry schema agent-declaration/v1.`] };
  if (validateAgentDeclarationV1(record).length === 0)
    return { outcome: "current", declaration: record as unknown as AgentDeclarationV1, body };
  const legacyRuntimeType = Object.hasOwn(record, "runtime_type"),
    legacyModel = Object.hasOwn(record, "model");
  if (!legacyRuntimeType && !legacyModel) return { outcome: "rejected", issues: validateAgentDeclarationV1(record) };
  if (Object.hasOwn(record, "runtimes"))
    return {
      outcome: "rejected",
      issues: [`${name} declares both runtimes and legacy runtime_type/model fields; resolve it to one shape.`],
    };
  if (!legacyRuntimeType)
    return {
      outcome: "rejected",
      issues: [`${name} carries a top-level model without runtime_type; the runtime kind is not recoverable.`],
    };
  if (typeof record.runtime_type !== "string" || !record.runtime_type.trim())
    return { outcome: "rejected", issues: [`${name} runtime_type must be a non-empty string.`] };
  const { runtime_type: _runtime_type, model, ...rest } = record,
    declaration = {
      ...rest,
      runtimes: [legacyModel ? { type: record.runtime_type, model } : { type: record.runtime_type }],
    },
    issues = validateAgentDeclarationV1(declaration);
  if (issues.length) return { outcome: "rejected", issues };
  return {
    outcome: "converted",
    declaration: declaration as unknown as AgentDeclarationV1,
    body: `${JSON.stringify(declaration, null, 2)}\n`,
  };
}

/** The node's enabled instances, or null when the store is absent/unreadable: availability stays
 * advisory, so an unknown node never blocks the conversion itself. */
function readRuntimeInstanceViews(userRoot: string): readonly AgentRuntimeInstanceView[] | null {
  let body: string;
  try {
    body = readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8");
  } catch (error) {
    // No readable instance store means availability stays unknown; the conversion itself proceeds.
    consumeKnownError(error);
    return null;
  }
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as { readonly schema?: unknown; readonly instances?: unknown };
    if (record.schema !== "runtime-instances/v1" || !Array.isArray(record.instances)) return null;
    const views: AgentRuntimeInstanceView[] = [];
    for (const entry of record.instances) {
      if (typeof entry !== "object" || entry === null) return null;
      const instance = entry as Readonly<Record<string, unknown>>;
      if (
        typeof instance.instanceId !== "string" ||
        typeof instance.kindId !== "string" ||
        typeof instance.enabled !== "boolean" ||
        !Array.isArray(instance.models) ||
        instance.models.some((model) => typeof model !== "string")
      )
        return null;
      views.push({
        instanceId: instance.instanceId,
        kindId: instance.kindId,
        enabled: instance.enabled,
        models: instance.models,
      });
    }
    return views;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function nextStep(dryRun: boolean, rejected: number, runtimeIssues: number): string {
  const steps = [
    dryRun
      ? "Re-run with --mode convert and a fresh --destination to write the candidates."
      : "Review the candidates, replace the originals under harness/agents/, and reinstall each agent with ha agent install --source harness/agents/<id>.json.",
  ];
  if (runtimeIssues > 0)
    steps.push(
      "Declarations whose runtime kinds or models have no enabled instance on this node still convert; " +
        "installing them will report the listed issue until an instance is enabled (ha runtime instance list).",
    );
  if (rejected > 0) steps.push("Rejected files need manual resolution; see their per-file issues.");
  return steps.join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
