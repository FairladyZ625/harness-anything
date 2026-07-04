import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planTemplateMaterialization, type TemplateCatalog, type VerticalDefinition } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import { isPathInside } from "../../cli/path.ts";
import { readProjectHarnessSettings } from "../settings.ts";
import { bundledTemplateCatalog } from "./bundled.ts";

type ResolvedLayout = ReturnType<typeof resolveHarnessLayout>;
type AgentsEntry = NonNullable<VerticalDefinition["repositoryScaffold"]["agentsEntry"]>;

const DEFAULT_REPO_SPECIFICS_ANCHOR = "## Repository Specifics";
const REPO_SPECIFICS_PLACEHOLDER =
  "The init Configure/Verify step fills this section from repository diagnosis " +
  "(stack, test command, CI required checks, PR template, branch protection, " +
  "monorepo signals). It stays empty until diagnosis runs and never rewrites the " +
  "sections above it.";

export function materializeRepositoryScaffold(rootInput: HarnessLayoutInput, vertical: VerticalDefinition): void {
  const layout = resolveHarnessLayout(rootInput);
  const settings = readProjectHarnessSettings(rootInput, "init");
  const locale = settings.ok
    ? settings.settings.locale ?? "zh-CN"
    : "zh-CN";
  for (const root of vertical.repositoryScaffold.entityRoots) {
    if (root.create === "init") mkdirSync(resolveScaffoldPath(root.path, layout), { recursive: true });
  }
  for (const directory of vertical.repositoryScaffold.dirs) {
    if (directory.create === "init") mkdirSync(resolveScaffoldPath(directory.path, layout), { recursive: true });
  }
  const catalog = bundledTemplateCatalog();
  if (!catalog) throw new Error("bundled software/coding template catalog missing");
  const materialized = planTemplateMaterialization({
    catalog,
    locale,
    selections: vertical.repositoryScaffold.seededDocs
  });
  if (!materialized.ok) {
    throw new Error(`repository scaffold templates failed: ${materialized.issues.map((issue) => issue.code).join(", ")}`);
  }
  for (const [index, document] of materialized.documents.entries()) {
    const selection = vertical.repositoryScaffold.seededDocs[index];
    const filePath = resolveScaffoldPath(document.materializeAs, layout);
    if (!selection) continue;
    if (!selection.overwrite && existsSync(filePath)) continue;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, document.body.endsWith("\n") ? document.body : `${document.body}\n`, "utf8");
  }

  if (vertical.repositoryScaffold.agentsEntry) {
    composeAgentsEntry(vertical.repositoryScaffold.agentsEntry, catalog, locale, layout);
  }
}

// Deterministically compose AGENTS.md from L1 base + L2 overlay templates and
// reserve an empty L3 `## Repository Specifics` section. This is a CLI-layer
// composition concern; the kernel `planTemplateMaterialization` stays 1:1 (one
// selection -> one document body) and is only called here to resolve each layer.
function composeAgentsEntry(
  agentsEntry: AgentsEntry,
  catalog: TemplateCatalog,
  locale: "zh-CN" | "en-US",
  layout: ResolvedLayout
): void {
  const filePath = resolveScaffoldPath(agentsEntry.materializeAs, layout);
  if (!agentsEntry.overwrite && existsSync(filePath)) return;

  const layers = planTemplateMaterialization({
    catalog,
    locale,
    selections: [
      { slot: "repository.agent.base", templateRef: agentsEntry.baseRef, materializeAs: agentsEntry.materializeAs, localePolicy: agentsEntry.localePolicy },
      { slot: "repository.agent.overlay", templateRef: agentsEntry.overlayRef, materializeAs: agentsEntry.materializeAs, localePolicy: agentsEntry.localePolicy }
    ]
  });
  if (!layers.ok || layers.documents.length !== 2) {
    throw new Error(`AGENTS.md compose failed: ${layers.issues.map((issue) => issue.code).join(", ")}`);
  }

  const [base, overlay] = layers.documents;
  const anchor = agentsEntry.repoSpecificsAnchor ?? DEFAULT_REPO_SPECIFICS_ANCHOR;
  const composed = [
    base.body.trimEnd(),
    overlay.body.trimEnd(),
    `${anchor}\n\n${REPO_SPECIFICS_PLACEHOLDER}`
  ].join("\n\n");

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${composed}\n`, "utf8");
}

// L3 repo specialization (ADR-0010 Configure/Verify). This is the deterministic
// interface + region-replacement stub only: it locates the `## Repository
// Specifics` section and replaces it in place, never touching L1/L2 above it.
// TODO(ADR-0010): wire a real diagnosis engine (stack/test/CI/PR/branch/monorepo
// detection) into `body`; this WS ships the boundary, not the detector.
export interface RepositorySpecificsInput {
  readonly anchor?: string;
  // Section body to write under the anchor. Empty string restores the placeholder.
  readonly body: string;
}

export function configureRepositorySpecifics(agentsMarkdownPath: string, input: RepositorySpecificsInput): void {
  const anchor = input.anchor ?? DEFAULT_REPO_SPECIFICS_ANCHOR;
  if (!existsSync(agentsMarkdownPath)) {
    throw new Error(`AGENTS.md not found for repo-specifics configure: ${agentsMarkdownPath}`);
  }
  const existing = readFileSync(agentsMarkdownPath, "utf8");
  const section = `${anchor}\n\n${input.body.trim().length > 0 ? input.body.trim() : REPO_SPECIFICS_PLACEHOLDER}`;
  writeFileSync(agentsMarkdownPath, `${replaceAnchoredSection(existing, anchor, section)}\n`, "utf8");
}

// Replace the region from `anchor` to the next `## ` heading (or EOF) with
// `replacement`. If the anchor is absent, append `replacement` at the end. L1/L2
// bytes above the anchor are never rewritten.
function replaceAnchoredSection(source: string, anchor: string, replacement: string): string {
  const lines = source.replace(/\n+$/u, "").split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === anchor.trim());
  if (startIndex === -1) {
    return `${lines.join("\n")}\n\n${replacement}`;
  }
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^## /u.test(lines[index]!)) {
      endIndex = index;
      break;
    }
  }
  const head = lines.slice(0, startIndex).join("\n").replace(/\n+$/u, "");
  const tail = lines.slice(endIndex).join("\n").replace(/^\n+/u, "");
  const parts = [head, replacement.trimEnd()];
  if (tail.length > 0) parts.push(tail);
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function resolveScaffoldPath(template: string, layout: ReturnType<typeof resolveHarnessLayout>): string {
  const resolved = template
    .replaceAll("{{paths.rootDir}}", layout.rootDir)
    .replaceAll("{{paths.authoredRoot}}", layout.authoredRoot)
    .replaceAll("{{paths.standardsRoot}}", layout.standardsRoot)
    .replaceAll("{{paths.contextRoot}}", layout.contextRoot)
    .replaceAll("{{paths.tasksRoot}}", layout.tasksRoot)
    .replaceAll("{{paths.decisionsRoot}}", layout.decisionsRoot)
    .replaceAll("{{paths.sessionsRoot}}", layout.sessionsRoot)
    .replaceAll("{{paths.adrRoot}}", layout.adrRoot)
    .replaceAll("{{paths.milestonesRoot}}", layout.milestonesRoot);
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw new Error(`unsupported repository scaffold path: ${template}`);
  }
  const absolute = path.resolve(resolved);
  if (!isPathInside(layout.rootDir, absolute)) {
    throw new Error(`repository scaffold path escapes project root: ${template}`);
  }
  return absolute;
}
