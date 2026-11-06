// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test("a new command whose path input declares no coordinate turns the gate red and is named", () => {
  const result = run([
    {
      id: "gate-probe-untyped-path",
      path: ["probe", "untyped"],
      commandClass: "repo-write",
      inputs: [pathInput()],
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate-probe-untyped-path --path: path input must declare pathKind/u);
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
  assert.match(result.stderr, /gate-probe-bypass --path: ledger-document paths are translated by the doc parser/u);
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

test("the gate actually evaluated document paths and zero-hit write probes, not an empty selection", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const match =
    /cli-path-contract: ok \((\d+) commands, (\d+) path inputs, (\d+) document paths, (\d+) zero-hit write probes\)/u.exec(
      result.stdout,
    );
  assert.ok(match, result.stdout);
  assert.ok(Number(match[1]) > 0 && Number(match[2]) > 0, "the registry and its path inputs must be evaluated");
  assert.ok(Number(match[3]) > 0, "document paths must be translated through the parser probe");
  assert.ok(Number(match[4]) > 0, "write document selections must reach the zero-hit pipeline probe");
});
