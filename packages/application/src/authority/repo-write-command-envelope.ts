import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import {
  strictBoolean,
  strictEnum,
  strictLiteral,
  strictObject,
  strictString
} from "./strict-command-schema.ts";

export const compatibilitySunsetDecision = "dec_01KXQKTCKDDZF16QSMP5E5HFG1" as const;
export const authorityCutoverSunsetDecision = "dec_01KXSN6AVD6PSEB4CFCW8P2RQP" as const;
export const claimActivationFoldDecision = "dec_01KXWRC9CH70HN61B5FYPQP3XV" as const;

export type CommandDeprecationKind =
  | "alias-grammar"
  | "migration-command"
  | "cutover-command";

export interface DeprecatedCommandInvocation {
  readonly kind: CommandDeprecationKind;
  readonly commandKind: string;
  readonly syntax: string;
  readonly replacement: string;
  readonly sunsetStage: "warning";
  readonly decisionId:
    | typeof compatibilitySunsetDecision
    | typeof authorityCutoverSunsetDecision
    | typeof claimActivationFoldDecision;
}

const harnessLayoutOverrides = strictObject({}, {
  authoredRoot: strictString,
  localRoot: strictString,
  tasksRoot: strictString,
  generatedRoot: strictString,
  projectRootBoundary: strictBoolean
});

const deprecatedCommandInvocation = strictObject({
  kind: strictEnum("alias-grammar", "migration-command", "cutover-command"),
  commandKind: strictString,
  syntax: strictString,
  replacement: strictString,
  sunsetStage: strictLiteral("warning"),
  decisionId: strictEnum(
    compatibilitySunsetDecision,
    authorityCutoverSunsetDecision,
    claimActivationFoldDecision
  )
});

const layoutShapeSatisfiesContract = true satisfies
  ReturnType<typeof harnessLayoutOverrides.decode> extends HarnessLayoutOverrides
    ? true
    : never;
const deprecationShapeSatisfiesContract = true satisfies
  ReturnType<typeof deprecatedCommandInvocation.decode> extends DeprecatedCommandInvocation
    ? true
    : never;
void layoutShapeSatisfiesContract;
void deprecationShapeSatisfiesContract;

export function decodeRepoWriteHarnessLayoutOverrides(
  value: unknown,
  path = "$.layoutOverrides"
): HarnessLayoutOverrides {
  return harnessLayoutOverrides.decode(value, path);
}

export function decodeRepoWriteDeprecatedCommandInvocation(
  value: unknown,
  path = "$.deprecatedInvocation"
): DeprecatedCommandInvocation {
  return deprecatedCommandInvocation.decode(value, path);
}
