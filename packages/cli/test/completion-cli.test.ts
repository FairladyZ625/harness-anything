// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandRegistry } from "../src/cli/command-registry.ts";
import { generateShellCompletion } from "../src/cli/completion/index.ts";
import { deriveShellCompletionModel } from "../src/cli/completion/model.ts";
import type { CommandRegistryEntry } from "../src/cli/types.ts";

const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const directEnv = { ...process.env, HARNESS_DAEMON_MODE: "direct" };

test("completion scripts track command registry fixture changes", () => {
  const baseline = [fixtureEntry({
    kind: "widget-list",
    primary: "harness-anything widget list [--format fmt_text|fmt_json]",
    commandPath: ["widget", "list"],
    summary: "List widgets.",
    options: [{ flag: "--format", description: "Select output format." }]
  })];
  const evolved = [
    fixtureEntry({
      ...baseline[0]!,
      primary: "harness-anything widget list [--format fmt_text|fmt_json|fmt_yaml]"
    }),
    fixtureEntry({
      kind: "widget-inspect",
      primary: "harness-anything widget inspect <scan_fast|scan_deep> [--mode mode_safe|mode_full]",
      commandPath: ["widget", "inspect"],
      summary: "Inspect one widget.",
      options: [{ flag: "--mode", description: "Select inspection mode." }]
    })
  ];

  for (const shell of ["bash", "zsh"] as const) {
    const before = generateShellCompletion(shell, baseline);
    const after = generateShellCompletion(shell, evolved);

    assert.doesNotMatch(before, /widget inspect/u);
    assert.doesNotMatch(before, /fmt_yaml/u);
    assert.match(after, /widget inspect/u);
    assert.match(after, /fmt_yaml/u);
    assert.match(after, /scan_deep/u);
    assert.match(after, /mode_full/u);
  }

  const model = deriveShellCompletionModel(evolved);
  assert.deepEqual(
    model.commands.find((command) => command.path.join(" ") === "widget list")?.options[0]?.values,
    ["fmt_text", "fmt_json", "fmt_yaml"]
  );
  assert.deepEqual(
    model.commands.find((command) => command.path.join(" ") === "widget inspect")?.positionals[0]?.values,
    ["scan_fast", "scan_deep"]
  );
});

test("registry-derived scripts expose expected values and pass available shell syntax checks", async (t) => {
  const model = deriveShellCompletionModel(commandRegistry);
  const taskCreate = model.commands.find((command) => command.path.join(" ") === "task create");
  const taskTransition = model.commands.find((command) => command.path.join(" ") === "task transition");
  assert.deepEqual(taskCreate?.options.find((option) => option.value === "--kind")?.values, ["feat", "fix", "refactor", "docs", "test", "chore"]);
  assert.deepEqual(taskTransition?.positionals.find((positional) => positional.index === 1)?.values, ["planned", "active", "blocked", "in_review", "done", "cancelled"]);

  const bashScript = generateShellCompletion("bash", commandRegistry);
  assert.match(bashScript, /task create/u);
  const bashSyntax = spawnSync("bash", ["-n"], { input: bashScript, encoding: "utf8" });
  assert.equal(bashSyntax.error, undefined);
  assert.equal(bashSyntax.status, 0, bashSyntax.stderr);

  await t.test("zsh script passes syntax check when zsh is installed", (zshTest) => {
    const zshScript = generateShellCompletion("zsh", commandRegistry);
    assert.match(zshScript, /task create/u);
    const syntax = spawnSync("zsh", ["-n"], { input: zshScript, encoding: "utf8" });
    if ((syntax.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      zshTest.skip("zsh executable is unavailable; zsh -n syntax check skipped");
      return;
    }
    assert.equal(syntax.error, undefined);
    assert.equal(syntax.status, 0, syntax.stderr);
  });
});

test("ha completion emits the generated script through the standard CLI entrypoint", () => {
  for (const shell of ["bash", "zsh"] as const) {
    const stdout = execFileSync(process.execPath, [cliEntry, "completion", shell], {
      encoding: "utf8",
      env: directEnv
    });
    assert.equal(stdout, `${generateShellCompletion(shell, commandRegistry)}\n`);
  }

  const json = JSON.parse(execFileSync(process.execPath, [cliEntry, "--json", "completion", "bash"], {
    encoding: "utf8",
    env: directEnv
  })) as Record<string, any>;
  assert.equal(json.ok, true);
  assert.equal(json.command, "completion");
  assert.equal(json.details.data.shell, "bash");
  assert.equal(json.details.data.completionScript, generateShellCompletion("bash", commandRegistry));
});

test("ha completion rejects unsupported shells with the supported values", () => {
  const result = spawnSync(process.execPath, [cliEntry, "--json", "completion", "fish"], {
    encoding: "utf8",
    env: directEnv
  });
  assert.equal(result.status, 2);
  const receipt = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(receipt.error.code, "invalid_completion_shell");
  assert.match(receipt.error.hint, /Valid shells: bash, zsh/u);
});

function fixtureEntry(
  input: Pick<CommandRegistryEntry, "kind" | "primary" | "commandPath" | "summary" | "options">
): CommandRegistryEntry {
  return {
    ...input,
    aliases: [],
    examples: [],
    resultEnvelope: "command-receipt/v2"
  };
}
