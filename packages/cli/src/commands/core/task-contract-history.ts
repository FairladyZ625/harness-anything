import { execFileSync } from "node:child_process";
import path from "node:path";
import { Schema } from "effect";
import { isSafeBodyPath } from "../../cli/path.ts";
import {
  planTemplateMaterialization,
  PresetManifestSchema,
  readFrontmatter,
  readScalar,
  TemplateCatalogSchema,
  validateExtensionInputShape,
  validatePresetManifests,
  VerticalDefinitionSchema,
  type MaterializedTemplatePlan,
  type PresetManifest,
  type TemplateBodyResolver,
  type TemplateCatalog
} from "../../../../kernel/src/index.ts";

const softwareCodingAssetRoot = "packages/cli/src/commands/extensions/assets/software-coding";

export type HistoricalTaskContractResolution = {
  readonly ok: true;
  readonly sourceCommit: string;
  readonly preset: PresetManifest;
  readonly profile: PresetManifest["profiles"][number];
  readonly catalog: TemplateCatalog;
  readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
} | {
  readonly ok: false;
  readonly reason: string;
};

export interface HistoricalTaskContractInput {
  readonly capturedAt: string;
  readonly vertical: string;
  readonly presetId: string;
  readonly profileId?: string;
  readonly locale: "zh-CN" | "en-US";
}

export interface AuthoredTaskCreationEvidence {
  readonly sourceCommit: string;
  readonly title: string;
  readonly documents: ReadonlyMap<string, string>;
}

export function createHistoricalTaskContractResolver(rootDir: string): (input: HistoricalTaskContractInput) => HistoricalTaskContractResolution {
  const history = readAssetHistory(rootDir);
  const contractCache = new Map<string, HistoricalTaskContractResolution>();
  return (input) => {
    const capturedAt = Date.parse(input.capturedAt);
    if (!Number.isFinite(capturedAt)) return { ok: false, reason: "task_binding_timestamp_invalid" };
    const sourceCommit = history.find((entry) => entry.timestampMs <= capturedAt)?.commit;
    if (!sourceCommit) return { ok: false, reason: "source_git_history_unavailable" };
    const cacheKey = [sourceCommit, input.vertical, input.presetId, input.profileId ?? "", input.locale].join("\0");
    const cached = contractCache.get(cacheKey);
    if (cached) return cached;
    const resolved = resolveHistoricalTaskContractAtCommit(rootDir, sourceCommit, input);
    contractCache.set(cacheKey, resolved);
    return resolved;
  };
}

export function createAuthoredTaskCreationResolver(
  authoredRoot: string,
  tasksRoot: string
): (taskDir: string, documentPaths: ReadonlyArray<string>) => AuthoredTaskCreationEvidence | undefined {
  const relativeTasksRoot = portableRelative(authoredRoot, tasksRoot);
  if (!relativeTasksRoot) return () => undefined;
  const creationCommits = readTaskCreationCommits(authoredRoot, relativeTasksRoot);
  const blobCache = new Map<string, string | undefined>();
  return (taskDir, documentPaths) => {
    const relativeTaskDir = portableRelative(authoredRoot, taskDir);
    if (!relativeTaskDir || !(relativeTaskDir === relativeTasksRoot || relativeTaskDir.startsWith(`${relativeTasksRoot}/`))) return undefined;
    const indexPath = `${relativeTaskDir}/INDEX.md`;
    const sourceCommit = creationCommits.get(indexPath);
    if (!sourceCommit) return undefined;
    const indexBody = readCachedGitBlob(authoredRoot, sourceCommit, indexPath, blobCache);
    const frontmatter = indexBody ? readFrontmatter(indexBody) : null;
    const title = frontmatter ? readScalar(frontmatter, "title") : "";
    if (!title) return undefined;
    const documents = new Map<string, string>();
    for (const documentPath of documentPaths) {
      if (!isSafeTaskDocumentPath(documentPath)) return undefined;
      const body = readCachedGitBlob(authoredRoot, sourceCommit, `${relativeTaskDir}/${documentPath}`, blobCache);
      if (body === undefined) return undefined;
      documents.set(documentPath, body);
    }
    return { sourceCommit, title, documents };
  };
}

