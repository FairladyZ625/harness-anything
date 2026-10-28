// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { runtimeKinds } from "../src/runtime-inventory.ts";

/**
 * Launch-config bearing assertions for the 12 ACP providers introduced in PR #2779.
 * Until now catalog coverage only asserted kind membership: the executable command, the
 * argument template an instance actually launches with, and the authenticate method could
 * all drift silently. Each row here is the launch contract of one provider — a change to
 * any cell must be a deliberate contract edit, not an unnoticed catalog refactor.
 */
const acpLaunchContracts = [
  {
    kindId: "copilot",
    command: "copilot",
    argumentTemplate: ["--acp"],
    acpAuthMethod: "copilot-login",
  },
  { kindId: "auggie", command: "auggie", argumentTemplate: ["--acp"] },
  {
    kindId: "droid",
    command: "droid",
    argumentTemplate: ["exec", "--output-format", "acp-daemon"],
    acpAuthMethod: "factory-api-key",
    acpCredentialKey: "factory_api_key",
  },
  { kindId: "grok", command: "grok", argumentTemplate: ["agent", "stdio"], acpAuthMethod: "grok.com" },
  { kindId: "kimi", command: "kimi", argumentTemplate: ["acp"] },
  {
    kindId: "qwen-code",
    command: "qwen",
    argumentTemplate: ["--acp"],
    acpAuthMethod: "openai",
    acpCredentialKey: "openai_api_key",
  },
  { kindId: "minimax-code", command: "mcode", argumentTemplate: ["acp"] },
  { kindId: "mistral-vibe", command: "vibe-acp", argumentTemplate: [], acpAuthMethod: "browser-auth" },
  { kindId: "junie", command: "junie", argumentTemplate: ["--acp=true"] },
  { kindId: "codebuddy", command: "codebuddy", argumentTemplate: ["--acp"] },
  { kindId: "glm-acp", command: "glm-acp-agent", argumentTemplate: [], acpAuthMethod: "z-ai-api-key" },
  { kindId: "agy-acp", command: "agy_acp_server", argumentTemplate: [], acpAuthMethod: "gemini-api-key" },
] as const;

test("the 12 ACP provider launch contracts stay pinned", () => {
  assert.equal(acpLaunchContracts.length, 12);
  assert.equal(new Set(acpLaunchContracts.map(({ kindId }) => kindId)).size, 12);
  for (const expected of acpLaunchContracts) {
    const kind = runtimeKinds.find((entry) => entry.kindId === expected.kindId);
    assert.ok(kind, `runtime kind ${expected.kindId} must stay in the inventory`);
    assert.equal(kind.protocolFamily, "acp", expected.kindId);
    assert.equal(kind.executable.command, expected.command, `${expected.kindId} executable.command`);
    assert.deepEqual(kind.launch.argumentTemplate, expected.argumentTemplate, `${expected.kindId} argumentTemplate`);
    assert.equal(kind.auth.acpAuthMethod, expected.acpAuthMethod, `${expected.kindId} acpAuthMethod`);
    assert.equal(kind.auth.acpCredentialKey, expected.acpCredentialKey, `${expected.kindId} acpCredentialKey`);
  }
});

