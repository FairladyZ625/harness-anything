import path from "node:path";

export interface DecisionReadinessProjection {
  readonly schema: "decision-readiness/v1";
  readonly basisCommitSha: string;
  readonly appliesToDrift: { readonly state: "clear" | "drift" | "unknown"; readonly paths: readonly string[]; readonly lastCommitAt: string | null; readonly summary: string };
  readonly conflictMarker: { readonly state: "clear" | "conflict" | "unknown"; readonly paths: readonly string[]; readonly summary: string };
}
interface ScopedDecision { readonly decisionId: string; readonly proposedAt: string; readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] } }
export interface DecisionReadinessSource { readonly run: (rootDir: string, args: readonly string[], allowNoMatch?: boolean) => { readonly ok: boolean; readonly stdout: string } }

export function projectDecisionReadiness(input: { readonly rootDir: string; readonly commitSha: string; readonly decisions: readonly ScopedDecision[] }, source: DecisionReadinessSource): readonly DecisionReadinessProjection[] {
  const basis = input.commitSha, tree = /^[0-9a-f]{40}$/u.test(basis) ? source.run(input.rootDir, ["ls-tree", "-r", "--name-only", basis]) : { ok: false as const, stdout: "" };
  if (!tree.ok) return input.decisions.map(() => unknown(basis, "The canonical Git cut is unavailable."));
  const files = tree.stdout.split("\n").filter(Boolean).sort();
  return input.decisions.map((decision) => projectOne(input.rootDir, basis, files, decision, source));
}

function projectOne(rootDir: string, basis: string, files: readonly string[], decision: ScopedDecision, source: DecisionReadinessSource): DecisionReadinessProjection {
  const scope = resolveScope(decision.appliesTo.modules, files);
  if (!scope.paths.length) return unknown(basis, scope.reason);
  const since = Date.parse(decision.proposedAt), driftRead = Number.isFinite(since) ? source.run(rootDir, ["log", "--format=", "--name-only", `--since=${decision.proposedAt}`, basis, "--", ...scope.roots]) : { ok: false as const, stdout: "" };
  const changed = driftRead.ok ? unique(driftRead.stdout.split("\n").filter((entry) => scope.paths.includes(entry))) : [];
  const last = changed.length ? source.run(rootDir, ["log", "-1", "--format=%cI", basis, "--", ...changed]) : { ok: true as const, stdout: "" };
  const conflictRead = source.run(rootDir, ["grep", "-n", "-I", "-E", "^(<<<<<<<|=======|>>>>>>>)", basis, "--", ...scope.roots], true);
  const conflicting = conflictRead.ok ? conflictPaths(conflictRead.stdout) : [];
  const scopeUnknown = scope.unresolved.length > 0, driftUnknown = !Number.isFinite(since) || !driftRead.ok || changed.length > 0 && !last.ok, conflictUnknown = !conflictRead.ok;
  const appliesToDrift: DecisionReadinessProjection["appliesToDrift"] = changed.length ? { state: "drift", paths: changed, lastCommitAt: last.stdout || null, summary: `${changed.length} canonical applies_to path(s) changed after proposal.` } : driftUnknown || scopeUnknown ? { state: "unknown", paths: [], lastCommitAt: null, summary: driftUnknown ? "The proposal timestamp or canonical Git history is unavailable." : scope.reason } : { state: "clear", paths: scope.roots, lastCommitAt: null, summary: "No canonical applies_to path changed after proposal." };
  const conflictMarker: DecisionReadinessProjection["conflictMarker"] = conflicting.length ? { state: "conflict", paths: conflicting, summary: `${conflicting.length} canonical applies_to path(s) contain committed conflict markers.` } : conflictUnknown || scopeUnknown ? { state: "unknown", paths: [], summary: conflictUnknown ? "The canonical conflict-marker scan is unavailable." : scope.reason } : { state: "clear", paths: scope.roots, summary: "No committed conflict marker exists in canonical applies_to paths." };
  return { schema: "decision-readiness/v1", basisCommitSha: basis, appliesToDrift, conflictMarker };
}

function resolveScope(modules: readonly string[], files: readonly string[]): { readonly roots: readonly string[]; readonly paths: readonly string[]; readonly unresolved: readonly string[]; readonly reason: string } {
  const roots: string[] = [], unresolved: string[] = [];
  for (const raw of modules) { const normalized = raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, ""); if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) { unresolved.push(raw); continue; } const candidates = normalized.startsWith("packages/") ? [normalized] : [normalized, `packages/${normalized}`], root = candidates.find((candidate) => files.some((file) => file === candidate || file.startsWith(`${candidate}/`))); if (root) roots.push(root); else unresolved.push(raw); }
  const uniqueRoots = unique(roots), paths = files.filter((file) => uniqueRoots.some((root) => file === root || file.startsWith(`${root}/`))); return { roots: uniqueRoots, paths, unresolved, reason: modules.length === 0 ? "Decision applies_to has no repository path-bearing module." : unresolved.length ? `Unresolved canonical applies_to module(s): ${unresolved.join(", ")}.` : "Canonical applies_to scope is unavailable." };
}
function unknown(basisCommitSha: string, summary: string): DecisionReadinessProjection { return { schema: "decision-readiness/v1", basisCommitSha, appliesToDrift: { state: "unknown", paths: [], lastCommitAt: null, summary }, conflictMarker: { state: "unknown", paths: [], summary } }; }
function unique(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function conflictPaths(stdout: string): readonly string[] { const markers = new Map<string, Set<string>>(); for (const line of stdout.split("\n")) { const match = /^(?:[0-9a-f]{40}:)?([^:]+):[0-9]+:(<<<<<<<|=======|>>>>>>>)/u.exec(line); if (!match) continue; const found = markers.get(match[1]!) ?? new Set<string>(); found.add(match[2]!); markers.set(match[1]!, found); } return [...markers].filter(([, found]) => found.size === 3).map(([file]) => file).sort(); }
