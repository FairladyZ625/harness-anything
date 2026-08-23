import path from "node:path";

export interface DecisionReadinessProjection {
  readonly schema: "decision-readiness/v1";
  readonly basisCommitSha: string;
  readonly appliesToDrift: {
    readonly state: "clear" | "drift" | "unknown";
    readonly paths: readonly string[];
    readonly lastCommitAt: string | null;
    readonly summary: string;
  };
  readonly conflictMarker: {
    readonly state: "clear" | "conflict" | "unknown";
    readonly paths: readonly string[];
    readonly summary: string;
  };
}
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
  if (!tree.ok)
    return input.decisions.map(() =>
      unknown(basis, "The canonical Git cut is unavailable."),
    );
  const files = tree.stdout.split("\n").filter(Boolean).sort(),
    projected: DecisionReadinessProjection[] = input.decisions.map(() =>
      unknown(basis, "The canonical applies_to scope is unavailable."),
    ),
    scoped: Array<{
      readonly index: number;
      readonly decision: ScopedDecision;
      readonly scope: ReturnType<typeof resolveScope>;
      readonly since: number;
    }> = [];
  input.decisions.forEach((decision, index) => {
    const scope = resolveScope(decision.appliesTo.modules, files);
    if (!scope.paths.length) {
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
    earliest = valid.reduce(
      (found, row) => (row.since < found.since ? row : found),
      valid[0],
    );
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
      : { ok: false as const, stdout: "" },
    history = driftRead.ok ? changeHistory(driftRead.stdout) : [];
  const conflictRead = source.run(
      input.rootDir,
      [
        "grep",
        "-n",
        "-I",
        "-E",
        "^(<<<<<<<|=======|>>>>>>>)",
        basis,
        "--",
        ...roots,
      ],
      true,
    ),
    allConflicting = conflictRead.ok ? conflictPaths(conflictRead.stdout) : [];
  for (const { index, scope, since } of scoped) {
    const changed =
        driftRead.ok && Number.isFinite(since)
          ? unique(
              history
                .filter(({ committedAtMs }) => committedAtMs >= since)
                .flatMap(({ paths }) => paths)
                .filter((entry) => scope.paths.includes(entry)),
            )
          : [],
      lastCommitAt = changed.length
        ? (history.find(({ paths }) =>
            paths.some((entry) => changed.includes(entry)),
          )?.committedAt ?? null)
        : null,
      conflicting = allConflicting.filter((entry) =>
        scope.paths.includes(entry),
      );
    const scopeUnknown = scope.unresolved.length > 0,
      driftUnknown =
        !Number.isFinite(since) ||
        !driftRead.ok ||
        (changed.length > 0 && lastCommitAt === null),
      conflictUnknown = !conflictRead.ok;
    const appliesToDrift: DecisionReadinessProjection["appliesToDrift"] =
      changed.length
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
              summary: driftUnknown
                ? "The proposal timestamp or canonical Git history is unavailable."
                : scope.reason,
            }
          : {
              state: "clear",
              paths: scope.roots,
              lastCommitAt: null,
              summary: "No canonical applies_to path changed after proposal.",
            };
    const conflictMarker: DecisionReadinessProjection["conflictMarker"] =
      conflicting.length
        ? {
            state: "conflict",
            paths: conflicting,
            summary: `${conflicting.length} canonical applies_to path(s) contain committed conflict markers.`,
          }
        : conflictUnknown || scopeUnknown
          ? {
              state: "unknown",
              paths: [],
              summary: conflictUnknown
                ? "The canonical conflict-marker scan is unavailable."
                : scope.reason,
            }
          : {
              state: "clear",
              paths: scope.roots,
              summary:
                "No committed conflict marker exists in canonical applies_to paths.",
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
): {
  readonly roots: readonly string[];
  readonly paths: readonly string[];
  readonly unresolved: readonly string[];
  readonly reason: string;
} {
  const roots: string[] = [],
    unresolved: string[] = [];
  for (const raw of modules) {
    const normalized = raw
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "")
      .replace(/\/+$/u, "");
    if (
      !normalized ||
      path.posix.isAbsolute(normalized) ||
      normalized.split("/").includes("..")
    ) {
      unresolved.push(raw);
      continue;
    }
    const candidates = normalized.startsWith("packages/")
        ? [normalized]
        : [normalized, `packages/${normalized}`],
      root = candidates.find((candidate) =>
        files.some(
          (file) => file === candidate || file.startsWith(`${candidate}/`),
        ),
      );
    if (root) roots.push(root);
    else unresolved.push(raw);
  }
  const uniqueRoots = unique(roots),
    paths = files.filter((file) =>
      uniqueRoots.some((root) => file === root || file.startsWith(`${root}/`)),
    );
  return {
    roots: uniqueRoots,
    paths,
    unresolved,
    reason:
      modules.length === 0
        ? "Decision applies_to has no repository path-bearing module."
        : unresolved.length
          ? `Unresolved canonical applies_to module(s): ${unresolved.join(", ")}.`
          : "Canonical applies_to scope is unavailable.",
  };
}
function unknown(
  basisCommitSha: string,
  summary: string,
): DecisionReadinessProjection {
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
function changeHistory(stdout: string): readonly {
  readonly committedAt: string;
  readonly committedAtMs: number;
  readonly paths: readonly string[];
}[] {
  return stdout
    .split("\x1e")
    .slice(1)
    .flatMap((block) => {
      const [rawCommittedAt, ...paths] = block.split("\n"),
        committedAt = rawCommittedAt?.trim() ?? "",
        committedAtMs = Date.parse(committedAt);
      return Number.isFinite(committedAtMs)
        ? [{ committedAt, committedAtMs, paths: paths.filter(Boolean) }]
        : [];
    });
}
function conflictPaths(stdout: string): readonly string[] {
  const markers = new Map<string, Set<string>>();
  for (const line of stdout.split("\n")) {
    const match =
      /^(?:[0-9a-f]{40}:)?([^:]+):[0-9]+:(<<<<<<<|=======|>>>>>>>)/u.exec(line);
    if (!match) continue;
    const found = markers.get(match[1]!) ?? new Set<string>();
    found.add(match[2]!);
    markers.set(match[1]!, found);
  }
  return [...markers]
    .filter(([, found]) => found.size === 3)
    .map(([file]) => file)
    .sort();
}