test("Codex and Claude declare steer resume, every ACP kind steers in place, others declare nothing", () => {
  const codex = runtimeKinds.find((entry) => entry.kindId === "codex")!,
    claude = runtimeKinds.find((entry) => entry.kindId === "claude")!;
  const resumeSteer = (kind: (typeof runtimeKinds)[number]) => {
    assert.equal(kind.steer?.strategy, "interrupt-resume", `${kind.kindId} must restart through resume`);
    return kind.steer as Extract<NonNullable<typeof kind.steer>, { strategy: "interrupt-resume" }>;
  };
  // The mode matrix has its own test below; this one pins the declaration itself and the shape
  // transitions both call sites perform, so it uses the production builder rather than a toy argv.
  const codexResume = resumeSteer(codex).resumeArgs(codexLaunchArgs("workspace-write"), "thread-123");
  // `codex exec resume` has its own parser and rejects `--sandbox` (exit 2), so the fresh
  // permission block must be replaced by the declared resume block for the same mode.
  assert.deepEqual(codexResume, [
    "exec",
    "resume",
    "--json",
    "--config",
    'sandbox_mode="workspace-write"',
    "--config",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "--config",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="high"',
    "thread-123",
    "-",
  ]);
  assert.equal(codexResume.includes("--sandbox"), false, "codex resume must never carry --sandbox");
  // A dispatch already resumed (steered a second time) keeps the mode's resume block and has its
  // session id replaced; the block is not appended twice.
  assert.deepEqual(
    codexResumeArgs([
      "exec",
      "resume",
      "--json",
      "--config",
      'sandbox_mode="read-only"',
      "--model",
      "o4-mini",
      "thread-old",
      "-",
    ]),
    ["exec", "resume", "--json", "--config", 'sandbox_mode="read-only"', "--model", "o4-mini", "thread-123", "-"],
  );
  assert.deepEqual(resumeSteer(claude).resumeArgs(["-p", "--output-format", "stream-json"], "session-123"), [
    "-p",
    "--output-format",
    "stream-json",
    "--resume",
    "session-123",
  ]);
  // ACP agents answer session/cancel by ending the turn, so they keep the session and reprompt;
  // they never restart through resume args.
  for (const kind of runtimeKinds.filter((entry) => entry.protocolFamily === "acp")) {
    assert.deepEqual(kind.steer, { strategy: "cancel-reprompt" }, `${kind.kindId} steer strategy`);
  }
  // codex-acp is the kind Astra-style API workers run on; it must be steerable.
  assert.deepEqual(runtimeKinds.find((entry) => entry.kindId === "codex-acp")!.steer, {
    strategy: "cancel-reprompt",
  });
  // Non-ACP kinds without a resume contract keep refusing: agy has no steer declaration.
  assert.equal(runtimeKinds.find((entry) => entry.kindId === "agy")!.steer, undefined);
  assert.equal(runtimeKinds.find((entry) => entry.kindId === "zcode")!.steer, undefined);
  assert.equal(
    runtimeKinds.filter((entry) => entry.steer?.strategy === "interrupt-resume").length,
    2,
    "only the CLI resume kinds restart a process",
  );
});

/** Production fresh-launch argv for one codex permission mode: what `prepareLaunch` hands the
 * worker host. Driving the real builder keeps this test off a hand-written toy argv. */
function codexLaunchArgs(
  mode: "bypass" | "workspace-write" | "read-only",
  callbackRelayPath?: string,
): readonly string[] {
  return launchArgs(
    {
      schemaVersion: 2,
      instanceId: "codex-open",
      name: "Codex Open",
      kindId: "codex",
      installationId: "codex-installation",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "enforced",
      auth: { mode: "subscription" },
      codex: { reasoningEffort: "high" },
    },
    "gpt-5.6-sol",
    "mission",
    undefined,
    "high",
    mode,
    false,
    callbackRelayPath,
  );
}

const codexResumeArgs = (args: readonly string[], thread = "thread-123"): readonly string[] => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "codex")!;
  return (kind.steer as Extract<NonNullable<typeof kind.steer>, { strategy: "interrupt-resume" }>).resumeArgs(
    args,
    thread,
  );
};

test("Codex resume rebuilds each mode's declared resume permission block instead of the fresh one", () => {
  // Whole expected argv, not a slice patch: the assertion must fail on any positional drift, and
  // the production builder is what supplies the language-neutral tokens around the block.
  const expected = {
    bypass: [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
      "thread-123",
      "-",
    ],
    "workspace-write": [
      "exec",
      "resume",
      "--json",
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
      "thread-123",
      "-",
    ],
    "read-only": [
      "exec",
      "resume",
      "--json",
      "--config",
      'sandbox_mode="read-only"',
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
      "thread-123",
      "-",
    ],
  } as const;
  for (const mode of ["bypass", "workspace-write", "read-only"] as const) {
    const fresh = codexLaunchArgs(mode),
      resumed = codexResumeArgs(fresh);
    // The launch the dispatch actually made still carries the fresh block; the resume argv swaps
    // exactly that block for the mode's declared resume block, at the same position.
    assert.equal(fresh.includes("--sandbox"), true, `${mode} fresh argv carries --sandbox`);
    assert.deepEqual(resumed, expected[mode], `${mode} resume argv`);
    assert.equal(resumed.includes("--sandbox"), false, `${mode} resume must not carry the fresh --sandbox flag`);
    // Steering an in-flight resume is the second call site: rewriting must be idempotent, or a
    // second steer would duplicate the mode's config overrides.
    assert.deepEqual(codexResumeArgs(resumed), resumed, `${mode} resume of a resume argv`);
  }
});

