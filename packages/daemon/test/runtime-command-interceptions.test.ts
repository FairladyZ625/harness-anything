// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import test from "node:test";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { commandInterceptionHook } from "../src/runtime-command-interceptions.ts";
import { publicConfig } from "../src/agent-runtime-instance-storage.ts";
import { runtimeKinds } from "../src/runtime-inventory.ts";

const rules = [
  { id: "no-publish", pattern: "\\bnpm\\s+publish\\b" },
  { id: "release-script", pattern: "scripts/release\\.sh" },
];

test("native hook denies matching command and script text and leaves unrelated commands alone", () => {
  const hook = commandInterceptionHook(rules);
  for (const command of ["npm publish", "cd package && npm publish --tag next", "bash scripts/release.sh"] as const) {
    const result = spawnSync(hook, {
      shell: true,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "deny");
    assert.match(decision.permissionDecisionReason, /no-publish|release-script/u);
  }
  const allowed = spawnSync(hook, {
    shell: true,
    input: JSON.stringify({ tool_input: { command: "npm test" } }),
    encoding: "utf8",
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  const malformed = spawnSync(hook, { shell: true, input: "{", encoding: "utf8" });
  assert.notEqual(malformed.status, 0, "a malformed native payload must surface its parse error");
});

test("Claude hook survives permission, auth and resume variants and disables bare mode only when needed", () => {
  for (const mode of ["bypass", "workspace-write", "read-only"] as const)
    for (const auth of [{ mode: "subscription" }, { mode: "api-key", credentialRef: "fixture" }] as const)
      for (const session of [undefined, "existing-session"]) {
        const config = { kindId: "claude", auth } as Parameters<typeof launchArgs>[0],
          args = launchArgs(config, "model", "mission", session, null, mode, false, undefined, "linux", rules),
          settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
        assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash");
        assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, commandInterceptionHook(rules));
        assert.equal(settings.disableAllHooks, false);
        assert.equal(settings.attribution.commit, "");
        assert.equal(args.includes("--bare"), false, "--bare turns off native hooks");
        assert.equal(args.includes("--resume"), session !== undefined);
      }
});

test("every runtime capability explicitly states command interception support and unsupported launches fail closed", () => {
  for (const kind of runtimeKinds) {
    assert.ok(["supported", "unsupported"].includes(kind.capabilities.commandInterception), kind.kindId);
    const summary = publicConfig({
      kindId: kind.kindId,
      auth: { mode: "subscription" },
      [kind.kindId]: {},
    } as Parameters<typeof publicConfig>[0]);
    assert.equal(
      summary.capabilities?.commandInterception,
      kind.capabilities.commandInterception,
      `${kind.kindId}: show/list query`,
    );
    if (kind.capabilities.commandInterception === "supported") continue;
    assert.throws(
      () =>
        launchArgs(
          { kindId: kind.kindId, auth: { mode: "subscription" } } as Parameters<typeof launchArgs>[0],
          "model",
          "mission",
          undefined,
          null,
          "bypass",
          false,
          undefined,
          "linux",
          rules,
        ),
      { code: "runtime_command_interception_unsupported" },
    );
  }
});

test("CodeBuddy uses its settings overlay while Kimi refuses whole-config replacement", () => {
  for (const kindId of ["kimi", "codebuddy"] as const) {
    if (kindId === "kimi") {
      assert.throws(
        () =>
          launchArgs(
            { kindId, auth: { mode: "subscription" } } as Parameters<typeof launchArgs>[0],
            "model",
            "mission",
            undefined,
            null,
            "bypass",
            false,
            undefined,
            "linux",
            rules,
          ),
        { code: "runtime_command_interception_unsupported" },
      );
      continue;
    }
    const args = launchArgs(
        { kindId, auth: { mode: "subscription" } } as Parameters<typeof launchArgs>[0],
        "model",
        "mission",
        undefined,
        null,
        "bypass",
        false,
        undefined,
        "linux",
        rules,
      ),
      flag = "--settings",
      settings = JSON.parse(args[args.indexOf(flag) + 1]!);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, commandInterceptionHook(rules));
  }
});

test("file-based native hooks are scoped to a runtime and reclaimed in both isolation modes", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-native-hook-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kindId of ["droid", "auggie", "cursor", "copilot"] as const)
    for (const isolationState of ["enforced", "operator-environment"] as const) {
      let authenticated = false;
      const installation = {
          installationId: kindId,
          kindId,
          executablePath: process.execPath,
          version: "1.0.0",
          observedAt: new Date().toISOString(),
        },
        userRoot = path.join(root, kindId, isolationState),
        store = openRuntimeInstanceStore({
          userRoot,
          discover: () => [installation],
          env: { HOME: path.join(root, "operator"), PATH: process.env.PATH },
          subscriptionReady: () =>
            authenticated
              ? { status: "ready", code: null, hint: null }
              : { status: "not-ready", code: "runtime_subscription_required", hint: "Fixture is signed out." },
        });
      store.create({
        schemaVersion: 2,
        kindId,
        instanceId: "native-hook",
        installationId: kindId,
        providerId: "fixture",
        name: kindId,
        models: ["model"],
        defaultModel: "model",
        enabled: true,
        isolationState,
        auth: { mode: "subscription" },
        [kindId]: {},
      });
      const runtimeSessionId = "runtime_123456789012345678901234";
      await assert.rejects(
        store.prepareLaunch("native-hook", {
          cwd: root,
          prompt: "fixture",
          commandInterceptions: rules,
          runtimeSessionId,
        }),
        { code: "runtime_subscription_required" },
      );
      assert.deepEqual(store.listRuntimeTempSessionIds(), [], "a refused launch owns no policy scratch");
      authenticated = true;
      const launch = await store.prepareLaunch("native-hook", {
          cwd: root,
          prompt: "fixture",
          commandInterceptions: rules,
          runtimeSessionId,
        }),
        flag = kindId === "droid" ? "--settings" : "--plugin-dir",
        target = launch.args[launch.args.indexOf(flag) + 1]!,
        directory = kindId === "droid" ? path.dirname(target) : target,
        configPath =
          kindId === "droid"
            ? target
            : path.join(target, kindId === "auggie" ? "plugin/hooks/hooks.json" : "hooks/hooks.json"),
        config = JSON.parse(readFileSync(configPath, "utf8")),
        payload =
          kindId === "cursor"
            ? { command: "npm publish" }
            : kindId === "copilot"
              ? { toolName: "bash", toolArgs: JSON.stringify({ command: "npm publish" }) }
              : { tool_input: { command: "npm publish" } },
        hook =
          kindId === "copilot"
            ? config.hooks.preToolUse[0]
            : kindId === "cursor"
              ? config.hooks.beforeShellExecution[0]
              : config.hooks.PreToolUse[0].hooks[0],
        options = { input: JSON.stringify(payload), encoding: "utf8" as const },
        result =
          kindId === "copilot"
            ? spawnSync(hook.exec, hook.args, options)
            : spawnSync(hook.command, { ...options, shell: true }),
        decision = JSON.parse(result.stdout);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        kindId === "cursor"
          ? decision.permission
          : kindId === "copilot"
            ? decision.permissionDecision
            : decision.hookSpecificOutput.permissionDecision,
        "deny",
      );
      assert.match(result.stdout, /no-publish/u);
      assert.ok(store.listRuntimeTempSessionIds().includes(runtimeSessionId));
      const other = await store.prepareLaunch("native-hook", {
        cwd: root,
        prompt: "other",
        commandInterceptions: [{ id: "other", pattern: "unrelated" }],
        runtimeSessionId: "runtime_123456789012345678901235",
      });
      const sibling = other.args[other.args.indexOf(flag) + 1]!;
      assert.notEqual(sibling, target);
      assert.equal(store.reclaimRuntimeTempDirectory("native-hook", runtimeSessionId), null);
      assert.equal(existsSync(directory), false);
      assert.equal(existsSync(sibling), true, "another dispatch's frozen policy must survive");
    }
});
