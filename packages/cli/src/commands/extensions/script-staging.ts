import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  sha256Text,
  stablePayloadHash,
  type EntityId,
  type HarnessLayoutInput,
  type WriteOp
} from "../../../../kernel/src/index.ts";
import { listGeneratedFiles, permissionPathsForScope } from "./script-scope.ts";

export interface CanonicalScriptStage {
  readonly rootInput: HarnessLayoutInput;
  readonly layout: ReturnType<typeof resolveHarnessLayout>;
  readonly outputRoot: string;
  readonly realLayout: ReturnType<typeof resolveHarnessLayout>;
  readonly realOutputRoot: string;
  readonly baseline: ReadonlyMap<string, string>;
}

export function createCanonicalScriptStage(
  rootInput: HarnessLayoutInput,
  runDir: string,
  realOutputRoot: string
): CanonicalScriptStage {
  const realLayout = resolveHarnessLayout(rootInput);
  const stageRootDir = path.join(runDir, "staging");
  const authoredRelative = path.relative(realLayout.rootDir, realLayout.authoredRoot);
  const stageAuthoredRoot = path.join(stageRootDir, authoredRelative);
  mkdirSync(stageAuthoredRoot, { recursive: true });
  if (existsSync(realLayout.authoredRoot)) {
    cpSync(realLayout.authoredRoot, stageAuthoredRoot, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".git"
    });
  }
  const stagedRootInput = {
    rootDir: stageRootDir,
    layoutOverrides: {
      authoredRoot: authoredRelative.split(path.sep).join("/")
    }
  };
  const layout = resolveHarnessLayout(stagedRootInput);
  const outputRelative = path.relative(realLayout.authoredRoot, realOutputRoot);
  const outputRoot = path.join(layout.authoredRoot, outputRelative);
  const baseline = new Map(listGeneratedFiles(layout.authoredRoot).map((filePath) => [
    filePath,
    sha256Text(readFileSync(filePath, "utf8"))
  ]));
  return { rootInput: stagedRootInput, layout, outputRoot, realLayout, realOutputRoot, baseline };
}

export function canonicalGeneratedPaths(stage: CanonicalScriptStage, stagedPaths: ReadonlyArray<string>): ReadonlyArray<string> {
  return stagedPaths.map((filePath) => {
    const relativePath = normalizeRelativeDocumentPath(path.relative(stage.layout.authoredRoot, filePath).split(path.sep).join("/"));
    return path.join(stage.realLayout.authoredRoot, relativePath);
  });
}

export function canonicalizeScriptResult(stage: CanonicalScriptStage, value: Record<string, unknown>): Record<string, unknown> {
  return remapValue(value) as Record<string, unknown>;

  function remapValue(input: unknown): unknown {
    if (typeof input === "string") {
      const absoluteStagePrefix = `${stage.layout.authoredRoot}${path.sep}`;
      if (input.startsWith(absoluteStagePrefix)) {
        return path.join(stage.realLayout.authoredRoot, path.relative(stage.layout.authoredRoot, input));
      }
      const stageRelative = path.relative(stage.layout.rootDir, stage.layout.authoredRoot).split(path.sep).join("/");
      if (input === stageRelative || input.startsWith(`${stageRelative}/`)) {
        const realRelative = path.relative(stage.realLayout.rootDir, stage.realLayout.authoredRoot).split(path.sep).join("/");
        return `${realRelative}${input.slice(stageRelative.length)}`;
      }
      return input;
    }
    if (Array.isArray(input)) return input.map(remapValue);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, remapValue(entry)]));
    }
    return input;
  }
}

export function stageMirrorPath(stage: CanonicalScriptStage, realPath: string): string {
  const relative = path.relative(stage.realLayout.authoredRoot, realPath);
  const insideAuthored = relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return insideAuthored ? path.join(stage.layout.authoredRoot, relative) : realPath;
}

export function remapScope(
  stage: CanonicalScriptStage,
  scope: { readonly ok: true; readonly roots: ReadonlyArray<string>; readonly permissions: ReadonlyArray<string> }
) {
  const roots = scope.roots.map((root) => stageMirrorPath(stage, root));
  return {
    ok: true as const,
    roots,
    permissions: [...scope.permissions, ...roots.flatMap((root) => permissionPathsForScope(root, true))]
  };
}

export function scriptIngestOp(
  stage: CanonicalScriptStage,
  stagedWriteRoots: ReadonlyArray<string>,
  operationId: string
): WriteOp | undefined {
  const writes = listGeneratedFiles(stage.layout.authoredRoot).flatMap((filePath) => {
    if (!stagedWriteRoots.some((root) => sameOrInside(root, filePath))) return [];
    const body = readFileSync(filePath, "utf8");
    const stagedHash = sha256Text(body);
    if (stage.baseline.get(filePath) === stagedHash) return [];
    const relativePath = normalizeRelativeDocumentPath(path.relative(stage.layout.authoredRoot, filePath).split(path.sep).join("/"));
    const realPath = path.join(stage.realLayout.authoredRoot, relativePath);
    return [{
      path: relativePath,
      body,
      baseBlobSha256: existsSync(realPath) ? sha256Text(readFileSync(realPath, "utf8")) : null
    }];
  });
  if (writes.length === 0) return undefined;
  const entityId = scriptRunEntityId(operationId);
  return {
    opId: `script-${operationId}-${stablePayloadHash({ entityId, writes }).slice(0, 16)}`,
    entityId,
    kind: "script_ingest",
    payload: { writes }
  };
}

function scriptRunEntityId(operationId: string): EntityId {
  return `entity/script-run/${sha256Text(operationId).slice(0, 32)}`;
}

function sameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length === 0 || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
