export const blankedCliTestEnvKeys = [
  "HARNESS_AUTHORITY_MANIFEST",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "ZCODE_SESSION_ID",
  "ANTIGRAVITY_SESSION_ID"
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
