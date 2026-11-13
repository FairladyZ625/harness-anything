// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { providerConfigDirectory } from "../src/agent-runtime-instance-storage.ts";
import { runtimeAuthArgs, runtimeKinds } from "../src/runtime-inventory.ts";
import { prepareBoundRuntimeLaunch } from "../src/runtime-spawn-context.ts";

test("runtime executable commands are bare names; platform paths belong in bundledEntries", () => {
  for (const { kindId, executable } of runtimeKinds) {
    assert.notEqual(executable.command, "", `${kindId} executable.command`);
    assert.doesNotMatch(executable.command, /[/\\]/u, `${kindId} executable.command must resolve through PATH`);
  }
});

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
  {
    kindId: "minimax-code",
    command: "mcode",
    argumentTemplate: ["acp"],
    configDirectory: ".minimax",
    authCommands: { login: ["login"], logout: ["logout"] },
  },
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
    // A kind's data directory is part of its launch contract too: mcode reads `~/.minimax`,
    // and a wrong cell makes every enforced instance read an empty login store.
    if ("configDirectory" in expected)
      assert.equal(kind.executable.configDirectory, expected.configDirectory, `${expected.kindId} configDirectory`);
    if ("authCommands" in expected)
      assert.deepEqual(kind.auth.commands, expected.authCommands, `${expected.kindId} auth commands`);
  }
});

