import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  sha256Text,
  stablePayloadHash,
  type EntityId,
  type HarnessLayoutInput,
  type SemanticDiffCandidateTree,
  type SemanticDiffDocumentPolicy,
  type WriteOp
} from "@harness-anything/kernel";
import { compileManagedCandidateTreeV2 } from "@harness-anything/application";
import {
  listGeneratedFiles,
  permissionPathsForScope,
  resolvedScopeSetIsSafe,
  sameOrInside,
  scopeRootIsRecursive,
  type ResolvedScopeSet
} from "./script-scope.ts";
import { resolveManagedSectionPolicy } from "./managed-section-policy.ts";

export interface CanonicalScriptStage {
  readonly rootInput: HarnessLayoutInput;
  readonly layout: ReturnType<typeof resolveHarnessLayout>;
  readonly outputRoot: string;
  readonly realLayout: ReturnType<typeof resolveHarnessLayout>;
  readonly realOutputRoot: string;
  readonly baseline: ReadonlyMap<string, string>;
  readonly baselineBodies: ReadonlyMap<string, string>;
}

export class ScriptStageScopeError extends Error {
  readonly code = "script_stage_scope_symlink" as const;
  readonly scopeMode: "read" | "write";

  constructor(scopeMode: "read" | "write") {
    super("Script staging encountered a symbolic link inside a protected recursive scope.");
    this.name = "ScriptStageScopeError";
    this.scopeMode = scopeMode;
  }
}

export class ScriptSemanticDiffError extends Error {
  readonly code = "script_semantic_diff_rejected" as const;
}

export function createCanonicalScriptStage(
  rootInput: HarnessLayoutInput,
  runDir: string,
  realOutputRoot: string,
  options: {
    readonly protectedScopes?: ReadonlyArray<{
      readonly mode: "read" | "write";
      readonly scope: ResolvedScopeSet;
    }>;
  } = {}
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
  const stageWithoutBaseline: CanonicalScriptStage = {
    rootInput: stagedRootInput,
    layout,
    outputRoot,
    realLayout,
    realOutputRoot,
    baseline: new Map(),
    baselineBodies: new Map()
  };
  assertProtectedStageScopes(stageWithoutBaseline, options.protectedScopes ?? []);
  const baselineBodies = new Map(listGeneratedFiles(layout.authoredRoot).map((filePath) => [
    filePath,
    readFileSync(filePath, "utf8")
  ]));
  const baseline = new Map([...baselineBodies].map(([filePath, body]) => [filePath, sha256Text(body)]));
  return { rootInput: stagedRootInput, layout, outputRoot, realLayout, realOutputRoot, baseline, baselineBodies };
}

function assertProtectedStageScopes(
  stage: CanonicalScriptStage,
  scopes: ReadonlyArray<{
    readonly mode: "read" | "write";
    readonly scope: ResolvedScopeSet;
  }>
): void {
  for (const protectedScope of scopes) {
    const stagedScope = remapScope(stage, protectedScope.scope, { retainOriginalPermissions: false });
    if (!resolvedScopeSetIsSafe(
      stagedScope,
      [stage.layout.rootDir, stage.realLayout.rootDir],
      protectedScope.mode
    )) {
      throw new ScriptStageScopeError(protectedScope.mode);
    }
  }
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
  scope: ResolvedScopeSet,
  options: { readonly retainOriginalPermissions?: boolean } = {}
) {
  const roots = scope.roots.map((root) => stageMirrorPath(stage, root));
  const remappedPermissions = roots.flatMap((root, index) => (
    permissionPathsForScope(root, scopeRootIsRecursive(scope, scope.roots[index] ?? root))
  ));
  return {
    ok: true as const,
    roots,
    ...(scope.reportedLeafConflicts ? {
      reportedLeafConflicts: scope.reportedLeafConflicts.map((candidate) => stageMirrorPath(stage, candidate))
    } : {}),
    permissions: [...new Set([
      ...(options.retainOriginalPermissions === false ? [] : scope.permissions),
      ...remappedPermissions
    ])]
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
    return [{
      path: relativePath,
      body,
      // The stage copy is the canonical snapshot observed before the script ran.
      // An absent stage entry therefore freezes the canonical base as `null`.
      // Never re-read the live authored tree here: a concurrent writer may have
      // changed it while the script was executing, and the coordinator must see
      // that mismatch and reject this stale batch instead of overwriting it.
      baseBlobSha256: stage.baseline.get(filePath) ?? null
    }];
  });
  if (writes.length === 0) return undefined;
  let semanticMutationPlan: ReturnType<typeof compileManagedCandidateTreeV2>;
  try {
    semanticMutationPlan = compileStagedSemanticPlan(stage, writes);
  } catch (error) {
    throw new ScriptSemanticDiffError(error instanceof Error ? error.message : "SEMANTIC_DIFF_AMBIGUOUS");
  }
  const entityId = scriptRunEntityId(operationId);
  return {
    opId: `script-${operationId}-${stablePayloadHash({ entityId, writes }).slice(0, 16)}`,
    entityId,
    kind: "script_ingest",
    payload: { writes, semanticMutationPlan }
  };
}

