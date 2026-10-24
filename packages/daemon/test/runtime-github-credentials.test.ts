// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import {
  applyGithubLaunchCredential,
  githubCredentialUnavailableNotice,
  resolveOperatorGithubToken,
  withGithubCredentialWarnings,
} from "../src/runtime-github-credentials.ts";
import { scrubProviderValue } from "../src/secret-scrub.ts";

const installation: RuntimeInstallationWitness = {
  installationId: "codex-github-inheritance",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "1.0.0",
  observedAt: "2026-08-25T00:00:00.000Z",
};

function instanceStore(
  userRoot: string,
  options: { readonly token?: string | null; readonly env?: NodeJS.ProcessEnv } = {},
) {
  return openRuntimeInstanceStore({
    userRoot,
    discover: () => [installation],
    env: options.env ?? { PATH: "/runtime/tools", HOME: "/operator/home", LANG: "C" },
    resolveCredential: () => "instance-secret",
    resolveGithubToken: async () => (options.token === undefined ? "gho_launchTokenValue" : options.token),
    subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
  });
}

// An api-key codex instance must be enforced; the operator environment is exercised through a
// subscription launch, which is the isolation state that instance kind allows there.
function createCodex(
  store: ReturnType<typeof instanceStore>,
  instanceId: string,
  state: "enforced" | "operator-environment",
): void {
  store.create({
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    isolationState: state,
    codex: {},
    auth:
      state === "enforced"
        ? { mode: "api-key", credentialRef: "credential:v1:codex-github-inheritance" }
        : { mode: "subscription" },
  });
}