test("Codex callback socket grant is emitted once for fresh and resume with workspace boundaries retained", () => {
  const relayPath = "/tmp/harness-anything-501/r-0123456789abcdef01234567.sock",
    grant = [
      "--config",
      'default_permissions="harness-callback-relay"',
      "--config",
      'permissions.harness-callback-relay.extends=":workspace"',
      "--config",
      'permissions.harness-callback-relay.filesystem={":slash_tmp"="read",":tmpdir"="read"}',
      "--config",
      `permissions.harness-callback-relay.network.unix_sockets={"${relayPath}"="allow"}`,
    ];
  const fresh = codexLaunchArgs("workspace-write", relayPath),
    resumed = codexResumeArgs(fresh);
  assert.deepEqual(fresh.slice(fresh.indexOf("--model") - grant.length, fresh.indexOf("--model") + 2), [
    ...grant,
    "--model",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual(resumed.slice(resumed.indexOf("--model") - grant.length, resumed.indexOf("--model") + 2), [
    ...grant,
    "--model",
    "gpt-5.6-sol",
  ]);
  assert.equal(fresh.filter((argument) => argument === 'default_permissions="harness-callback-relay"').length, 1);
  assert.equal(resumed.filter((argument) => argument === 'default_permissions="harness-callback-relay"').length, 1);
  for (const args of [fresh, resumed]) {
    assert.equal(args.includes("--sandbox"), false, "legacy sandbox selection overrides named profiles");
    assert.equal(
      args.some((argument) => /^sandbox_(mode|workspace_write)/u.test(argument)),
      false,
    );
  }
  assert.equal(
    fresh.some((argument) => argument.includes("writable_roots")),
    false,
  );
  assert.deepEqual(codexResumeArgs(resumed), resumed, "steering an already resumed session keeps one grant");
});

// The shape above is only correct if the real subcommand parser accepts it. `--help` is the
// cheapest honest probe: the parser runs to completion and prints usage without starting a
// session or needing credentials, so a rejected flag still exits 2.
test(
  "the real Codex CLI parses every declared resume argv and rejects the fresh permission block",
  {
    timeout: 30_000,
    skip: codexBinary() === null ? "requires the codex CLI on PATH to exercise its subcommand parser" : false,
  },
  () => {
    const binary = codexBinary()!;
    for (const mode of ["bypass", "workspace-write", "read-only"] as const) {
      const resumed = codexResumeArgs(codexLaunchArgs(mode)),
        accepted = spawnSync(binary, [...resumed, "--help"], { encoding: "utf8", env: codexProbeEnvironment() });
      assert.equal(
        accepted.status,
        0,
        `${mode} resume argv must parse: ${accepted.stderr.split("\n")[0] ?? ""} :: ${JSON.stringify(resumed)}`,
      );
    }
    // Negative control: the shape the first iteration produced. If the CLI ever starts accepting
    // --sandbox on resume, this arm turns red and the swap above is no longer needed.
    const rejected = spawnSync(
      binary,
      [
        "exec",
        "resume",
        "--json",
        "--sandbox",
        "danger-full-access",
        "--model",
        "gpt-5.6-sol",
        "thread-123",
        "-",
        "--help",
      ],
      { encoding: "utf8", env: codexProbeEnvironment() },
    );
    assert.equal(rejected.status, 2, "the fresh --sandbox flag must stay outside the resume parser");
    assert.match(rejected.stderr, /unexpected argument '--sandbox'/u);
  },
);

/** The Codex executable discovery would find, or null when this host has none. */
function codexBinary(): string | null {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" });
  const first = found.status === 0 ? found.stdout.trim().split(/\r?\n/u)[0] : "";
  return first && existsSync(first) ? first : null;
}

/** A throwaway CODEX_HOME so the probe never reads or writes the operator's session state. */
function codexProbeEnvironment(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "ha-codex-parser-probe-"));
  probeHomes.push(home);
  return { ...process.env, CODEX_HOME: home, RUST_LOG: "off" };
}
const probeHomes: string[] = [];
test.after(() => {
  for (const home of probeHomes) rmSync(home, { recursive: true, force: true });
  probeHomes.length = 0;
});

