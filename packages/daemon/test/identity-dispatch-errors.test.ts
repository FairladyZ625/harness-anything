// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityProvider } from "../src/identity/types.ts";
import { personRegistryFromRecords } from "../src/identity/person-registry.ts";
import { resolveIdentityActorForMethod } from "../src/protocol/identity-dispatch.ts";
import { jsonRpcMethodContracts } from "../src/protocol/method-registry.ts";

const writeContract = jsonRpcMethodContracts.find((contract) => contract.method === "repo.task.claim")!;

test("missing person registry reports unavailable source without guessing a roster path or recommending restart", async () => {
  const result = await resolveIdentityActorForMethod(writeContract, {
    identityProvider: identityProvider("person_probe")
  });

  assert.deepEqual(result, {
    ok: false,
    code: "person_registry_unavailable",
    providerId: "provider_test",
    message: "Authenticated daemon requests require a core person registry, but no active roster source is available to this identity dispatcher. No authentication state was changed. Inspect the active daemon identity configuration and logs; use `ha daemon status --json` only to verify the endpoint and loaded build before retrying."
  });
});

test("unregistered person reports the active registry gap without guessing its source path", async () => {
  const result = await resolveIdentityActorForMethod(writeContract, {
    identityProvider: identityProvider("person_probe"),
    personRegistry: personRegistryFromRecords([])
  });

  assert.equal(
    result && !result.ok ? result.message : undefined,
    "Identity provider authenticated personId person_probe, but that person is not registered in the active person registry. This dispatcher does not know the registry source path and made no identity change. Inspect the active daemon identity configuration and logs; use `ha daemon status --json` only to verify the endpoint and loaded build before retrying."
  );
});

test("disabled person reports the active registry state without guessing its source path", async () => {
  const result = await resolveIdentityActorForMethod(writeContract, {
    identityProvider: identityProvider("person_probe"),
    personRegistry: personRegistryFromRecords([{
      personId: "person_probe",
      displayName: "Probe",
      disabled: true
    }])
  });

  assert.equal(
    result && !result.ok ? result.message : undefined,
    "Person person_probe is disabled in the active person registry, so the request is rejected. This dispatcher does not know the registry source path and made no identity change. Inspect the active daemon identity configuration and logs; use `ha daemon status --json` only to verify the endpoint and loaded build before retrying."
  );
});

function identityProvider(personId: string): IdentityProvider {
  return {
    providerId: "provider_test",
    authenticate: async () => ({
      ok: true,
      personId,
      providerId: "provider_test",
      credential: {
        kind: "email-address",
        issuer: "email:primary",
        subject: "probe@example.test"
      }
    }),
    authorize: async () => ({ ok: true })
  };
}