test("both isolation states receive the operator token and the github.com gh helper", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-inheritance-"));
  try {
    const store = instanceStore(userRoot);
    createCodex(store, "codex-enforced", "enforced");
    createCodex(store, "codex-operator", "operator-environment");
    for (const instanceId of ["codex-enforced", "codex-operator"]) {
      const launch = await store.prepareLaunch(instanceId, { cwd: "/workspace/repo", prompt: "Publish" });
      assert.equal(launch.env.GH_TOKEN, "gho_launchTokenValue", instanceId);
      assert.equal(launch.env.GIT_CONFIG_COUNT, "2", instanceId);
      assert.equal(launch.env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper", instanceId);
      assert.equal(launch.env.GIT_CONFIG_VALUE_0, "", instanceId);
      assert.equal(launch.env.GIT_CONFIG_KEY_1, "credential.https://github.com.helper", instanceId);
      assert.equal(launch.env.GIT_CONFIG_VALUE_1, "!gh auth git-credential", instanceId);
      assert.equal(launch.githubCredentialNotice, undefined, instanceId);
      // The helper is scoped to github.com: GitLab is not redirected by this contract.
      assert.equal(
        Object.keys(launch.env).some((key) => key.startsWith("GIT_CONFIG_") && key.includes("gitlab")),
        false,
      );
    }
    // An enforced instance still isolates model configuration; the credential is not a file there.
    const isolated = await store.prepareLaunch("codex-enforced", { cwd: "/workspace/repo", prompt: "Publish" });
    assert.equal(isolated.env.HOME, path.join(userRoot, "runtime-instances", "codex-enforced", "home"));
    assert.equal(
      readFileSync(path.join(isolated.env.CODEX_HOME!, "config.toml"), "utf8").includes("gho_launchTokenValue"),
      false,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a missing operator login still launches and reports the notice without the credential", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-absent-"));
  try {
    const store = instanceStore(userRoot, { token: null });
    createCodex(store, "codex-no-login", "enforced");
    const launch = await store.prepareLaunch("codex-no-login", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.equal(launch.env.GH_TOKEN, undefined);
    assert.equal(launch.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(launch.githubCredentialNotice, githubCredentialUnavailableNotice);
    assert.match(launch.githubCredentialNotice!, /cannot push, open a pull request, or read CI logs/u);
    assert.equal(launch.env.HOME, path.join(userRoot, "runtime-instances", "codex-no-login", "home"));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the token reaches only the child environment, never a persisted artifact or receipt", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-secret-"));
  try {
    const store = instanceStore(userRoot),
      token = "gho_launchTokenValue";
    createCodex(store, "codex-secret", "enforced");
    const launch = await store.prepareLaunch("codex-secret", { cwd: "/workspace/repo", prompt: "Publish" }),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-secret" });
    // The env is the delivery channel; the persisted surfaces are the leak boundaries.
    assert.equal(launch.env.GH_TOKEN, token);
    assert.equal(JSON.stringify(shown).includes(token), false);
    assert.equal(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8").includes(token), false);
    // The exact value is registered for scrubbing even under an unprefixed key.
    assert.equal(
      scrubProviderValue({ nested: { note: `pushed with ${token}` } }).nested.note,
      "pushed with [REDACTED]",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("an inherited token wins, and both absences are ordinary answers rather than errors", async (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let spawned = 0;
  const inherited = await resolveOperatorGithubToken(
    { PATH: bin, GH_TOKEN: "gho_inheritedToken" },
    "linux",
    async () => {
      spawned += 1;
      return { exitCode: 0, stdout: "gho_spawnedToken\n", stderr: "" };
    },
  );
  assert.equal(inherited, "gho_inheritedToken");
  assert.equal(spawned, 0, "an inherited token never spawns gh");
  // A signed-out gh answers with a non-zero exit and no token: that is a notice, not a failure.
  assert.equal(
    await resolveOperatorGithubToken({ PATH: bin }, "linux", async (command, args) => {
      spawned += 1;
      assert.equal(command, path.join(bin, "gh"));
      assert.deepEqual(args, ["auth", "token", "--hostname", "github.com"]);
      return { exitCode: 1, stdout: "", stderr: "no oauth token found for github.com" };
    }),
    null,
  );
  // So does a machine with no gh on the operator PATH at all.
  assert.equal(
    await resolveOperatorGithubToken({ PATH: path.join(bin, "absent") }, "linux", async () => {
      spawned += 1;
      return { exitCode: 0, stdout: "unexpected\n", stderr: "" };
    }),
    null,
  );
  assert.equal(spawned, 1, "the absent-gh path spawns nothing");
  // A count whose entries are incomplete makes git reject the environment, so it contributes 0.
  const patched: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "operator",
  };
  assert.equal(applyGithubLaunchCredential(patched, "gho_launchTokenValue"), undefined);
  assert.equal(patched.GIT_CONFIG_COUNT, "3");
  assert.equal(patched.GIT_CONFIG_KEY_0, "user.name");
  assert.equal(patched.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.equal(patched.GIT_CONFIG_VALUE_1, "");
  assert.equal(patched.GIT_CONFIG_KEY_2, "credential.https://github.com.helper");
});

test("a spawn receipt carries the missing-login notice without displacing prior warnings", () => {
  const receipt = { schema: "command-receipt/v2", ok: true, runtimeSessionId: "runtime_x" };
  assert.equal(withGithubCredentialWarnings(receipt, undefined), receipt, "a healthy launch adds no field");
  assert.deepEqual(withGithubCredentialWarnings(receipt, githubCredentialUnavailableNotice).warnings, [
    githubCredentialUnavailableNotice,
  ]);
  assert.deepEqual(
    withGithubCredentialWarnings({ ...receipt, warnings: ["existing"] }, githubCredentialUnavailableNotice).warnings,
    ["existing", githubCredentialUnavailableNotice],
  );
  assert.doesNotMatch(
    JSON.stringify(withGithubCredentialWarnings(receipt, githubCredentialUnavailableNotice)),
    /gho_/u,
  );
});

test(
  "the injected helper resolves the token, and the instance home's stale helper never runs",
  { skip: process.platform === "win32" ? "requires POSIX shell semantics for the git credential helper" : false },
  () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-git-")),
      bin = path.join(workspace, "bin"),
      staleMarker = path.join(workspace, "stale-invoked"),
      ghMarker = path.join(workspace, "gh-invoked");
    try {
      // An instance-style stale helper: it would answer with its own credential, and marks that
      // git consulted it. The launch's empty helper assignment must keep it from running.
      const staleHelper = path.join(workspace, "stale-helper.sh");
      writeFileSync(
        staleHelper,
        `#!/bin/sh\n: > '${staleMarker}'\ncat >/dev/null\nprintf 'username=stale\\npassword=stale-token\\n'\n`,
        {
          mode: 0o755,
        },
      );
      writeFileSync(path.join(workspace, ".gitconfig"), `[credential]\n\thelper = ${staleHelper}\n`);
      // A `gh` stub speaking the credential-helper protocol, so this stays independent of any
      // machine login while still exercising the exact helper command the launch injects.
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/sh\n: > '${ghMarker}'\ncat >/dev/null\nprintf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"\n`,
        { mode: 0o755 },
      );
      const environment: NodeJS.ProcessEnv = {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: workspace,
      };
      assert.equal(applyGithubLaunchCredential(environment, "gho_launchTokenValue"), undefined);
      const filled = execFileSync(
        "sh",
        ["-c", "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"],
        {
          env: environment,
          encoding: "utf8",
        },
      );
      assert.match(filled, /password=gho_launchTokenValue/u);
      assert.equal(existsSync(ghMarker), true, "git must reach the injected gh helper");
      assert.equal(existsSync(staleMarker), false, "an instance home's stale helper must not be consulted");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
