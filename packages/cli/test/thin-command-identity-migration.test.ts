// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("squad run derives its mission from task unless prompt overrides it", () => {
  const promptFile = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt-file",
      "mission.md",
      "--cwd",
      "work",
      "--task",
      "task-1",
    ]),
    prompt = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt",
      "mission",
      "--cwd",
      "work",
      "--task",
      "task-1",
      "--permission-mode",
      "workspace-write",
    ]),
    both = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt",
      "mission",
      "--prompt-file",
      "mission.md",
      "--cwd",
      "work",
      "--task",
      "task-1",
    ]),
    taskOnly = parseThinCommand(["squad", "run", "core-squad", "--instance", "worker", "--task", "task-1"]);
  assert.equal(promptFile.ok, false);
  assert.equal(prompt.ok, true);
  if (prompt.ok) {
    assert.equal(prompt.command.action.prompt, "mission");
    assert.equal(prompt.command.action.permissionMode, "workspace-write");
  }
  assert.equal(both.ok, false);
  assert.equal(taskOnly.ok, true);
  if (taskOnly.ok) assert.deepEqual(taskOnly.command.action.cwd, { scope: "repo-root" });
});

test("Agent and Squad declaration commands route reads directly and writes through the daemon entity lifecycle", () => {
  const cases: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [["agent", "list"], "agent-list", "repo.task.read"],
    [["agent", "inspect", "terra"], "agent-inspect", "repo.task.read"],
    [["agent", "validate", "--source", "terra"], "agent-validate", "repo.task.read"],
    [["agent", "install", "--source", "terra", "--dry-run"], "agent-install", "repo.task.run"],
    [["squad", "list"], "squad-list", "repo.task.read"],
    [["squad", "inspect", "core-squad"], "squad-inspect", "repo.task.read"],
    [["squad", "status", "squad_0123456789abcdef01234567"], "squad-status", "repo.task.read"],
    [["squad", "validate", "--source", "core-squad"], "squad-validate", "repo.task.read"],
    [["squad", "install", "--source", "core-squad"], "squad-install", "repo.task.run"],
  ];
  for (const [argv, kind, method] of cases) {
    const parsed = parseThinCommand([...argv]);
    assert.equal(parsed.ok, true, JSON.stringify(argv));
    if (parsed.ok) {
      assert.equal(parsed.command.method, method);
      assert.equal(parsed.command.action.kind, kind);
    }
  }
  assert.equal(parseThinCommand(["squad", "status"]).ok, false);
  const create = parseThinCommand([
    "agent",
    "create",
    "codex-sidecar",
    "--agent",
    "meta",
    "--prompt",
    "Design a worker",
    "--task",
    "task-1",
  ]);
  assert.equal(create.ok, true, JSON.stringify(create));
  if (create.ok)
    assert.deepEqual(
      { method: create.command.method, action: create.command.action },
      {
        method: "repo.agentRuntime.spawn",
        action: {
          kind: "agent-create",
          runtimeInstanceId: "codex-sidecar",
          agentId: "meta",
          prompt: "Design a worker",
          taskId: "task-1",
          cwd: { scope: "repo-root" },
        },
      },
    );
});
test("runtime instance create leaves installation discovery to the daemon when omitted", () => {
  const parsed = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-auto",
    "--name",
    "Codex Auto",
    "--kind",
    "codex",
    "--provider",
    "openai",
    "--model",
    "gpt-5.6-sol",
    "--auth",
    "subscription",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) assert.equal("installationId" in parsed.command.action, false);
  const multi = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-multi",
    "--name",
    "Claude Multi",
    "--kind",
    "claude",
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5",
    "--model",
    "claude-opus",
    "--default-model",
    "claude-opus",
    "--permission-mode",
    "workspace-write",
    "--isolation",
    "enforced",
    "--auth",
    "subscription",
  ]);
  assert.equal(multi.ok, true, JSON.stringify(multi));
  if (multi.ok)
    assert.deepEqual(multi.command.action, {
      kind: "runtime-instance-create",
      instanceId: "claude-multi",
      name: "Claude Multi",
      kindId: "claude",
      providerId: "anthropic",
      models: ["claude-fable-5", "claude-opus"],
      defaultModel: "claude-opus",
      permissionMode: "workspace-write",
      isolationState: "enforced",
      claude: {},
      authMode: "subscription",
    });
  const agy = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "agy-open",
    "--name",
    "AGY Open",
    "--kind",
    "agy",
    "--provider",
    "google",
    "--model",
    "gemini-3.1-pro-low",
    "--permission-mode",
    "bypass",
    "--auth",
    "subscription",
  ]);
  assert.equal(agy.ok, true, JSON.stringify(agy));
  if (agy.ok) assert.equal(agy.command.action.permissionMode, "bypass");
  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--permission-mode",
      "turbo",
      "--model",
      "gpt",
      "--auth",
      "subscription",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--auth",
      "subscription",
    ]).ok,
    false,
  );
});