test("minimax-code declares the data directory, sign-in argv and login-state probe its CLI actually uses", () => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "minimax-code")!,
    home = mkdtempSync(path.join(tmpdir(), "ha-minimax-declaration-"));
  try {
    // `mcode provider list` creates ~/.minimax in an empty HOME; `.minimax-code` is an
    // npm install-path heuristic inside the package, not the data directory.
    assert.equal(providerConfigDirectory(home, "minimax-code"), path.join(home, ".minimax"));
    assert.equal(kind.executable.authFile, "auth");
    // A command probe that exits 0 signed out cannot report readiness; the provider's own
    // auth-state document carries both status and expiry.
    assert.deepEqual(kind.auth.subscriptionProbe, {
      kind: "json-auth-state",
      file: "auth/prod/cn/mcode-public/auth-state.json",
      statusField: "status",
      readyStatus: "authenticated",
      expiresAtField: "expiresAtMs",
    });
    assert.notDeepEqual(kind.auth.subscriptionProbe, ["--version"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sign-in argv is generated from each kind's declaration", () => {
  // The store used to special-case codex and send every other kind `auth <action>`;
  // mcode has no `auth` subcommand, so the declaration is now the only source.
  assert.deepEqual(runtimeAuthArgs("minimax-code", "login"), ["login"]);
  assert.deepEqual(runtimeAuthArgs("minimax-code", "logout"), ["logout"]);
  assert.deepEqual(runtimeAuthArgs("codex", "login"), ["login"]);
  assert.deepEqual(runtimeAuthArgs("codex", "logout"), ["logout"]);
  // A kind that declares no top-level command keeps the existing form.
  assert.deepEqual(runtimeAuthArgs("claude", "login"), ["auth", "login"]);
  assert.deepEqual(runtimeAuthArgs("copilot", "logout"), ["auth", "logout"]);
});

test("Codex and Claude declare steer resume, every ACP kind steers in place, others declare nothing", () => {
  const codex = runtimeKinds.find((entry) => entry.kindId === "codex")!,
    claude = runtimeKinds.find((entry) => entry.kindId === "claude")!;
  assert.deepEqual(codex.unsettledTurnContinuation, claude.unsettledTurnContinuation);
  assert.deepEqual(codex.unsettledTurnContinuation, {
    maxContinuations: 3,
    prompt: "Continue the current task from where it left off.",
  });
  const resumeSteer = (kind: (typeof runtimeKinds)[number]) => {
    assert.equal(kind.steer?.strategy, "interrupt-resume", `${kind.kindId} must restart through resume`);
    return kind.steer as Extract<NonNullable<typeof kind.steer>, { strategy: "interrupt-resume" }>;
  };
  // The mode matrix has its own test below; this one pins the declaration itself and the shape
  // transitions both call sites perform, so it uses the production builder rather than a toy argv.
  const codexResume = resumeSteer(codex).resumeArgs(codexLaunchArgs("workspace-write"), "thread-123");
  assert.ok(codexResume !== null, "a production fresh-exec argv always resumes");
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
    "--config",
    'web_search="disabled"',
    "--config",
    'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
  for (const kind of runtimeKinds.filter((entry) => entry.protocolFamily === "acp" && entry.kindId !== "codex-acp"))
    assert.equal(kind.unsettledTurnContinuation, undefined, `${kind.kindId} leaves continuation disabled`);
  // Non-ACP kinds without a resume contract keep refusing: agy has no steer declaration.
  assert.equal(runtimeKinds.find((entry) => entry.kindId === "agy")!.steer, undefined);
  assert.equal(runtimeKinds.find((entry) => entry.kindId === "zcode")!.steer, undefined);
  assert.equal(
    runtimeKinds.filter((entry) => entry.steer?.strategy === "interrupt-resume").length,
    2,
    "only the CLI resume kinds restart a process",
  );
});

test("Codex resume refuses an argv it cannot express without throwing", () => {
  // The host records `continuation_refused` and settles on the evidence it already has. Null is
  // the contract: an exception here would escape the worker host and leave the dispatch unsettled.
  const codex = runtimeKinds.find((entry) => entry.kindId === "codex")!;
  const steer = codex.steer as Extract<NonNullable<typeof codex.steer>, { strategy: "interrupt-resume" }>;
  for (const [label, args] of [
    ["no exec subcommand", ["--json", "-"]],
    ["no exec stdin input", ["exec", "--json"]],
    ["no declared permission mode", ["exec", "--json", "-"]],
    [
      "a fresh sandbox block this transform does not recognise",
      ["exec", "--json", "--sandbox", "workspace-write", "-"],
    ],
  ] as const) {
    assert.equal(steer.resumeArgs(args, "thread-123"), null, label);
  }
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
  const resumed = (kind.steer as Extract<NonNullable<typeof kind.steer>, { strategy: "interrupt-resume" }>).resumeArgs(
    args,
    thread,
  );
  if (resumed === null) assert.fail(`codex resume argv was refused for ${JSON.stringify(args)}`);
  return resumed;
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
      "--config",
      'web_search="disabled"',
      "--config",
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}',
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
      'permissions.harness-callback-relay.filesystem={":slash_tmp"="deny",":tmpdir"="deny"}',
      "--config",
      "features.network_proxy=true",
      "--config",
      `permissions.harness-callback-relay.network={enabled=true,domains={},unix_sockets={"${relayPath}"="allow"}}`,
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
  return binaryOnPath("codex");
}

function binaryOnPath(command: string): string | null {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [command], { encoding: "utf8" });
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

// DeepSeek Harness: standalone CLIs resolve through PATH, with a macOS App bundle entry.
// `dsh --profile acp` takes no flags, and the sandbox/approval policy is
// the DSH_PERMISSION_MODE environment variable (asar acp profile: sandbox-policy.mode and
// user-approval.policy both read it; only danger-full-access turns approval off).
test("the DeepSeek Harness launch contract keeps subscription shared and enables isolated API overrides", () => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "deepseek-harness")!;
  assert.ok(kind);
  assert.equal(kind.protocolFamily, "acp");
  assert.equal(kind.executable.command, "dsh");
  assert.deepEqual(kind.executable.bundledEntries, {
    darwin: ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"],
  });
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
  assert.deepEqual(kind.configuration.fields, { baseUrl: "url", wireApi: "identifier", reasoningEffort: "effort" });
  assert.deepEqual(kind.configuration.choices, {
    wireApi: ["openai-completions", "openai-responses", "anthropic-messages"],
  });
  assert.equal(kind.auth.acpAuthMethod, undefined);
  assert.deepEqual(kind.acp?.effortSelector, {
    ids: ["reasoning_effort", "effort"],
    categories: ["thought_level"],
    valueMap: { minimal: "off" },
  });
  assert.deepEqual(kind.gui.effortValues, ["minimal", "low", "high", "max"]);
  assert.equal(kind.capabilities.effort, "supported");
  assert.deepEqual(kind.declaredCapabilities, ["structured_witness", "resume", "attach", "session_identity"]);
  assert.equal(kind.capabilities.resume, "supported");
  // Negative control: no other kind declares an environment-borne permission mapping.
  assert.deepEqual(
    runtimeKinds.filter((entry) => entry.launch.permissionEnvironment !== undefined).map((entry) => entry.kindId),
    ["deepseek-harness"],
  );
});

