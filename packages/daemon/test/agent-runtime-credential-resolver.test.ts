// harness-test-tier: fast
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCredentials } from "../src/agent-runtime/credential-resolver.ts";

test("resolveCredentials prioritizes env over YAML", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "cred-test-"));
  const credFile = path.join(userRoot, "agent-runtime-credentials.yaml");

  writeFileSync(credFile, `schema: agent-runtime-credentials/v1
profiles:
  - kindId: codex
    profileKind: api-key
    apiKey: sk-yaml-key
    baseUrl: https://yaml.example.com
`);

  try {
    // Test 1: env wins
    const withEnv = resolveCredentials("codex", "api-key", userRoot, { OPENAI_API_KEY: "sk-env-key" });
    assert.equal(withEnv.apiKey, "sk-env-key");
    assert.equal(withEnv.env.OPENAI_API_KEY, "sk-env-key");
    assert.equal(withEnv.baseUrl, undefined); // env didn't set base URL

    // Test 2: YAML used when env empty
    const withoutEnv = resolveCredentials("codex", "api-key", userRoot, {});
    assert.equal(withoutEnv.apiKey, "sk-yaml-key");
    assert.equal(withoutEnv.baseUrl, "https://yaml.example.com");
    assert.equal(withoutEnv.env.OPENAI_API_KEY, "sk-yaml-key");
    assert.equal(withoutEnv.env.OPENAI_BASE_URL, "https://yaml.example.com");

    // Test 3: non-api-key profile returns env as-is
    const subscriptionProfile = resolveCredentials("claude-code", "subscription-account", userRoot, { FOO: "bar" });
    assert.equal(subscriptionProfile.apiKey, undefined);
    assert.equal(subscriptionProfile.env.FOO, "bar");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("resolveCredentials handles missing YAML file", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "cred-test-"));
  try {
    const result = resolveCredentials("codex", "api-key", userRoot, {});
    assert.equal(result.apiKey, undefined);
    assert.deepEqual(result.env, {});
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("resolveCredentials reads the document without a YAML dependency", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "cred-test-"));
  const credFile = path.join(userRoot, "agent-runtime-credentials.yaml");
  // Quoting, comments, blank lines and a sibling profile all appear in files
  // people hand-edit, so the direct parser has to survive them.
  writeFileSync(credFile, `schema: agent-runtime-credentials/v1
profiles:
  - kindId: claude-code
    profileKind: api-key
    apiKey: "sk-quoted-claude"

  - kindId: codex   # trailing comment
    profileKind: api-key
    apiKey: 'sk-quoted-codex'
    baseUrl: https://codex.example.com
`);
  try {
    const claude = resolveCredentials("claude-code", "api-key", userRoot, {});
    assert.equal(claude.apiKey, "sk-quoted-claude");
    assert.equal(claude.baseUrl, undefined);
    const codex = resolveCredentials("codex", "api-key", userRoot, {});
    assert.equal(codex.apiKey, "sk-quoted-codex");
    assert.equal(codex.baseUrl, "https://codex.example.com");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("resolveCredentials accepts JSON as a strict YAML subset", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "cred-test-"));
  const credFile = path.join(userRoot, "agent-runtime-credentials.yaml");
  writeFileSync(credFile, JSON.stringify({
    schema: "agent-runtime-credentials/v1",
    profiles: [{ kindId: "codex", profileKind: "api-key", apiKey: "sk-json", baseUrl: "https://json.example.com" }]
  }));
  try {
    const resolved = resolveCredentials("codex", "api-key", userRoot, {});
    assert.equal(resolved.apiKey, "sk-json");
    assert.equal(resolved.baseUrl, "https://json.example.com");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
