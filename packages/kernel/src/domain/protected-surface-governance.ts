/**
 * The one classification of changed paths against manifest-declared protected surfaces.
 *
 * `tools/check-pr-governance.mjs` (the CI lint) and the PR-body renderer both read this module:
 * the lint judges a published body and the renderer writes the declaration from the same rules.
 * Keeping the judgment here makes "which file is protected" one answer rather than two.
 */

export interface ProtectedSurfaceRule {
  readonly display: string;
  readonly manifestSurfaces: readonly string[];
  readonly matcher: (file: string) => boolean;
}

export interface ProtectedSurfaceChange {
  readonly file: string;
  readonly surfaces: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deriveProtectedSurfaceRules(manifest: unknown): readonly ProtectedSurfaceRule[] {
  const gates = record(manifest) && Array.isArray(manifest.gates) ? manifest.gates : [];
  const rawSurfaces: string[] = [];
  for (const gate of gates) {
    if (!record(gate) || !record(gate.changeControl) || gate.changeControl.requiresGovernanceEvidence !== true)
      continue;
    const surfaces = Array.isArray(gate.changeControl.protectedSurfaces) ? gate.changeControl.protectedSurfaces : [];
    for (const surface of surfaces)
      if (typeof surface === "string" && surface.trim().length > 0) rawSurfaces.push(surface.trim());
  }

  const rulesByDisplay = new Map<
    string,
    { display: string; manifestSurfaces: string[]; matcher: (file: string) => boolean }
  >();
  for (const surface of rawSurfaces) {
    for (const display of normalizeManifestSurface(surface)) {
      const existing = rulesByDisplay.get(display);
      if (existing) {
        existing.manifestSurfaces.push(surface);
        continue;
      }
      rulesByDisplay.set(display, {
        display,
        manifestSurfaces: [surface],
        matcher: makeSurfaceMatcher(display),
      });
    }
  }

  return [...rulesByDisplay.values()].sort((left, right) => left.display.localeCompare(right.display));
}

export function classifyProtectedChanges(
  changedFiles: readonly string[],
  rules: readonly ProtectedSurfaceRule[],
): readonly ProtectedSurfaceChange[] {
  const matches: ProtectedSurfaceChange[] = [];
  for (const file of changedFiles.map(normalizePath).filter(Boolean)) {
    const matchingRules = rules.filter((rule) => rule.matcher(file));
    if (matchingRules.length === 0) continue;
    matches.push({ file, surfaces: matchingRules.map((rule) => rule.display) });
  }
  return matches;
}

function normalizeManifestSurface(surface: string): readonly string[] {
  const pathSurface = surface.split(":")[0] ?? "";
  const normalized = normalizePath(pathSurface);
  const surfaces = [normalized];

  if (normalized.startsWith(".github/")) surfaces.push(".github/**");
  if (normalized.startsWith("tools/gate-allowlists/")) surfaces.push("tools/gate-allowlists/**");

  return [...new Set(surfaces.filter(Boolean))];
}

function makeSurfaceMatcher(surface: string): (file: string) => boolean {
  if (surface.endsWith("/**")) {
    const prefix = surface.slice(0, -2);
    return (file) => file.startsWith(prefix);
  }
  if (surface.includes("*")) {
    const pattern = new RegExp(`^${escapeRegex(surface).replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*")}$`, "u");
    return (file) => pattern.test(file);
  }
  return (file) => file === surface;
}

function normalizePath(value: string): string {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+/u, "").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
