import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const gitIdentityFailurePattern = /Author identity unknown|unable to auto-detect email address|no email was given and auto-detection is disabled|Please tell me who you are/iu;

const inheritedIdentityKeys = [
  "EMAIL",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME"
];

// A local agent session points at transcript files under the developer's real
// HOME. Passing those identifiers into an empty HOME creates a combination CI
// can never have and lets tests accidentally consume the caller's session.
const inheritedAgentSessionKeys = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID"
];

export function createHermeticTestEnvironment(baseEnv = process.env) {
  const home = mkdtempSync(path.join(tmpdir(), "ha-test-home-"));
  const npmCache = baseEnv.npm_config_cache
    ?? baseEnv.NPM_CONFIG_CACHE
    ?? (baseEnv.HOME ? path.join(baseEnv.HOME, ".npm") : path.join(tmpdir(), "ha-npm-cache"));

  const env = {
    ...baseEnv,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // macOS Git can synthesize "user@host" even with both config files
    // disabled. CI cannot, so require an explicitly configured fixture
    // identity on every platform.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
    npm_config_cache: npmCache
  };
  for (const key of [...inheritedIdentityKeys, ...inheritedAgentSessionKeys]) delete env[key];

  return {
    home,
    env,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

export function gitFixtureIdentityGuidance(output) {
  if (!gitIdentityFailurePattern.test(output)) return null;
  return [
    "This test depends on a developer Git identity, which is unavailable in the hermetic test environment.",
    "Fix the fixture by providing its own identity, for example:",
    "  git -c user.email=harness@example.test -c user.name='Harness Test' commit ...",
    "Then rerun the same test command. Do not repair this by changing global gitconfig."
  ].join("\n");
}
