// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeActorAxesBindingOperationV2,
  type ActorAxesBindingRuntimeV2,
  type VerifiedActorAxesBindingV2
} from "../src/index.ts";

test("actor-axes binding consumption forwards the fixed inner op id and accepts same-op replay", async () => {
  const attempts: unknown[] = [];
  const results = ["consumed", "already-consumed-by-same-op"] as const;
  const runtime = {
    consumeOperation: async (input: unknown) => {
      attempts.push(input);
      return results[attempts.length - 1]!;
    }
  } as unknown as ActorAxesBindingRuntimeV2;
  const verified = {
    token: {
      claims: {
        tokenId: "token-1",
        maxOperations: 1
      }
    }
  } as unknown as VerifiedActorAxesBindingV2;

  await consumeActorAxesBindingOperationV2(verified, "namespace-1:001122", runtime);
  await consumeActorAxesBindingOperationV2(verified, "namespace-1:001122", runtime);

  assert.deepEqual(attempts, [
    { tokenId: "token-1", maximum: 1, opId: "namespace-1:001122" },
    { tokenId: "token-1", maximum: 1, opId: "namespace-1:001122" }
  ]);
});

test("actor-axes binding consumption rejects a denied operation slot", async () => {
  const runtime = {
    consumeOperation: async () => "denied"
  } as unknown as ActorAxesBindingRuntimeV2;
  const verified = {
    token: {
      claims: {
        tokenId: "token-1",
        maxOperations: 1
      }
    }
  } as unknown as VerifiedActorAxesBindingV2;

  await assert.rejects(
    consumeActorAxesBindingOperationV2(verified, "namespace-1:001122", runtime),
    /TOKEN_OPERATION_LIMIT_EXCEEDED/u
  );
});

test("actor-axes binding consumption fails closed on an invalid adapter result", async () => {
  const runtime = {
    consumeOperation: async () => undefined
  } as unknown as ActorAxesBindingRuntimeV2;
  const verified = {
    token: {
      claims: {
        tokenId: "token-1",
        maxOperations: 1
      }
    }
  } as unknown as VerifiedActorAxesBindingV2;

  await assert.rejects(
    consumeActorAxesBindingOperationV2(verified, "namespace-1:001122", runtime),
    /TOKEN_OPERATION_CONSUME_RESULT_INVALID/u
  );
});
