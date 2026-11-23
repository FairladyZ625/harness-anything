// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  closeSqliteEventStoresUnder,
  makeTaskEventStore,
} from "@harness-anything/storage";
import { main } from "../src/index.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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

test("ha fleet center export, retire, and import route through daemon control, verify lineage flags, and rebind center routing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cli-center-reloc-")),
    source = path.join(root, "source"),
    bundle = path.join(root, "bundle"),
    restored = path.join(root, "restored"),
    oldUserRoot = path.join(root, "old-user"),
    newUserRoot = path.join(root, "new-user");
  try {
    const unconfirmedPromotion = await captureCli([
      "daemon",
      "fleet",
      "center",
      "promote-from-edge",
      "--force-new-epoch",
      "--json",
    ]);
    assert.equal(unconfirmedPromotion.exitCode, 2);
    assert.equal(JSON.parse(unconfirmedPromotion.stdout[0]!).code, "missing_confirmation");

    const missingEpochConfirmation = await captureCli([
      "daemon",
      "fleet",
      "center",
      "promote-from-edge",
      "--confirm-possible-tail-loss",
      "--json",
    ]);
    assert.equal(missingEpochConfirmation.exitCode, 2);
    assert.equal(JSON.parse(missingEpochConfirmation.stdout[0]!).code, "missing_confirmation");

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
      "--user-root",
      oldUserRoot,
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

    // Lineage mismatch flags fail closed before writing destination.
    const wrongRevision = await captureCli([
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
      "--expected-final-revision",
      "999",
      "--json",
    ]);
    assert.equal(wrongRevision.exitCode, 1);
    assert.equal(JSON.parse(wrongRevision.stdout[0]!).ok, false);

    const wrongTip = await captureCli([
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
      "--expected-tip-hash",
      `sha256:${"f".repeat(64)}`,
      "--json",
    ]);
    assert.equal(wrongTip.exitCode, 1);
    assert.equal(JSON.parse(wrongTip.stdout[0]!).ok, false);

    // Pre-seed newUserRoot/rbac/config.json to verify --login-url rebinding.
    mkdirSync(path.join(newUserRoot, "rbac"), { recursive: true });
    writeFileSync(
      path.join(newUserRoot, "rbac", "config.json"),
      `${JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external", url: "https://old-login.example.invalid" })}\n`,
    );

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
      "--external-url",
      "https://center2.example.invalid:9443",
      "--login-url",
      "https://login2.example.invalid:8443",
      "--expected-final-revision",
      String(exportReceipt.manifest.finalRevision),
      "--expected-tip-hash",
      exportReceipt.manifest.tipHash,
      "--json",
    ]);
    assert.equal(imported.exitCode, 0, imported.stdout.join("\n"));
    const importReceipt = JSON.parse(imported.stdout[0]!) as {
      readonly newEpoch: number;
      readonly externalUrl?: string;
      readonly loginUrl?: string;
      readonly nextAction: string;
    };
    assert.equal(importReceipt.newEpoch, 4);
    assert.equal(importReceipt.externalUrl, "https://center2.example.invalid:9443");
    assert.equal(importReceipt.loginUrl, "https://login2.example.invalid:8443");
    assert.match(importReceipt.nextAction, /--external-url https:\/\/center2\.example\.invalid:9443/u);
    assert.match(importReceipt.nextAction, /--login-url https:\/\/login2\.example\.invalid:8443/u);
    assert.match(importReceipt.nextAction, /--epoch 4/u);

    const routing = JSON.parse(
      readFileSync(path.join(newUserRoot, "fleet", "center-routing", "reloc-cli.json"), "utf8"),
    ) as {
      readonly schema: string;
      readonly repoId: string;
      readonly externalUrl: string;
      readonly loginUrl: string;
      readonly writerEpoch: number;
    };
    assert.equal(routing.schema, "center-routing/v1");
    assert.equal(routing.repoId, "reloc-cli");
    assert.equal(routing.externalUrl, "https://center2.example.invalid:9443");
    assert.equal(routing.loginUrl, "https://login2.example.invalid:8443");
    assert.equal(routing.writerEpoch, 4);

    const rbacConfig = JSON.parse(readFileSync(path.join(newUserRoot, "rbac", "config.json"), "utf8")) as {
      readonly url: string;
    };
    assert.equal(rbacConfig.url, "https://login2.example.invalid:8443");

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
    closeSqliteEventStoresUnder(root);
    removeTempRepository(root);
  }
});
