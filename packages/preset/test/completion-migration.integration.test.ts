// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseVerticalDeclarationDocument } from "@harness-anything/kernel";
import { createRuntime } from "../src/preset-resolver.ts";
import { effectiveCatalog } from "../src/preset-catalog.ts";
import { defaultAssets, defaultBundled, key } from "../src/preset-resolver-common.ts";
import { scan } from "../src/preset-package.ts";

const samples = new URL("../fixtures/completion-migration/", import.meta.url);
const sample = (name: string) => readFileSync(new URL(`${name}.json`, samples), "utf8");
const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "migrate", "completion", ...args, "--json"], { encoding: "utf8" });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
}

test("offline CLI converts the historical declaration without changing the source; unknown formats stay rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-declaration-"));
  try {
    const source = path.join(root, "old.json"),
      destination = path.join(root, "new.json");
    writeFileSync(source, sample("repository-before"));
    assert.throws(
      () => parseVerticalDeclarationDocument(JSON.parse(readFileSync(source, "utf8"))),
      /ha migrate completion/u,
    );
    assert.equal(invoke("--help").status, 0);
    assert.equal(invoke("--source", source, "--mode", "dry-run", "--destination", destination).status, 0);
    assert.equal(existsSync(destination), false);
    const converted = invoke("--source", source, "--mode", "convert", "--destination", destination);
    assert.equal(converted.status, 0, JSON.stringify(converted));
    assert.match(converted.receipt.next, /ha doc sync --submit/u);
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), JSON.parse(sample("repository-after")));
    assert.equal(readFileSync(source, "utf8"), sample("repository-before"));
    assert.equal(invoke("--source", destination, "--mode", "dry-run").receipt.changed, false);
    assert.equal(invoke("--source", source, "--mode", "convert", "--destination", source).status, 1);
    for (const mutate of [
      (value: Record<string, any>) => {
        value.definition.checkerProfile = "custom-checker";
      },
      (value: Record<string, any>) => {
        value.definition.unknown = true;
      },
      (value: Record<string, any>) => {
        value.definition.schema = "vertical-definition/v99";
      },
    ]) {
      const value = JSON.parse(sample("repository-before"));
      mutate(value);
      writeFileSync(source, JSON.stringify(value));
      assert.equal(invoke("--source", source, "--mode", "dry-run").status, 1);
    }
    writeFileSync(source, "{");
    assert.equal(invoke("--source", source, "--mode", "dry-run").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old active pin resolves after explicit migration while templates, scripts, user content and old objects survive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-pin-"));
  try {
    const userRoot = path.join(root, "presets"),
      oldDigest = "a".repeat(64),
      source = path.join(userRoot, "preset-objects", oldDigest),
      pointer = path.join(userRoot, "active", "gui-development.json");
    cpSync(defaultAssets, source, { recursive: true });
    cpSync(path.join(defaultBundled, "gui-development"), source, { recursive: true });
    writeFileSync(path.join(source, "preset.json"), sample("gui-development"));
    writeFileSync(path.join(source, "custom.txt"), "User content must survive.\n");
    mkdirSync(path.dirname(pointer), { recursive: true });
    writeFileSync(
      pointer,
      JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: "gui-development",
        verticalId: "software/coding",
        digest: oldDigest,
      }),
    );
    const original = scan(source),
      oldPointer = readFileSync(pointer, "utf8");
    const selected = () => effectiveCatalog(defaultBundled, userRoot).get(key("software/coding", "gui-development"))!;
    assert.match(selected().error!.message, /ha migrate completion --help/u);
    assert.equal(invoke("--source", source, "--mode", "dry-run", "--user-root", userRoot).status, 0);
    assert.equal(readFileSync(pointer, "utf8"), oldPointer);
    const migrated = invoke("--source", source, "--mode", "convert", "--user-root", userRoot);
    assert.equal(migrated.status, 0, JSON.stringify(migrated));
    assert.deepEqual(scan(source), original);
    const current = selected().decoded!;
    assert.ok(current);
    for (const [name, body] of original) if (name !== "preset.json") assert.equal(current.files.get(name), body, name);
    const resolved = await createRuntime({ userRoot }).resolver.resolve({
      presetId: "gui-development",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const unchanged = invoke("--source", current.root, "--mode", "convert", "--user-root", userRoot);
    assert.equal(unchanged.status, 0, JSON.stringify(unchanged));
    assert.equal(unchanged.receipt.changed, false);
    assert.equal(unchanged.receipt.installed.changed, false);
    const activeBeforeFailure = readFileSync(pointer, "utf8"),
      invalid = path.join(root, "invalid");
    cpSync(source, invalid, { recursive: true });
    const manifest = JSON.parse(sample("gui-development"));
    manifest.profiles[0].checkerProfile = "custom";
    writeFileSync(path.join(invalid, "preset.json"), JSON.stringify(manifest));
    assert.equal(invoke("--source", invalid, "--mode", "convert", "--user-root", userRoot).status, 1);
    assert.equal(readFileSync(pointer, "utf8"), activeBeforeFailure);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
