import path from "node:path";
import type { DecisionReadinessProjection } from "@harness-anything/kernel";
export type { DecisionReadinessProjection } from "@harness-anything/kernel";
interface ScopedDecision {
  readonly decisionId: string;
  readonly proposedAt: string;
  readonly appliesTo: {
    readonly modules: readonly string[];
    readonly productLines: readonly string[];
  };
}
export interface DecisionReadinessSource {
  readonly run: (
    rootDir: string,
    args: readonly string[],
    allowNoMatch?: boolean,
  ) => { readonly ok: boolean; readonly stdout: string };
}

export function projectDecisionReadiness(
  input: {
    readonly rootDir: string;
    readonly commitSha: string;
    readonly decisions: readonly ScopedDecision[];
  },
  source: DecisionReadinessSource,
): readonly DecisionReadinessProjection[] {
  const basis = input.commitSha,
    tree = /^[0-9a-f]{40}$/u.test(basis)
      ? source.run(input.rootDir, ["ls-tree", "-r", "--name-only", basis])
      : { ok: false as const, stdout: "" };
  if (!tree.ok) return input.decisions.map(() => unknown(basis, "The canonical Git cut is unavailable."));
  const fileSet = new Set(tree.stdout.split("\n").filter(Boolean)),
    files = [...fileSet].sort(),
    projected = new Array<DecisionReadinessProjection>(input.decisions.length),
    scoped: Array<{
      readonly index: number;
      readonly decision: ScopedDecision;
      readonly scope: ReturnType<typeof resolveScope>;
      readonly since: number;
    }> = [];
  input.decisions.forEach((decision, index) => {
    const scope = resolveScope(decision.appliesTo.modules, files, fileSet);
    if (!scope.ranges.length) {
      projected[index] = unknown(basis, scope.reason);
      return;
    }
    scoped.push({
      index,
      decision,
      scope,
      since: Date.parse(decision.proposedAt),
    });
  });
  if (!scoped.length) return projected;
  const roots = unique(scoped.flatMap(({ scope }) => scope.roots)),
    valid = scoped.filter(({ since }) => Number.isFinite(since)),
    earliest = valid.reduce((found, row) => (row.since < found.since ? row : found), valid[0]);
  const driftRead = earliest
    ? source.run(input.rootDir, [
        "log",
        "--format=%x1e%cI",
        "--name-only",
        `--since=${earliest.decision.proposedAt}`,
        basis,
        "--",
        ...roots,
      ])
    : { ok: false as const, stdout: "" };
  const conflictRead = source.run(
      input.rootDir,
      ["grep", "-n", "-I", "-E", "^(<<<<<<<|=======|>>>>>>>)", basis, "--", ...roots],
      true,
    ),
    conflicts = conflictRead.ok ? conflictPaths(conflictRead.stdout) : new Set<string>();
  const { maxCommittedAtMsByPath, firstHistoryIndexByPath, commitTimes } = indexHistory(
    files,
    driftRead.ok ? driftRead.stdout : "",
  );
  const conflictingByPath = files.map((file) => conflicts.has(file));
  for (const { index, scope, since } of scoped) {
    const changed: string[] = [],
      conflicting: string[] = [];
    let lastSeenUntil = 0,
      firstHistoryIndex = Number.POSITIVE_INFINITY;
    // Walk the union of the sorted tree ranges once, preserving the previous sorted path output.
    for (const [start, end] of scope.ranges) {
      for (let position = Math.max(start, lastSeenUntil); position < end; position++) {
        if (maxCommittedAtMsByPath[position]! >= since) {
          changed.push(files[position]!);
          firstHistoryIndex = Math.min(firstHistoryIndex, firstHistoryIndexByPath[position]!);
        }
        if (conflictingByPath[position]) conflicting.push(files[position]!);
      }
      lastSeenUntil = Math.max(lastSeenUntil, end);
    }
    // Git log traversal order and committer timestamps can disagree after a merge.
    const lastCommitAt = commitTimes[firstHistoryIndex] ?? null;
    const scopeUnknown = scope.unresolved.length > 0,
      driftUnknown = !Number.isFinite(since) || !driftRead.ok || (changed.length > 0 && lastCommitAt === null),
      conflictUnknown = !conflictRead.ok;
    const appliesToDrift: DecisionReadinessProjection["appliesToDrift"] = changed.length
      ? {
          state: "drift",
          paths: changed,
          lastCommitAt,
          summary: `${changed.length} canonical applies_to path(s) changed after proposal.`,
        }
      : driftUnknown || scopeUnknown
        ? {
            state: "unknown",
            paths: [],
            lastCommitAt: null,
            summary: driftUnknown ? "The proposal timestamp or canonical Git history is unavailable." : scope.reason,
          }
        : {
            state: "clear",
            paths: scope.roots,
            lastCommitAt: null,
            summary: "No canonical applies_to path changed after proposal.",
          };
    const conflictMarker: DecisionReadinessProjection["conflictMarker"] = conflicting.length
      ? {
          state: "conflict",
          paths: conflicting,
          summary: `${conflicting.length} canonical applies_to path(s) contain committed conflict markers.`,
        }
      : conflictUnknown || scopeUnknown
        ? {
            state: "unknown",
            paths: [],
            summary: conflictUnknown ? "The canonical conflict-marker scan is unavailable." : scope.reason,
          }
        : {
            state: "clear",
            paths: scope.roots,
            summary: "No committed conflict marker exists in canonical applies_to paths.",
          };
    projected[index] = {
      schema: "decision-readiness/v1",
      basisCommitSha: basis,
      appliesToDrift,
      conflictMarker,
    };
  }
  return projected;
}

