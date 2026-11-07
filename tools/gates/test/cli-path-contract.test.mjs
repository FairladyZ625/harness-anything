// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkCliPathContract, findRawWorkspaceFileReads } from "../../check-cli-path-contract.mjs";
import { daemonProtocolCommands } from "../../../packages/daemon/src/protocol/daemon-protocol-commands.ts";

const script = path.resolve(import.meta.dirname, "../../check-cli-path-contract.mjs");

function run(commands) {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-cli-path-gate-fixture-"));
  try {
    const fixture = path.join(directory, "commands.json");
    writeFileSync(fixture, JSON.stringify(commands));
    return spawnSync(process.execPath, [script, "--registry-fixture", fixture], {
      encoding: "utf8",
      cwd: path.resolve(import.meta.dirname, "../../.."),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const pathInput = (extra = {}) => ({
  name: "--path",
  kind: "repeated",
  required: false,
  error: { code: "invalid_field" },
  ...extra,
});

test("the registered command surface satisfies the path contract", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cli-path-contract: ok/u);
});

test("a new command whose value input declares no coordinate turns the gate red and is named", () => {
  const result = run([
    {
      id: "gate-probe-untyped-path",
      path: ["probe", "untyped"],
      commandClass: "repo-write",
      inputs: [pathInput()],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-probe-untyped-path --path: value input must declare pathKind/u);
});

test("a path input under an ordinary flag name such as --input is not invisible to the gate", () => {
  const result = run([
    {
      id: "gate-probe-input-path",
      path: ["probe", "input-path"],
      commandClass: "repo-write",
      inputs: [{ name: "--input", kind: "single", required: true, error: { code: "missing_field" } }],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-probe-input-path --input: value input must declare pathKind/u);
});

test("a declared workspace-file under an ordinary flag name must name a shared reader", () => {
  const result = run([
    {
      id: "gate-probe-candidate-input",
      path: ["probe", "candidate-input"],
      commandClass: "repo-write",
      inputs: [
        {
          name: "--candidate",
          kind: "single",
          required: true,
          error: { code: "missing_field" },
          pathKind: "workspace-file",
        },
      ],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /gate-probe-candidate-input --candidate: workspace-file input must declare a shared pathReader/u,
  );
});

test("a scalar positional that names an action field must declare its coordinate", () => {
  const result = run([
    {
      id: "gate-probe-positional-field",
      path: ["probe", "positional-field", "<target>"],
      positional: "inputPath",
      commandClass: "repo-read",
      inputs: [],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /gate-probe-positional-field inputPath: positional input must declare pathKind and pathReader/u,
  );
});

test("a new command whose topology path flag declares no coordinate also turns the gate red", () => {
  const result = run([
    {
      id: "gate-probe-untyped-source",
      path: ["probe", "source"],
      commandClass: "repo-read",
      inputs: [{ name: "--source", kind: "single", required: false, error: { code: "invalid_field" } }],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-probe-untyped-source --source: value input must declare pathKind/u);
});

test("a new command that carries a document path outside the doc parser turns the gate red", () => {
  const result = run([
    {
      id: "gate-probe-bypass",
      path: ["probe", "bypass"],
      commandClass: "repo-write",
      inputs: [pathInput({ pathKind: "ledger-document" })],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /gate-probe-bypass --path: ledger-document paths are translated by the doc action entry/u,
  );
});

test("a doc-named read command outside the doc action entry turns the gate red and is named", () => {
  const result = run([
    {
      id: "doc-new-read",
      path: ["doc", "new-read"],
      commandClass: "repo-read",
      inputs: [pathInput({ pathKind: "ledger-document" })],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /doc-new-read --path: ledger-document paths are translated by the doc action entry/u);
});

test("a workspace-file input without a declared reader turns the gate red and is named", () => {
  const result = run([
    {
      id: "probe-workspace-write",
      path: ["probe", "workspace-write"],
      commandClass: "repo-write",
      inputs: [
        {
          name: "--from-file",
          kind: "single",
          required: true,
          error: { code: "missing_field" },
          pathKind: "workspace-file",
        },
      ],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /probe-workspace-write --from-file: workspace-file input must declare a shared pathReader/u,
  );
});

test("an undeclared positional path token turns the gate red and is named", () => {
  const result = run([
    {
      id: "probe-positional",
      path: ["probe", "positional"],
      syntaxPath: ["probe", "positional", "<input-file>"],
      commandClass: "repo-read",
      inputs: [],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /probe-positional <input-file>: positional path input must declare pathKind and pathReader/u,
  );
});

test("a new write command with a document selection outside the zero-hit pipeline turns the gate red", () => {
  const result = run([
    {
      id: "doc-sync-probe",
      path: ["doc", "sync", "--probe"],
      commandClass: "repo-write",
      inputs: [pathInput({ pathKind: "ledger-document" })],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /doc-sync-probe: write command with a document path is not routed/u);
});

test("a declared reader that a handler bypasses with a raw read is named", () => {
  const source = `const text = readFileSync(path.resolve(command.rootDir, bodyFile), "utf8");`;
  assert.deepEqual(findRawWorkspaceFileReads(source, ["bodyFile"]), ["bodyFile"]);
  assert.deepEqual(findRawWorkspaceFileReads(`readFileSync(resolve(rootDir, fromFile), "utf8")`, ["bodyFile"]), []);
});

test("the gate actually evaluated document paths and zero-hit write commands, not an empty selection", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const match =
    /cli-path-contract: ok \((\d+) commands, (\d+) typed value inputs, (\d+) path inputs, (\d+) document paths, (\d+) zero-hit write commands\)/u.exec(
      result.stdout,
    );
  assert.ok(match, result.stdout);
  assert.ok(Number(match[1]) > 0 && Number(match[2]) > 0, "the registry and its value inputs must be evaluated");
  assert.ok(Number(match[3]) >= 60, "flag and positional path inputs must both be evaluated");
  assert.ok(Number(match[4]) > 0, "document paths must be translated through the parser probe");
  assert.ok(Number(match[5]) > 0, "write document selections must reach the zero-hit pipeline probe");
});

test("a cli-local input without the CLI-host reader turns the gate red and is named", () => {
  const result = run([
    {
      id: "gate-probe-bare-cli-local",
      path: ["probe", "bare-cli-local"],
      commandClass: "repo-read",
      inputs: [
        {
          name: "--secret-file",
          kind: "single",
          required: false,
          error: { code: "invalid_field" },
          pathKind: "cli-local",
        },
      ],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /gate-probe-bare-cli-local --secret-file: cli-local input must declare pathReader "cli-local"/u,
  );
});

test("the CLI-host exemption is a declared category, not an allowlist of commands", () => {
  const declared = daemonProtocolCommands.flatMap((command) =>
    [...(command.inputs ?? []), ...(command.positionalInputs ?? [])]
      .filter((input) => input.pathKind === "cli-local")
      .map((input) => ({ id: command.id, name: input.name, reader: input.pathReader })),
  );
  assert.ok(declared.length > 0, "the exemption category must not be empty");
  for (const input of declared)
    assert.equal(input.reader, "cli-local", `${input.id} ${input.name} must name the CLI-host reader`);
  const result = checkCliPathContract();
  assert.equal(result.counts.cliLocalInputs, declared.length);
});

test("the path input set is exactly the registry's declarations, never a flag-name heuristic", () => {
  const result = checkCliPathContract();
  assert.equal(result.ok, true, result.violations.join("\n"));
  const untyped = daemonProtocolCommands.flatMap((command) =>
    (command.inputs ?? [])
      .filter((input) => input.kind !== "boolean" && !input.pathKind)
      .map((input) => `${command.id} ${input.name}`),
  );
  assert.deepEqual(untyped, [], "every value input must state its coordinate");
  const declared = daemonProtocolCommands.reduce(
    (total, command) =>
      total +
      (command.inputs ?? []).filter((input) => input.kind !== "boolean" && input.pathKind !== "non-path").length +
      (command.positionalInputs ?? []).filter((input) => input.pathKind !== "non-path").length,
    0,
  );
  assert.equal(result.counts.pathInputs, declared);
  assert.ok(declared >= 64, "the declaration count must include the non-path-shaped flags");
});