test("runtime instance auth commands parse into repo-scoped interactive sign-in actions", () => {
  const login = parseThinCommand([
      "runtime",
      "instance",
      "login",
      "worker",
      "--repo",
      "alpha",
      "--idempotency-key",
      "sign-in-once",
    ]),
    logout = parseThinCommand(["runtime", "instance", "logout", "worker"]);
  for (const parsed of [login, logout]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (login.ok)
    assert.deepEqual(
      {
        repoId: login.command.repoId,
        method: login.command.method,
        action: login.command.action,
      },
      {
        repoId: "alpha",
        method: "repo.runtimeInstance.auth.login",
        action: {
          kind: "runtime-instance-login",
          instanceId: "worker",
          idempotencyKey: "sign-in-once",
        },
      },
    );
  if (logout.ok)
    assert.deepEqual(
      { method: logout.command.method, action: logout.command.action },
      {
        method: "repo.runtimeInstance.auth.logout",
        action: { kind: "runtime-instance-logout", instanceId: "worker" },
      },
    );
  assert.equal(parseThinCommand(["runtime", "instance", "login"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "instance", "login", "worker", "--prompt", "x"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "instance", "reauth", "worker"]).ok, false);
  const shown = parseThinCommand(["runtime", "instance", "show", "worker", "--repo", "alpha", "--probe"]);
  assert.equal(shown.ok === true && shown.command.repoId, undefined);
  if (shown.ok) assert.equal(shown.command.action.probe, true);
});

test("migration import parser accepts ordered sources and repeated explicit conflict resolutions", () => {
  const parsed = parseThinCommand([
    "migrate",
    "import",
    "--source",
    "../alice",
    "--source",
    "../bob",
    "--resolve",
    "harness/people.yaml=source",
    "--resolve",
    "harness/AGENTS.md=destination",
    "--dry-run",
    "--json",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "migrate-import",
      sourceRoots: ["../alice", "../bob"],
      resolutions: ["harness/people.yaml=source", "harness/AGENTS.md=destination"],
      dryRun: true,
    });
  assert.equal(parseThinCommand(["migrate", "import"]).ok, false);
  assert.equal(
    parseThinCommand(["migrate", "import", "--source", "a", "--resolve", "harness/people.yaml=automatic"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["migrate", "import", "--source", "a", "--force"]).ok, false);
});

test("migrate ledger accepts only the declared SQLite generation option", () => {
  const parsed = parseThinCommand(["migrate", "ledger"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "ledger-migrate" });

  const generation = parseThinCommand(["migrate", "ledger", "--generation", "1"]);
  assert.equal(generation.ok, true);
  if (generation.ok) assert.deepEqual(generation.command.action, { kind: "ledger-migrate", generation: 1 });
  assert.equal(parseThinCommand(["migrate", "ledger", "--generation", "2"]).ok, false);
  assert.equal(parseThinCommand(["migrate", "ledger", "--dry-run"]).ok, false);
});

test("thin parser rejects retired caller-supplied gate receipts", () => {
  const parsed = parseThinCommand([
    "task",
    "complete",
    "task-1",
    "--execution-id",
    "exec-1",
    "--gate-receipt",
    "missing-separator",
  ]);
  assert.deepEqual(parsed, {
    ok: false,
    code: "unknown_field",
    nextAction: "Unknown option --gate-receipt. Run ha task complete --help.",
    json: false,
  });
});