test("codex-acp declares dual auth routes and session effort negotiation", () => {
  const kind = runtimeKinds.find((entry) => entry.kindId === "codex-acp")!;
  assert.deepEqual(kind.auth.modes, ["subscription", "api-key"]);
  assert.equal(kind.auth.apiKeyIsolation, "enforced");
  assert.equal(kind.auth.subscriptionIsolation, undefined);
  assert.deepEqual(kind.isolation, {
    defaultState: "operator-environment",
    states: ["enforced", "operator-environment"],
  });
  assert.deepEqual(kind.auth.acpAuthMethod, { subscription: "chat-gpt", "api-key": "api-key" });
  assert.deepEqual(kind.configuration.fields, { reasoningEffort: "effort" });
  assert.deepEqual(kind.gui, {
    modelFamily: "codex-only",
    effort: "enum",
    effortValues: ["low", "medium", "high", "xhigh", "max"],
  });
  assert.equal(kind.capabilities.effort, "supported");
  assert.deepEqual(kind.unsettledTurnContinuation, {
    maxContinuations: 3,
    prompt: "Continue the current task from where it left off.",
  });
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

test("Codex subscription defaults to the operator environment while API keys remain isolated", () => {
  const codex = runtimeKinds.find((kind) => kind.kindId === "codex")!;
  assert.equal(codex.isolation.defaultState, "operator-environment");
  assert.equal(codex.auth.apiKeyIsolation, "enforced");
});

const expectedCodexShellEnvironmentFlag =
  'shell_environment_policy={inherit="all",ignore_default_excludes=true,exclude=[],include_only=[]}';
const expectedCodexShellEnvironmentObject = {
  inherit: "all",
  ignore_default_excludes: true,
  exclude: [],
  include_only: [],
};

test("Codex and Codex ACP launches declare full tool environment inheritance without exposing secrets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-codex-launch-env-contract-")),
    userRoot = path.join(root, "user"),
    operatorHome = path.join(root, "operator-home"),
    workdir = path.join(root, "repo"),
    credential = "test-fixture-contract-credential",
    githubToken = "test-fixture-contract-git-token";
  mkdirSync(operatorHome, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: operatorHome,
        CODEX_CONFIG: JSON.stringify({
          model_provider: "operator-custom",
          shell_environment_policy: { inherit: "core", ignore_default_excludes: false },
        }),
      },
      discover: () => [
        {
          installationId: "codex-contract",
          kindId: "codex",
          executablePath: "/opt/runtime-test/codex",
          version: "0.167.0",
          observedAt: "2026-11-13T00:00:00.000Z",
        },
        {
          installationId: "codex-acp-contract",
          kindId: "codex-acp",
          executablePath: "/opt/runtime-test/codex-acp",
          version: "2.6.0",
          observedAt: "2026-11-13T00:00:00.000Z",
        },
      ],
      resolveGithubToken: async () => githubToken,
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-operator",
      name: "Codex Operator",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-acp-operator",
      name: "Codex ACP Operator",
      kindId: "codex-acp",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    const bindDispatch = async (prepared: Awaited<ReturnType<typeof store.prepareLaunch>>) =>
      prepareBoundRuntimeLaunch({
        input: {
          rootDir: workdir,
          repoId: "repo-contract",
          now: () => "2026-11-13T00:00:00.000Z",
          remote: {
            executionCredential: () => ({ credential, expiresAt: "2026-11-13T01:00:00.000Z" }),
          } as never,
        },
        prepared,
        daemonRoute: { userRoot, daemonId: "daemon-contract", endpoint: "http://127.0.0.1:43999" },
        runtimeActor: "agent:runtime-session:runtime_contract",
        taskId: "task_76023d236f04c87144c5b6abde",
        execution: {
          personId: "operator",
          repoId: "repo-contract",
          runtimeSessionId: "runtime_contract",
          dispatchId: "dispatch_contract",
          taskId: "task_76023d236f04c87144c5b6abde",
          executionId: "execution_contract",
          role: "implementation",
          source: "local",
        },
      });

    const codexFresh = await bindDispatch(
        await store.prepareLaunch("codex-operator", { cwd: workdir, prompt: "Fresh" }),
      ),
      codexResumed = await bindDispatch(
        await store.prepareLaunch("codex-operator", {
          cwd: workdir,
          prompt: "Resumed",
          providerSessionId: "thread-contract",
        }),
      ),
      codexSteered = codexResumeArgs(codexFresh.args, "thread-steered");
    for (const [label, args] of [
      ["fresh", codexFresh.args],
      ["resumed", codexResumed.args],
      ["steered", codexSteered],
    ] as const) {
      const idx = args.indexOf(expectedCodexShellEnvironmentFlag);
      assert.ok(
        idx > 0 && args[idx - 1] === "--config",
        `${label} codex argv must carry --config shell_environment_policy`,
      );
      assert.equal(
        args.some((token) => token.includes(credential) || token.includes(githubToken)),
        false,
        `${label} codex argv must never carry credentials`,
      );
    }
    assert.equal(codexFresh.env.CODEX_HOME, undefined, "operator-environment keeps native CODEX_HOME");
    assert.equal(codexFresh.env.HARNESS_ACTOR, "agent:runtime-session:runtime_contract");
    assert.equal(codexFresh.env.HARNESS_EXECUTION_CREDENTIAL, credential);
    assert.equal(codexFresh.env.GH_TOKEN, githubToken);

    const acpPrepared = await bindDispatch(
      await store.prepareLaunch("codex-acp-operator", { cwd: workdir, prompt: "ACP" }),
    );
    assert.equal(acpPrepared.env.CODEX_HOME, undefined, "codex-acp operator-environment keeps native CODEX_HOME");
    assert.equal(acpPrepared.env.HARNESS_ACTOR, "agent:runtime-session:runtime_contract");
    assert.equal(acpPrepared.env.HARNESS_EXECUTION_CREDENTIAL, credential);
    assert.equal(acpPrepared.env.GH_TOKEN, githubToken);
    assert.ok(acpPrepared.env.CODEX_CONFIG, "codex-acp launch must set CODEX_CONFIG");
    assert.equal(acpPrepared.env.CODEX_CONFIG.includes(credential), false);
    assert.equal(acpPrepared.env.CODEX_CONFIG.includes(githubToken), false);
    assert.deepEqual(JSON.parse(acpPrepared.env.CODEX_CONFIG), {
      model_provider: "operator-custom",
      shell_environment_policy: expectedCodexShellEnvironmentObject,
    });

    const malformedStore = openRuntimeInstanceStore({
      userRoot: path.join(root, "malformed-user"),
      env: { PATH: "/usr/bin:/bin", HOME: operatorHome, CODEX_CONFIG: "not-json" },
      discover: () => [
        {
          installationId: "codex-acp-bad",
          kindId: "codex-acp",
          executablePath: "/opt/runtime-test/codex-acp",
          version: "2.6.0",
          observedAt: "2026-11-13T00:00:00.000Z",
        },
      ],
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    malformedStore.command({
      kind: "runtime-instance-create",
      instanceId: "codex-acp-bad",
      name: "Codex ACP Bad",
      kindId: "codex-acp",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    await assert.rejects(
      malformedStore.prepareLaunch("codex-acp-bad", { cwd: workdir, prompt: "Reject bad CODEX_CONFIG" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_launch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function startDeterministicToolDumpModelServer(
  envOutFile: string,
  customBinDir: string,
): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  const dumpCommand = `node -e 'const fs=require("fs"),path=require("path");fs.writeFileSync(${JSON.stringify(envOutFile)},JSON.stringify({HARNESS_ACTOR:process.env.HARNESS_ACTOR??null,HARNESS_EXECUTION_CREDENTIAL:process.env.HARNESS_EXECUTION_CREDENTIAL??null,HARNESS_DAEMON_ENDPOINT:process.env.HARNESS_DAEMON_ENDPOINT??null,GH_TOKEN:process.env.GH_TOKEN??null,HARNESS_GITHUB_TOKEN:process.env.HARNESS_GITHUB_TOKEN??null,GIT_CONFIG_COUNT:process.env.GIT_CONFIG_COUNT??null,GIT_CONFIG_KEY_0:process.env.GIT_CONFIG_KEY_0??null,OPERATOR_CUSTOM_VAR:process.env.OPERATOR_CUSTOM_VAR??null,HAS_CUSTOM_PATH:(process.env.PATH??"").split(path.delimiter).includes(${JSON.stringify(customBinDir)})}))'`;
  let sequence = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as {
        readonly tools?: readonly unknown[];
        readonly input?: readonly { readonly type?: string }[];
      },
      hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0,
      lastItem = Array.isArray(parsed.input) ? parsed.input.at(-1) : undefined,
      justFinishedTool = lastItem?.type === "function_call_output",
      id = ++sequence,
      item =
        !hasTools || justFinishedTool
          ? { type: "message", id: `msg_${id}`, role: "assistant", content: [{ type: "output_text", text: "DONE" }] }
          : {
              type: "function_call",
              call_id: `call_${id}`,
              name: "exec_command",
              arguments: JSON.stringify({ cmd: dumpCommand, max_output_tokens: 2000, yield_time_ms: 10_000 }),
            };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: `resp_${id}` } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: { id: `resp_${id}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function writeFilteringOperatorCodexConfig(operatorHome: string, port: number): void {
  const codexDir = providerConfigDirectory(operatorHome, "codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      'model_provider = "mock"',
      'model = "gpt-5.4"',
      "",
      "[model_providers.mock]",
      'name = "mock"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      "ignore_default_excludes = false",
      'exclude = ["HARNESS_*", "GH_*"]',
      'include_only = ["PATH", "HOME"]',
      "",
      "[shell_environment_policy.set]",
      'OPERATOR_CUSTOM_VAR = "keep-me"',
      "",
    ].join("\n"),
  );
}

test(
  "real Codex fresh and resumed dispatches deliver HARNESS_ACTOR, execution credentials, and Git tokens to tool shells under operator inherit=core and ignore_default_excludes=false",
  {
    timeout: 60_000,
    skip: codexBinary() === null ? "requires installed codex CLI on PATH" : false,
  },
  async (t) => {
    const binary = codexBinary()!,
      root = mkdtempSync(path.join(tmpdir(), "ha-real-codex-dispatch-env-")),
      userRoot = path.join(root, "user"),
      operatorHome = path.join(root, "operator-home"),
      customBinDir = path.join(root, "operator-bin"),
      workdir = path.join(root, "work"),
      envOutFile = path.join(workdir, "tool-env.json"),
      credential = "test-fixture-codex-exec-credential",
      githubToken = "test-fixture-codex-git-token",
      model = await startDeterministicToolDumpModelServer(envOutFile, customBinDir);
    t.after(async () => {
      await model.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(customBinDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: workdir, stdio: "ignore" });
    writeFilteringOperatorCodexConfig(operatorHome, model.port);

    const store = openRuntimeInstanceStore({
      userRoot,
      env: {
        PATH: [customBinDir, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter),
        HOME: operatorHome,
        USER: process.env.USER ?? "operator",
        HARNESS_GITHUB_TOKEN: githubToken,
      },
      discover: () => [
        {
          installationId: "real-codex",
          kindId: "codex",
          executablePath: binary,
          version: "0.167.0",
          observedAt: "2026-11-13T00:00:00.000Z",
        },
      ],
      resolveGithubToken: async () => githubToken,
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-operator-real",
      name: "Codex Operator Real",
      kindId: "codex",
      providerId: "openai",
      models: ["gpt-5.4"],
      authMode: "subscription",
    });

    const runCodexLaunch = async (providerSessionId?: string) => {
      rmSync(envOutFile, { force: true });
      const prepared = await store.prepareLaunch("codex-operator-real", {
          cwd: workdir,
          prompt: providerSessionId ? "Resume dump" : "Fresh dump",
          permissionMode: "bypass",
          ...(providerSessionId ? { providerSessionId } : {}),
        }),
        bound = await prepareBoundRuntimeLaunch({
          input: {
            rootDir: workdir,
            repoId: "repo-real-codex",
            now: () => "2026-11-13T00:00:00.000Z",
            remote: {
              executionCredential: () => ({ credential, expiresAt: "2026-11-13T01:00:00.000Z" }),
            } as never,
          },
          prepared,
          daemonRoute: { userRoot, daemonId: "daemon-real-codex", endpoint: "http://127.0.0.1:43999" },
          runtimeActor: "agent:runtime-session:runtime_real_codex",
          taskId: "task_76023d236f04c87144c5b6abde",
          execution: {
            personId: "operator",
            repoId: "repo-real-codex",
            runtimeSessionId: "runtime_real_codex",
            dispatchId: "dispatch_real_codex",
            taskId: "task_76023d236f04c87144c5b6abde",
            executionId: "execution_real_codex",
            role: "implementation",
            source: "local",
          },
        });
      assert.equal(
        bound.args.some((token) => token.includes(credential) || token.includes(githubToken)),
        false,
        "codex argv must never carry dispatch or Git credentials",
      );
      const child = spawn(bound.executablePath, bound.args, {
        cwd: bound.cwd,
        env: bound.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(`${bound.prompt}\n`);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(exitCode, 0, `codex exited ${String(exitCode)}: ${stderr}`);
      let threadId: string | null = null;
      for (const line of stdout.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { readonly type?: string; readonly thread_id?: string };
        if (frame.type === "thread.started" && frame.thread_id) threadId = frame.thread_id;
      }
      assert.equal(existsSync(envOutFile), true, `tool shell did not write ${envOutFile}`);
      return {
        threadId,
        captured: JSON.parse(readFileSync(envOutFile, "utf8")) as Record<string, unknown>,
      };
    };

    const fresh = await runCodexLaunch();
    assert.ok(fresh.threadId, "fresh codex dispatch must emit thread.started");
    const resumed = await runCodexLaunch(fresh.threadId);
    for (const [phase, captured] of [
      ["fresh", fresh.captured],
      ["resumed", resumed.captured],
    ] as const) {
      assert.deepEqual(
        captured,
        {
          HARNESS_ACTOR: "agent:runtime-session:runtime_real_codex",
          HARNESS_EXECUTION_CREDENTIAL: credential,
          HARNESS_DAEMON_ENDPOINT: "http://127.0.0.1:43999",
          GH_TOKEN: githubToken,
          HARNESS_GITHUB_TOKEN: githubToken,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          OPERATOR_CUSTOM_VAR: "keep-me",
          HAS_CUSTOM_PATH: true,
        },
        `${phase} codex tool shell environment`,
      );
    }
  },
);

test(
  "real Codex ACP fresh and resumed sessions deliver HARNESS_ACTOR, execution credentials, and Git tokens to tool shells under operator inherit=core and ignore_default_excludes=false",
  {
    timeout: 60_000,
    skip: binaryOnPath("codex-acp") === null ? "requires installed codex-acp CLI on PATH" : false,
  },
  async (t) => {
    const binary = binaryOnPath("codex-acp")!,
      root = mkdtempSync(path.join(tmpdir(), "ha-real-codex-acp-dispatch-env-")),
      userRoot = path.join(root, "user"),
      operatorHome = path.join(root, "operator-home"),
      customBinDir = path.join(root, "operator-bin"),
      workdir = path.join(root, "work"),
      envOutFile = path.join(workdir, "acp-tool-env.json"),
      credential = "test-fixture-codex-acp-exec-credential",
      githubToken = "test-fixture-codex-acp-git-token",
      model = await startDeterministicToolDumpModelServer(envOutFile, customBinDir);
    let acpChild: ReturnType<typeof spawn> | null = null;
    t.after(async () => {
      try {
        if (acpChild && acpChild.exitCode === null) {
          acpChild.stdin?.destroy();
          if (process.platform !== "win32" && typeof acpChild.pid === "number") {
            try {
              process.kill(-acpChild.pid, "SIGKILL");
            } catch {
              acpChild.kill("SIGKILL");
            }
          } else {
            acpChild.kill("SIGKILL");
          }
          await new Promise<void>((resolve) => acpChild!.once("close", () => resolve()));
        }
      } finally {
        await model.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(customBinDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: workdir, stdio: "ignore" });
    writeFilteringOperatorCodexConfig(operatorHome, model.port);

    const store = openRuntimeInstanceStore({
      userRoot,
      env: {
        PATH: [customBinDir, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter),
        HOME: operatorHome,
        USER: process.env.USER ?? "operator",
        HARNESS_GITHUB_TOKEN: githubToken,
      },
      discover: () => [
        {
          installationId: "real-codex-acp",
          kindId: "codex-acp",
          executablePath: binary,
          version: "2.6.0",
          observedAt: "2026-11-13T00:00:00.000Z",
        },
      ],
      resolveGithubToken: async () => githubToken,
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-acp-operator-real",
      name: "Codex ACP Operator Real",
      kindId: "codex-acp",
      providerId: "openai",
      models: ["gpt-5.4"],
      authMode: "subscription",
    });

    const prepared = await store.prepareLaunch("codex-acp-operator-real", {
        cwd: workdir,
        prompt: "ACP dump",
        permissionMode: "bypass",
      }),
      bound = await prepareBoundRuntimeLaunch({
        input: {
          rootDir: workdir,
          repoId: "repo-real-codex-acp",
          now: () => "2026-11-13T00:00:00.000Z",
          remote: {
            executionCredential: () => ({ credential, expiresAt: "2026-11-13T01:00:00.000Z" }),
          } as never,
        },
        prepared,
        daemonRoute: { userRoot, daemonId: "daemon-real-codex-acp", endpoint: "http://127.0.0.1:43999" },
        runtimeActor: "agent:runtime-session:runtime_real_codex_acp",
        taskId: "task_76023d236f04c87144c5b6abde",
        execution: {
          personId: "operator",
          repoId: "repo-real-codex-acp",
          runtimeSessionId: "runtime_real_codex_acp",
          dispatchId: "dispatch_real_codex_acp",
          taskId: "task_76023d236f04c87144c5b6abde",
          executionId: "execution_real_codex_acp",
          role: "implementation",
          source: "local",
        },
      });
    assert.equal(bound.env.CODEX_CONFIG?.includes(credential) ?? false, false);
    assert.equal(bound.env.CODEX_CONFIG?.includes(githubToken) ?? false, false);
    const child = spawn(bound.executablePath, bound.args, {
      cwd: bound.cwd,
      env: bound.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    acpChild = child;

    let buffer = "",
      nextId = 0;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (typeof message.id === "number" && pending.has(message.id)) {
            const resolve = pending.get(message.id)!;
            pending.delete(message.id);
            resolve(message);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await rpc("session/new", { cwd: workdir, mcpServers: [] }),
      sessionId = (created.result as { readonly sessionId: string }).sessionId;
    await rpc("session/set_mode", { sessionId, modeId: "agent-full-access" });
    rmSync(envOutFile, { force: true });
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Fresh ACP dump" }] });
    assert.equal(existsSync(envOutFile), true, "fresh codex-acp tool shell must write tool-env.json");
    const freshCaptured = JSON.parse(readFileSync(envOutFile, "utf8")) as Record<string, unknown>;

    rmSync(envOutFile, { force: true });
    await rpc("session/load", { sessionId, cwd: workdir, mcpServers: [] });
    await rpc("session/set_mode", { sessionId, modeId: "agent-full-access" });
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Resumed ACP dump" }] });
    assert.equal(existsSync(envOutFile), true, "resumed codex-acp tool shell must write tool-env.json");
    const resumedCaptured = JSON.parse(readFileSync(envOutFile, "utf8")) as Record<string, unknown>;

    for (const [phase, captured] of [
      ["fresh", freshCaptured],
      ["resumed", resumedCaptured],
    ] as const) {
      assert.deepEqual(
        captured,
        {
          HARNESS_ACTOR: "agent:runtime-session:runtime_real_codex_acp",
          HARNESS_EXECUTION_CREDENTIAL: credential,
          HARNESS_DAEMON_ENDPOINT: "http://127.0.0.1:43999",
          GH_TOKEN: githubToken,
          HARNESS_GITHUB_TOKEN: githubToken,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          OPERATOR_CUSTOM_VAR: "keep-me",
          HAS_CUSTOM_PATH: true,
        },
        `${phase} codex-acp tool shell environment`,
      );
    }
  },
);
