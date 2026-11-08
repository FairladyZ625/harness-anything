import { runtimeKindForId, type RuntimeProviderDeclaration } from "./runtime-inventory.ts";
import { runtimeWebSearchForConfig } from "./agent-runtime-web-search.ts";
import type { RuntimeInstanceConfig } from "./agent-runtime-instance-types.ts";

/** A witnessed CLI's version as a comparable triple, or null when the text carries none.
 *  Providers print the version in their own frame (`2.1.268 (Claude Code)`), so the triple
 *  is read out of the line instead of parsing the whole string. */
function versionTriple(version: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTriples(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return left[index]! > right[index]! ? 1 : -1;
  return 0;
}

/** The one refusal shared by installation discovery, the readiness probe, and the launch
 *  precheck. A kind declares its floor once on `executable.minimumVersion`; this comparison
 *  is the only place that floor is applied, so a probe and a dispatch can never disagree
 *  about whether the machine's CLI is usable.
 *
 *  An unreadable version fails closed: an unparseable build cannot be shown to meet the
 *  floor, and the cost of guessing wrong is a spawned provider that rejects the model only
 *  after the worker has been paid for. */
export function runtimeVersionGate(
  kindId: string,
  version: string,
): { readonly code: "minimum_version_not_met"; readonly hint: string } | null {
  // Read through the declaration contract, not the catalog's literal union: only one kind
  // declares a floor today, and the contract is where "absent means no floor" is stated.
  const kind: RuntimeProviderDeclaration = runtimeKindForId(kindId),
    minimum = kind.executable.minimumVersion;
  if (minimum === undefined) return null;
  if (runtimeVersionAtLeast(version, minimum)) return null;
  return {
    code: "minimum_version_not_met",
    hint:
      `${kind.displayName} ${version || "(no version reported)"} is below the supported minimum ` +
      `${minimum}; run \`${kind.executable.command} update\`, then re-check with ` +
      "`ha runtime instance show <instance-id> --probe`.",
  };
}

/** True only when both texts carry a comparable triple and the observed build is at or
 *  above the floor. An unreadable side is not "at least". */
export function runtimeVersionAtLeast(version: string, minimum: string): boolean {
  const observed = versionTriple(version),
    floor = versionTriple(minimum);
  return observed !== null && floor !== null && compareTriples(observed, floor) >= 0;
}

/** Search opt-in needs a CLI that recognizes the `web_search` config key; otherwise the
 *  argv would carry a tier the provider silently ignores. The default tier is exempt so
 *  existing default launches keep working on older builds, exactly like before #4369. */
export function runtimeWebSearchVersionGate(
  config: RuntimeInstanceConfig,
  version: string,
): { readonly code: "runtime_web_search_cli_unsupported"; readonly hint: string } | null {
  const kind = runtimeKindForId(config.kindId),
    declaration = kind.configuration.webSearch;
  if (declaration?.minimumVersion === undefined) return null;
  const mode = runtimeWebSearchForConfig(config);
  if (mode === null || mode === declaration.defaultMode) return null;
  if (runtimeVersionAtLeast(version, declaration.minimumVersion)) return null;
  return {
    code: "runtime_web_search_cli_unsupported",
    hint:
      `${kind.displayName} ${version || "(no version reported)"} cannot honor webSearch=${mode}; ` +
      `the native search config key requires ${declaration.minimumVersion} or newer. ` +
      `Run \`${kind.executable.command} update\`, or set webSearch=disabled for this instance.`,
  };
}
