// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { activateEmptyCanonicalGeneration, makeTaskEventStore } from "@harness-anything/storage";
import { main } from "../src/index.ts";

function captureCli(argv: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string[];
  readonly stderr: string[];
}> {
  const stdout: string[] = [],
    stderr: string[] = [],
    originalLog = console.log,
    originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  return main(argv)
    .then((exitCode) => ({ exitCode, stdout, stderr }))
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
    });
}

async function createGitSourceRepo(root: string, repoId: string): Promise<void> {
  const authored = path.join(root, "harness");
  mkdirSync(authored, { recursive: true });
  writeFileSync(path.join(authored, "harness.yaml"), "layout:\n  authoredRoot: harness\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Relocation CLI Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "relocation@example.test"], { cwd: root });
  execFileSync("git", ["add", "harness/harness.yaml"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  const store = makeTaskEventStore({
    repoId,
    rootDir: root,
    activationPreflight: activateEmptyCanonicalGeneration,
    writerFence: () => ({ repoId, holderId: "reloc-cli-test", epoch: 3 }),
  });
  await store.drain();
}

test("ha fleet center export, retire, and import route through daemon control without touching a live daemon", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-center-reloc-")),
    source = path.join(root, "source"),
    bundle = path.join(root, "bundle"),
    restored = path.join(root, "restored"),
    oldUserRoot = path.join(root, "old-user"),
    newUserRoot = path.join(root, "new-user");
  try {
    await createGitSourceRepo(source, "reloc-cli");
    const missing = await captureCli(["fleet", "center", "export", "--json"]);
    assert.equal(missing.exitCode, 2);
    assert.equal(JSON.parse(missing.stdout[0]!).code, "missing_field");

    const exported = await captureCli([
      "fleet",
      "center",
      "export",
      "--root",
      source,
      "--bundle",
      bundle,
      "--repo",
      "reloc-cli",
      "--writer-epoch",
      "3",
      "--json",
    ]);
    assert.equal(exported.exitCode, 0, exported.stdout.join("\n"));
    const exportReceipt = JSON.parse(exported.stdout[0]!) as {
      readonly ok: boolean;
      readonly command: string;
      readonly manifest: { readonly tipHash: string; readonly finalRevision: number };
    };
    assert.equal(exportReceipt.ok, true);
    assert.equal(exportReceipt.command, "fleet-center-export");

    const retired = await captureCli([
      "fleet",
      "center",
      "retire",
      "--user-root",
      oldUserRoot,
      "--repo",
      "reloc-cli",
      "--old-epoch",
      "3",
      "--final-revision",
      String(exportReceipt.manifest.finalRevision),
      "--tip-hash",
      exportReceipt.manifest.tipHash,
      "--new-external-url",
      "https://center2.example.invalid:9443",
      "--new-login-url",
      "https://login2.example.invalid",
      "--spki-sha256",
      `sha256:${createHash("sha256").update("spki").digest("hex")}`,
      "--json",
    ]);
    assert.equal(retired.exitCode, 0, retired.stdout.join("\n"));
    assert.equal(JSON.parse(retired.stdout[0]!).tombstone.newEpoch, 4);

    const imported = await captureCli([
      "fleet",
      "center",
      "import",
      "--bundle",
      bundle,
      "--destination",
      restored,
      "--user-root",
      newUserRoot,
      "--repo",
      "reloc-cli",
      "--json",
    ]);
    assert.equal(imported.exitCode, 0, imported.stdout.join("\n"));
    const importReceipt = JSON.parse(imported.stdout[0]!) as { readonly newEpoch: number };
    assert.equal(importReceipt.newEpoch, 4);

    const manifestPath = path.join(bundle, "manifest.json"),
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        readonly files: readonly { readonly path: string }[];
      };
    writeFileSync(path.join(bundle, "payload", manifest.files[0]!.path), "corrupted");
    const tampered = await captureCli([
      "fleet",
      "center",
      "import",
      "--bundle",
      bundle,
      "--destination",
      path.join(root, "tampered"),
      "--user-root",
      newUserRoot,
      "--json",
    ]);
    assert.equal(tampered.exitCode, 1);
    assert.equal(JSON.parse(tampered.stdout[0]!).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