function resolveHistoricalTaskContractAtCommit(
  rootDir: string,
  sourceCommit: string,
  input: HistoricalTaskContractInput
): HistoricalTaskContractResolution {
  if (input.vertical !== "software/coding") return { ok: false, reason: `historical_vertical_unsupported:${input.vertical}` };
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(input.presetId)) return { ok: false, reason: "historical_preset_id_invalid" };
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) return { ok: false, reason: "source_git_history_unavailable" };

  try {
    const catalog = decodeHistoricalJson(rootDir, sourceCommit, "template-catalog.json", TemplateCatalogSchema, "template-catalog");
    const vertical = decodeHistoricalJson(rootDir, sourceCommit, "vertical.json", VerticalDefinitionSchema, "vertical-definition");
    const preset = decodeHistoricalJson(rootDir, sourceCommit, `presets/${input.presetId}/preset.json`, PresetManifestSchema, "preset-manifest");
    if (vertical.id !== input.vertical || preset.vertical !== input.vertical) {
      return { ok: false, reason: "historical_contract_vertical_mismatch" };
    }
    const presetValidation = validatePresetManifests([preset], { kernelVersion: "1.0.0" });
    if (!presetValidation.ok) return { ok: false, reason: "historical_preset_invalid" };
    const profile = preset.profiles.find((candidate) => candidate.id === (input.profileId ?? preset.defaultProfile));
    if (!profile) return { ok: false, reason: `historical_profile_unresolvable:${input.profileId ?? preset.defaultProfile}` };

    const selections = combineSelections(
      vertical.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections ?? vertical.templateSelections,
      profile.templateSelections
    );
    const materialized = planTemplateMaterialization({
      catalog,
      locale: input.locale,
      resolveBody: historicalBodyResolver(rootDir, sourceCommit),
      selections
    });
    if (!materialized.ok) return { ok: false, reason: `historical_materialization_invalid:${materialized.issues[0]?.code ?? "unknown"}` };
    return { ok: true, sourceCommit, preset, profile, catalog, documents: materialized.documents };
  } catch {
    return { ok: false, reason: "source_git_history_unreadable" };
  }
}

function readAssetHistory(rootDir: string): ReadonlyArray<{ readonly commit: string; readonly timestampMs: number }> {
  const output = gitOutput(rootDir, ["rev-list", "--timestamp", "HEAD", "--", softwareCodingAssetRoot]);
  if (!output) return [];
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^(\d+) ([a-f0-9]{40})$/u.exec(line.trim());
    return match ? [{ commit: match[2], timestampMs: Number(match[1]) * 1000 }] : [];
  });
}

function readTaskCreationCommits(authoredRoot: string, relativeTasksRoot: string): ReadonlyMap<string, string> {
  const output = gitOutput(authoredRoot, [
    "log",
    "--reverse",
    "--format=@@%H",
    "--name-only",
    "--diff-filter=A",
    "--",
    relativeTasksRoot
  ]);
  if (!output) return new Map();
  const commits = new Map<string, string>();
  let currentCommit = "";
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("@@")) {
      currentCommit = line.slice(2);
      continue;
    }
    if (currentCommit && line.endsWith("/INDEX.md") && !commits.has(line)) commits.set(line, currentCommit);
  }
  return commits;
}

function readCachedGitBlob(
  authoredRoot: string,
  commit: string,
  relativePath: string,
  cache: Map<string, string | undefined>
): string | undefined {
  const key = `${commit}\0${relativePath}`;
  if (cache.has(key)) return cache.get(key);
  const body = gitOutput(authoredRoot, ["show", `${commit}:${relativePath}`]);
  cache.set(key, body);
  return body;
}

function portableRelative(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative.split(path.sep).join("/");
}

function isSafeTaskDocumentPath(value: string): boolean {
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function decodeHistoricalJson<A, I>(
  rootDir: string,
  commit: string,
  relativePath: string,
  schema: Schema.Schema<A, I, never>,
  kind: "template-catalog" | "preset-manifest" | "vertical-definition"
): A {
  const raw = JSON.parse(gitRequiredText(rootDir, ["show", `${commit}:${softwareCodingAssetRoot}/${relativePath}`])) as unknown;
  const shape = validateExtensionInputShape(kind, raw);
  if (!shape.ok) throw new Error(`${kind} shape invalid`);
  return Schema.decodeUnknownSync(schema)(raw);
}

function historicalBodyResolver(rootDir: string, commit: string): TemplateBodyResolver {
  return ({ locale }) => {
    if (!isSafeBodyPath(locale.bodyPath)) return undefined;
    return gitOutput(rootDir, ["show", `${commit}:${softwareCodingAssetRoot}/${locale.bodyPath}`]);
  };
}

function combineSelections(
  verticalSelections: ReadonlyArray<PresetManifest["profiles"][number]["templateSelections"][number]>,
  presetSelections: ReadonlyArray<PresetManifest["profiles"][number]["templateSelections"][number]>
): PresetManifest["profiles"][number]["templateSelections"] {
  const byPath = new Map<string, PresetManifest["profiles"][number]["templateSelections"][number]>();
  for (const selection of verticalSelections) byPath.set(selection.materializeAs, selection);
  for (const selection of presetSelections) byPath.set(selection.materializeAs, selection);
  return [...byPath.values()];
}

function gitRequiredText(rootDir: string, args: ReadonlyArray<string>): string {
  const value = gitOutput(rootDir, args);
  if (value === undefined) throw new Error("git object unavailable");
  return value;
}

function gitOutput(rootDir: string, args: ReadonlyArray<string>): string | undefined {
  try {
    return execFileSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    return undefined;
  }
}
