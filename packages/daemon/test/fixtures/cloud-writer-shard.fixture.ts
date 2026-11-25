import { readFileSync } from "node:fs";
import path from "node:path";
import { readSettingsFacet, sha256Text, taskBootstrapWritePlan, type CanonicalEventStore } from "@harness-anything/kernel";
import { compileRepoTaskBootstrap } from "@harness-anything/preset";
import { actor } from "../migration-import.fixtures.ts";

export const cloudOwner = actor;

/** Appends one task the way an edge would have created it, so the cloud shard starts from a real
 *  package: task contract, plan, progress and the frozen preset snapshot. */
export function seedCloudTask(
  store: CanonicalEventStore,
  rootDir: string,
  taskId: string,
  title: string,
  taskClass?: "work",
): string {
  const opId = `op-seed-${taskId}`,
    compiled = compileRepoTaskBootstrap({
      rootDir,
      settings: readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8")),
      action: { kind: "task-create", title, ...(taskClass === undefined ? {} : { taskClass }) },
      taskId,
      actor,
      source: "local",
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      eventId: `event-${sha256Text(opId)}`,
      opId,
      occurredAt: "2026-11-01T00:00:00.000Z",
    });
  store.append({ event: compiled.event, plan: taskBootstrapWritePlan(compiled.event), blobs: compiled.blobs });
  return compiled.packagePath;
}

export function cloudRequest(
  repoId: string,
  body: unknown,
  headers: { readonly idempotencyKey?: string; readonly token?: string } = {},
): Request {
  return new Request(`https://writer.example.invalid/v1/repositories/${repoId}/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${headers.token ?? "token-owner"}`,
      "content-type": "application/json",
      ...(headers.idempotencyKey === undefined ? {} : { "idempotency-key": headers.idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

export const allowOwner = {
  authorizeRepositoryWrite: async () =>
    ({
      outcome: "allowed",
      actor: cloudOwner,
      authorizationDecision: {
        outcome: "allowed",
        policyEpoch: 1,
        reason: "cloud-writer-fixture",
        evaluatedAt: "2026-11-01T00:00:00.000Z",
      },
    }) as const,
};
