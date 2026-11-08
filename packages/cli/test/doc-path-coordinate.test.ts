// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";

function fixture(t: { after: (fn: () => void) => void }): { root: string; ledgerRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-doc-path-coordinate-"));
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-settings/v1\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ledgerRoot: path.join(root, "harness") };
}

const document = "tasks/task_a/closeout.md";

// The parser is deliberately coordinate-agnostic: the doc action entry owns the one translation,
// so every doc --path command must hand the caller's spelling through untouched.
test("every doc --path command passes the workspace spelling through to the action", (t) => {
  const { root } = fixture(t);
  const commands = [
    ["doc", "status", "--path", `harness/${document}`],
    ["doc", "sync", "--dry-run", "--path", `harness/${document}`],
    ["doc", "sync", "--submit", "--path", `harness/${document}`],
    ["doc", "materialize", "--path", `harness/${document}`],
    ["doc", "show", "--path", `harness/${document}`],
    ["doc", "retire", "--path", `harness/${document}`, "--reason", "gone"],
  ] as const;
  for (const args of commands) {
    const parsed = parseThinCommand(args, root);
    assert.equal(parsed.ok, true, `${args.join(" ")} must parse`);
    if (!parsed.ok) continue;
    const action = parsed.command.action as {
      readonly paths?: readonly string[];
      readonly path?: string;
      readonly pathCoordinate?: string;
    };
    assert.deepEqual(
      action.paths ?? [action.path],
      [`harness/${document}`],
      `${args.join(" ")} must carry the caller's spelling`,
    );
    assert.equal(action.pathCoordinate, "workspace", `${args.join(" ")} must mark the CLI coordinate`);
  }
});

// The parser is coordinate-agnostic on purpose: the daemon action entry owns the one translation,
// and only the marker decides that a value is CLI-typed. Whether the spelling is legal is the
// resolver's judgment (`workspace-document-path.test.ts`), not the parser's.
test("the parser hands every caller spelling through untouched and marks the coordinate", (t) => {
  const { root, ledgerRoot } = fixture(t);
  for (const [base, value] of [
    [root, `harness/${document}`],
    [root, document],
    [ledgerRoot, document],
  ] as const) {
    const parsed = parseThinCommand(["doc", "show", "--path", value], base);
    assert.equal(parsed.ok, true, `${value} from ${base} must parse`);
    if (parsed.ok)
      assert.deepEqual(
        {
          path: (parsed.command.action as { path?: string }).path,
          pathCoordinate: (parsed.command.action as { pathCoordinate?: string }).pathCoordinate,
        },
        { path: value, pathCoordinate: "workspace" },
      );
  }
});