function resolveScope(
  modules: readonly string[],
  files: readonly string[],
  fileSet: ReadonlySet<string>,
): {
  readonly roots: readonly string[];
  readonly ranges: readonly (readonly [start: number, end: number])[];
  readonly unresolved: readonly string[];
  readonly reason: string;
} {
  const roots = new Set<string>(),
    ranges: Array<readonly [start: number, end: number]> = [],
    unresolved: string[] = [];
  for (const raw of modules) {
    const normalized = raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      unresolved.push(raw);
      continue;
    }
    const candidates = normalized.startsWith("packages/") ? [normalized] : [normalized, `packages/${normalized}`];
    let resolved = false;
    for (const candidate of candidates) {
      if (roots.has(candidate)) {
        resolved = true;
        break;
      }
      const prefix = `${candidate}/`,
        start = lowerBound(files, prefix),
        descendants = files[start]?.startsWith(prefix),
        exact = fileSet.has(candidate);
      if (!exact && !descendants) continue;
      roots.add(candidate);
      if (exact) {
        const position = lowerBound(files, candidate);
        ranges.push([position, position + 1]);
      }
      // The next code unit after "/" is "0", so this excludes sibling prefixes.
      if (descendants) ranges.push([start, lowerBound(files, `${candidate}0`)]);
      resolved = true;
      break;
    }
    if (!resolved) unresolved.push(raw);
  }
  return {
    roots: [...roots].sort(),
    ranges: ranges.sort(([left], [right]) => left - right),
    unresolved,
    reason:
      modules.length === 0
        ? "Decision applies_to has no repository path-bearing module."
        : unresolved.length
          ? `Unresolved canonical applies_to module(s): ${unresolved.join(", ")}.`
          : "Canonical applies_to scope is unavailable.",
  };
}
function lowerBound(files: readonly string[], key: string): number {
  let low = 0,
    high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (files[middle]! < key) low = middle + 1;
    else high = middle;
  }
  return low;
}
function unknown(basisCommitSha: string, summary: string): DecisionReadinessProjection {
  return {
    schema: "decision-readiness/v1",
    basisCommitSha,
    appliesToDrift: {
      state: "unknown",
      paths: [],
      lastCommitAt: null,
      summary,
    },
    conflictMarker: { state: "unknown", paths: [], summary },
  };
}
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
function indexHistory(files: readonly string[], stdout: string) {
  // Index only current tree paths. The tree positions also let scope ranges address these
  // observations directly without a path lookup for each decision.
  const positionByPath = new Map(files.map((file, index) => [file, index])),
    maxCommittedAtMsByPath = new Float64Array(files.length).fill(Number.NEGATIVE_INFINITY),
    firstHistoryIndexByPath = new Uint32Array(files.length),
    commitTimes: string[] = [];
  for (const block of stdout.split("\x1e").slice(1)) {
    const lines = block.split("\n"),
      committedAt = lines[0]!.trim(),
      committedAtMs = Date.parse(committedAt);
    if (!Number.isFinite(committedAtMs)) continue;
    const index = commitTimes.push(committedAt) - 1;
    for (let line = 1; line < lines.length; line++) {
      const position = positionByPath.get(lines[line]!);
      if (position === undefined) continue;
      const previous = maxCommittedAtMsByPath[position]!;
      if (previous === Number.NEGATIVE_INFINITY) firstHistoryIndexByPath[position] = index;
      if (committedAtMs > previous) maxCommittedAtMsByPath[position] = committedAtMs;
    }
  }
  return { maxCommittedAtMsByPath, firstHistoryIndexByPath, commitTimes };
}
function conflictPaths(stdout: string): ReadonlySet<string> {
  const markers = new Map<string, Set<string>>();
  for (const line of stdout.split("\n")) {
    const match = /^(?:[0-9a-f]{40}:)?([^:]+):[0-9]+:(<<<<<<<|=======|>>>>>>>)/u.exec(line);
    if (!match) continue;
    const found = markers.get(match[1]!) ?? new Set<string>();
    found.add(match[2]!);
    markers.set(match[1]!, found);
  }
  return new Set([...markers].filter(([, found]) => found.size === 3).map(([file]) => file));
}