function compileStagedSemanticPlan(
  stage: CanonicalScriptStage,
  writes: ReadonlyArray<{ readonly path: string; readonly body: string; readonly baseBlobSha256: string | null }>
): ReturnType<typeof compileManagedCandidateTreeV2> {
  const managedWrites = writes.filter((write) => isManagedDocumentCandidate(write.path));
  if (managedWrites.length === 0) return { registryVersion: 1, mutations: [] };
  const policies = managedWrites.map((write) => resolveManagedSectionPolicy(stage.rootInput, write.path));
  const missingPolicyIndex = policies.findIndex((policy) => policy === null);
  if (missingPolicyIndex !== -1) {
    const rejectedPath = managedWrites[missingPolicyIndex]!.path;
    if (/^tasks\/[^/]+\/(?:INDEX\.md|executions\/|reviews\/)/u.test(rejectedPath)) {
      throw new Error(`SEMANTIC_DIFF_REQUIRED: script_ingest cannot write Task typed-authority path: ${rejectedPath}`);
    }
    throw new Error(`SEMANTIC_DIFF_REQUIRED: script touched an undeclared managed region: ${rejectedPath}`);
  }
  const contextDocuments = taskIndexContexts(stage, managedWrites.map((write) => write.path));
  const baseTree: SemanticDiffCandidateTree = {
    documents: [
      ...managedWrites.map((write) => ({
        path: write.path,
        body: stage.baselineBodies.get(path.join(stage.layout.authoredRoot, write.path)) ?? null
      })),
      ...contextDocuments
    ]
  };
  const candidateTree: SemanticDiffCandidateTree = {
    documents: [
      ...managedWrites.map((write) => ({ path: write.path, body: write.body })),
      ...contextDocuments
    ]
  };
  return compileManagedCandidateTreeV2(
    baseTree,
    candidateTree,
    policies as ReadonlyArray<SemanticDiffDocumentPolicy>
  );
}

function taskIndexContexts(
  stage: CanonicalScriptStage,
  documentPaths: ReadonlyArray<string>
): ReadonlyArray<{ readonly path: string; readonly body: string }> {
  return [...new Set(documentPaths.flatMap((documentPath) => {
    const match = /^(tasks\/[^/]+)\//u.exec(documentPath);
    return match?.[1] ? [`${match[1]}/INDEX.md`] : [];
  }))].sort().map((indexPath) => {
    const absolutePath = path.join(stage.layout.authoredRoot, indexPath);
    if (!existsSync(absolutePath)) throw new Error(`SEMANTIC_DIFF_REQUIRED: task identity context missing: ${indexPath}`);
    return { path: indexPath, body: readFileSync(absolutePath, "utf8") };
  });
}

function isManagedDocumentCandidate(documentPath: string): boolean {
  return /^decisions\/decision-[^/]+\/decision\.md$/u.test(documentPath)
    || /^tasks\/[^/]+\/[^/]+\.md$/u.test(documentPath)
    || documentPath === "modules.json"
    || /^sessions\/[^/]+\.md$/u.test(documentPath)
    || /^tasks\/[^/]+\/(?:executions|reviews)\//u.test(documentPath);
}

function scriptRunEntityId(operationId: string): EntityId {
  return `entity/script-run/${sha256Text(operationId).slice(0, 32)}`;
}