// The floor is catalog data, not a caller-side constant: discovery, the readiness probe,
// and the launch precheck all read this one field, so a provider that starts rejecting a
// model alias in an older build is a one-line contract edit here. Only kinds whose CLI has
// such a floor declare it — the absence means "no floor", never "unknown floor".
test("Claude Code declares its minimum CLI version and no other kind invents one", () => {
  const claude = runtimeKinds.find((entry) => entry.kindId === "claude")!;
  assert.equal(claude.executable.minimumVersion, "2.1.280");
  assert.deepEqual(
    runtimeKinds.filter((entry) => entry.executable.minimumVersion !== undefined).map((entry) => entry.kindId),
    ["claude"],
  );
});

// DeepSeek Harness 0.2.1-rc.2 (2026-10-18): the desktop App's bundled CLI is the only entry
// (nothing on PATH), `dsh --profile acp` takes no flags, and the sandbox/approval policy is
// the DSH_PERMISSION_MODE environment variable (asar acp profile: sandbox-policy.mode and
// user-approval.policy both read it; only danger-full-access turns approval off).
test("the DeepSeek Harness launch contract keeps subscription shared and enables isolated API overrides", () => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "deepseek-harness")!;
  assert.ok(kind);
  assert.equal(kind.protocolFamily, "acp");
  assert.equal(kind.executable.command, "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh");
  assert.equal(kind.executable.configHomeEnvironment, "DSH_HOME");
  assert.equal(kind.executable.authFile, null);
  assert.deepEqual(kind.launch.argumentTemplate, ["--profile", "acp"]);
  assert.deepEqual(kind.launch.permissionEnvironment, {
    bypass: { DSH_PERMISSION_MODE: "danger-full-access" },
    "workspace-write": { DSH_PERMISSION_MODE: "workspace-write" },
    "read-only": { DSH_PERMISSION_MODE: "read-only" },
  });
  assert.deepEqual(kind.isolation, {
    defaultState: "operator-environment",
    states: ["operator-environment", "enforced"],
  });
  assert.deepEqual(kind.auth, {
    shape: "separate",
    modes: ["subscription", "api-key"],
    apiKeyIsolation: "enforced",
    subscriptionIsolation: "operator-environment",
    subscriptionProbe: ["--version"],
    subscriptionProbeTimeoutMs: 10_000,
    endpoints: { baseUrl: "optional" },
  });
  assert.deepEqual(kind.configuration.fields, { baseUrl: "url", wireApi: "identifier" });
  assert.deepEqual(kind.configuration.choices, {
    wireApi: ["openai-completions", "openai-responses", "anthropic-messages"],
  });
  assert.equal(kind.auth.acpAuthMethod, undefined);
  assert.deepEqual(kind.declaredCapabilities, ["structured_witness", "resume", "attach", "session_identity"]);
  assert.equal(kind.capabilities.resume, "supported");
  // Negative control: no other kind declares an environment-borne permission mapping.
  assert.deepEqual(
    runtimeKinds.filter((entry) => entry.launch.permissionEnvironment !== undefined).map((entry) => entry.kindId),
    ["deepseek-harness"],
  );
});

// Resume on an acp kind is a protocol negotiation (session/load vs session/resume from the
// initialize response, runtime-worker-acp.ts), so the catalog carries one family-level
// declaration and no per-kind launch flag: a hand-written resumeFlag would claim knowledge
// the negotiation owns. argv-resume kinds keep theirs.
test("every acp kind resumes through protocol negotiation with one family declaration", () => {
  const acpKinds = runtimeKinds.filter((entry) => entry.protocolFamily === "acp");
  assert.ok(acpKinds.length > 0);
  for (const kind of acpKinds) {
    assert.equal(kind.launch.resumeFlag, undefined, `${kind.kindId} must not carry a launch resumeFlag`);
    assert.equal(kind.capabilities.resume, "supported", `${kind.kindId} shares the family resume declaration`);
    assert.deepEqual(kind.declaredCapabilities, ["structured_witness", "resume", "attach", "session_identity"]);
  }
  const flagKinds = runtimeKinds.filter((entry) => entry.launch.resumeFlag !== undefined).map((entry) => entry.kindId);
  assert.deepEqual(flagKinds, ["claude", "codex", "agy", "zcode"]);
});
