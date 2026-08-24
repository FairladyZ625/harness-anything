import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseDecisionValidation(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const selector = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags(id, args.slice(selector ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (Boolean(selector) === f.booleans.has("--all"))
    return rejectInput(inputs, id, "--all", json);
  return accepted(rootDir, repoId, json, {
    kind: "decision-validate",
    ...(selector ? { decisionId: selector } : { all: true }),
  });
}

export function parseDecisionRepin(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const selector = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags("decision-repin", args.slice(selector ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (Boolean(selector) === f.booleans.has("--all"))
    return rejectInput(inputs, "decision-repin", "--all", json);
  return accepted(rootDir, repoId, json, {
    kind: "decision-repin",
    ...(selector ? { decisionId: selector } : { all: true }),
    migrationEvidence: f.one.get("--migration-evidence"),
  });
}

export function parseDecisionTransition(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const targetState = args[2],
    decisionId = args[3];
  if (
    !nonEmpty(decisionId) ||
    ![
      "in_effect",
      "rejected",
      "deferred",
      "superseded",
      "outcome_retired",
    ].includes(targetState ?? "")
  )
    return rejected(
      "invalid_field",
      "Use decision transition <in_effect|rejected|deferred|superseded|outcome_retired> <id>.",
      json,
    );
  const f = readFlags("decision-transition", args.slice(4), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const acceptOnly =
    f.booleans.has("--standing-policy") ||
    f.one.has("--judgment-only") ||
    (f.many.get("--fulfillment")?.length ?? 0) > 0;
  if (targetState !== "in_effect" && acceptOnly)
    return rejected(
      "invalid_field",
      "Judgment, standing policy, and fulfillment options are only valid for the in_effect transition.",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "decision-transition",
    decisionId,
    targetState,
    ...(f.one.get("--decided-at")
      ? { decidedAt: f.one.get("--decided-at") }
      : {}),
    judgmentOnlyRationale: f.one.get("--judgment-only") ?? null,
    standingPolicy: f.booleans.has("--standing-policy"),
    fulfillments: parseFulfillments(f.many.get("--fulfillment") ?? []),
    dryRun: f.booleans.has("--dry-run"),
  });
}

export function parseDecisionAmend(
  decisionId: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("decision-amend", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const body = f.one.get("--body"),
    bodyFile = f.one.get("--body-file"),
    load = f.one.get("--load-bearing"),
    nonLoad = f.one.get("--non-load-bearing");
  if (body !== undefined && bodyFile !== undefined)
    return rejectInput(inputs, "decision-amend", "--body-file", json);
  if (load && nonLoad)
    return rejectInput(inputs, "decision-amend", "--non-load-bearing", json);
  const action = {
    kind: "decision-amend",
    decisionId,
    ...(f.one.get("--title") ? { title: f.one.get("--title") } : {}),
    standingPolicy: f.booleans.has("--standing-policy"),
    fulfillments: parseFulfillments(f.many.get("--fulfillment") ?? []),
    ...(load
      ? { loadBearing: { claimId: load, value: true } }
      : nonLoad
        ? { loadBearing: { claimId: nonLoad, value: false } }
        : {}),
    sets: f.many.get("--set") ?? [],
    appends: f.many.get("--append") ?? [],
    ...(body !== undefined ? { body } : bodyFile ? { bodyFile } : {}),
    dryRun: f.booleans.has("--dry-run"),
  };
  if (
    !action.title &&
    !action.standingPolicy &&
    !action.fulfillments.length &&
    !action.loadBearing &&
    !action.sets.length &&
    !action.appends.length &&
    body === undefined &&
    !bodyFile
  )
    return rejected(
      "invalid_field",
      "Decision amend requires at least one machine-field or body change.",
      json,
    );
  return accepted(rootDir, repoId, json, action);
}

export function parseFulfillments(
  values: readonly string[],
): readonly { readonly claimId: string; readonly mode: string }[] {
  return values.map((value) => {
    const [claimId, mode] = value.split(":");
    return { claimId: claimId!, mode: mode! };
  });
}
