// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { findEnvProfileSecretViolations, validateEnvProfile, type EnvProfile } from "../src/index.ts";

test("EnvProfile validates terminal launch context without resolving secrets", () => {
  const profile: EnvProfile = {
    envProfileId: "env-local-project",
    name: "Local project",
    projectId: "project-a",
    cwd: "/workspace",
    shell: "/bin/zsh",
    env: {
      NODE_ENV: "development",
      PATH: "/usr/bin"
    },
    inheritSystemEnv: true,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z"
  };

  assert.deepEqual(validateEnvProfile(profile, { requiredScope: "project" }), { ok: true });
  assert.deepEqual(findEnvProfileSecretViolations(profile), []);
});

test("EnvProfile scope validation fails closed for host and project specific profiles", () => {
  const base: EnvProfile = {
    envProfileId: "env-remote",
    name: "Remote",
    env: {},
    inheritSystemEnv: false,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z"
  };

  assert.deepEqual(validateEnvProfile(base, { requiredScope: "host" }), {
    ok: false,
    error: {
      code: "invalid_env_profile_scope",
      hint: "Host-specific EnvProfile requires hostProfileId."
    }
  });
  assert.deepEqual(validateEnvProfile({ ...base, hostProfileId: "host-1" }, { requiredScope: "host" }), { ok: true });
  assert.deepEqual(validateEnvProfile({ ...base, projectId: "project-a" }, { requiredScope: "project" }), { ok: true });
});

test("EnvProfile rejects obvious inline secrets while allowing secret references", () => {
  const profile: EnvProfile = {
    envProfileId: "env-secret",
    name: "Bad profile",
    env: {
      API_TOKEN: "plain-text-token",
      SSH_KEY_REF: "keychain:remote-host-key",
      PRIVATE_MATERIAL: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    },
    inheritSystemEnv: false,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z"
  };

  assert.deepEqual(validateEnvProfile(profile), {
    ok: false,
    error: {
      code: "env_profile_contains_secret",
      hint: "EnvProfile is launch context, not a secret store; use keychain, ssh-agent, or an enterprise secret reference.",
      violations: [
        { key: "API_TOKEN", reason: "secret_key_name" },
        { key: "PRIVATE_MATERIAL", reason: "secret_value" }
      ]
    }
  });
});
