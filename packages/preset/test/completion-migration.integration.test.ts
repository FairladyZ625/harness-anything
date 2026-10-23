// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseVerticalDeclarationDocument } from "@harness-anything/kernel";
import { decodePresetPackageV3 } from "../src/preset-package.ts";

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

test("offline CLI converts an installed profile that still overrides codeDoc", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-retired-profile-"));
  try {
    const source = path.join(root, "package"),
      destination = path.join(root, "converted");
    cpSync(new URL("../assets/software-coding/presets/standard-task/", import.meta.url), source, { recursive: true });
    const manifestPath = path.join(source, "preset.json"),
      historical = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        readonly profiles: readonly { readonly id: string; readonly closeoutOverrides?: Record<string, boolean> }[];
      },
      baseline = historical.profiles.find(({ id }) => id === "baseline")!;
    baseline.closeoutOverrides = { codeDoc: true };
    writeFileSync(manifestPath, `${JSON.stringify(historical, null, 2)}\n`);
    assert.throws(() => decodePresetPackageV3(source), /closeoutOverrides/u);
    const converted = invoke("--source", source, "--mode", "convert", "--destination", destination);
    assert.equal(converted.status, 0, JSON.stringify(converted));
    assert.equal(converted.receipt.changed, true);
    const result = JSON.parse(readFileSync(path.join(destination, "preset.json"), "utf8")) as {
      readonly profiles: readonly Record<string, unknown>[];
    };
    assert.equal(
      Object.hasOwn(result.profiles.find((profile) => profile.id === "baseline")!, "closeoutOverrides"),
      false,
    );
    assert.equal(
      JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))).includes("codeDoc"),
      true,
      "conversion never rewrites the source package",
    );
    assert.equal(invoke("--source", destination, "--mode", "dry-run").receipt.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline CLI converts an old repository declaration that still stores codeDoc", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-retired-closeout-"));
  try {
    const source = path.join(root, "old.json"),
      destination = path.join(root, "new.json"),
      historical = JSON.parse(sample("repository-after"));
    historical.definition.completion.closeoutDefaults.codeDoc = true;
    writeFileSync(source, JSON.stringify(historical));
    assert.throws(() => parseVerticalDeclarationDocument(historical), /ha migrate completion/u);
    const converted = invoke("--source", source, "--mode", "convert", "--destination", destination);
    assert.equal(converted.status, 0, JSON.stringify(converted));
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), JSON.parse(sample("repository-after")));
    assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), historical);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
