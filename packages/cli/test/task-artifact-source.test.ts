// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeArtifactSource } from "../src/cli-artifact-source.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

function parsedArtifactSource(root: string, source: string) {
  const parsed = parseThinCommand(
    ["task", "artifact", "add", "task-1", "--source", source, "--destination", "artifacts/missions/w1.md"],
    root,
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  return parsed.command;
}

test("a UTF-8 artifact source outside the repository rides the inline content channel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-source-root-")),
    outside = mkdtempSync(path.join(tmpdir(), "artifact-source-outside-"));
  try {
    writeFileSync(path.join(outside, "w1.md"), "# mission v1\n");
    const command = parsedArtifactSource(root, path.join(outside, "w1.md")),
      materialized = materializeArtifactSource(command);
    assert.equal(materialized.action.source, undefined);
    assert.equal(materialized.action.content, "# mission v1\n");
    assert.equal(command.action.source, path.join(outside, "w1.md"), "the parsed command is not mutated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an artifact source already inside the repository stays on the path channel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-source-root-"));
  try {
    writeFileSync(path.join(root, "w1.md"), "# mission v1\n");
    const command = parsedArtifactSource(root, "w1.md");
    assert.equal(materializeArtifactSource(command), command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing outside artifact source is named before the daemon is called", () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-source-root-"));
  try {
    const command = parsedArtifactSource(root, path.join(root, "..", "missing-w1.md"));
    assert.throws(
      () => materializeArtifactSource(command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "artifact_source_missing" &&
        /existing readable file/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a binary source outside the repository is refused with the inside-repository route", () => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-source-root-")),
    outside = mkdtempSync(path.join(tmpdir(), "artifact-source-outside-"));
  try {
    writeFileSync(path.join(outside, "evidence.pdf"), Buffer.from([0xff, 0xfe, 0x00]));
    const command = parsedArtifactSource(root, path.join(outside, "evidence.pdf"));
    assert.throws(
      () => materializeArtifactSource(command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "artifact_source_invalid" &&
        /Place a binary artifact inside the repository/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("only artifact add actions with a source are materialized", () => {
  const show = parseThinCommand(["doc", "show", "--path", "tasks/task-1-artifacts/closeout.md"]);
  assert.equal(show.ok, true, JSON.stringify(show));
  if (!show.ok) throw new Error(show.nextAction);
  assert.equal(materializeArtifactSource(show.command), show.command);
});
