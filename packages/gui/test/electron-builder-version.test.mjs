// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import config from "../electron-builder.config.mjs";

const readPackage = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("desktop app metadata uses the published CLI package version", () => {
  const cliPackage = readPackage("../../cli/package.json");

  assert.equal(config.extraMetadata.version, cliPackage.version);
});

test("macOS packaging requires hardened runtime signing and notarization", () => {
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.sign.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.match(config.mac.sign.entitlements, /entitlements\.mac\.plist$/u);
  assert.match(config.mac.sign.entitlementsInherit, /entitlements\.mac\.inherit\.plist$/u);
  assert.equal("identity" in config.mac, false);
});

test("macOS signing entitlements keep the Electron runtime capabilities minimal", () => {
  const entitlements = readFileSync(config.mac.sign.entitlements, "utf8");
  const inheritedEntitlements = readFileSync(config.mac.sign.entitlementsInherit, "utf8");

  for (const document of [entitlements, inheritedEntitlements]) {
    assert.match(document, /com\.apple\.security\.cs\.allow-jit/u);
    assert.match(document, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/u);
    assert.doesNotMatch(document, /disable-library-validation|camera|microphone|apple-events/u);
  }
});

test("macOS signing ignores data resources while retaining Mach-O binaries and code bundles", () => {
  const ignore = config.mac.sign.ignore;
  const directory = mkdtempSync(join(tmpdir(), "gui-signing-filter-"));
  const machoPath = join(directory, "node");
  const fatPath = join(directory, "universal.dylib");
  const littleEndianFatPath = join(directory, "little-endian-universal.dylib");
  const javaClassPath = join(directory, "Example.class");
  const resourcePath = join(directory, "resource.pak");
  const appPath = join(directory, "Harness.app");
  const frameworkPath = join(directory, "Electron Framework.framework");

  try {
    writeFileSync(machoPath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    writeFileSync(fatPath, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
    writeFileSync(littleEndianFatPath, Buffer.from([0xbe, 0xba, 0xfe, 0xca, 2, 0, 0, 0]));
    writeFileSync(javaClassPath, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 50]));
    writeFileSync(resourcePath, Buffer.from("resource data"));

    assert.equal(ignore(machoPath), false);
    assert.equal(ignore(fatPath), false);
    assert.equal(ignore(littleEndianFatPath), false);
    assert.equal(ignore(javaClassPath), true);
    assert.equal(ignore(resourcePath), true);
    assert.equal(ignore(appPath), false);
    assert.equal(ignore(frameworkPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
