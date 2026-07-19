import { defaultRuntimeSessionEnvCandidates } from "../../../application/src/index.ts";

const runtimeSessionEnvKeys = defaultRuntimeSessionEnvCandidates.flatMap(({ keys }) => keys);

export const blankedCliTestEnvKeys = [
  "HARNESS_AUTHORITY_MANIFEST",
  ...runtimeSessionEnvKeys
] as const;

export function cliTestEnv(
  overrides: Readonly<NodeJS.ProcessEnv> = {},
  inheritedEnv: Readonly<NodeJS.ProcessEnv> = process.env
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnv,
    ...Object.fromEntries(blankedCliTestEnvKeys.map((key) => [key, ""])),
    ...overrides
  };
}
