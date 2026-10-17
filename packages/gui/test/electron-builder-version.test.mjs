// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import config from "../electron-builder.config.mjs";

const readPackage = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("desktop app metadata uses the published CLI package version", () => {
  const cliPackage = readPackage("../../cli/package.json");

  assert.equal(config.extraMetadata.version, cliPackage.version);
});

test("macOS packaging requires hardened runtime signing and notarization", () => {
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.match(config.mac.entitlements, /entitlements\.mac\.plist$/u);
  assert.match(config.mac.entitlementsInherit, /entitlements\.mac\.inherit\.plist$/u);
  assert.equal("identity" in config.mac, false);
});

test("macOS signing entitlements keep the Electron runtime capabilities minimal", () => {
  const entitlements = readFileSync(config.mac.entitlements, "utf8");
  const inheritedEntitlements = readFileSync(config.mac.entitlementsInherit, "utf8");

  for (const document of [entitlements, inheritedEntitlements]) {
    assert.match(document, /com\.apple\.security\.cs\.allow-jit/u);
    assert.match(document, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/u);
    assert.doesNotMatch(document, /disable-library-validation|camera|microphone|apple-events/u);
  }
});
