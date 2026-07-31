import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  type WriteCoordinator
} from "../../../kernel/src/index.ts";

const commitAuthor = { name: "Harness Test", email: "harness@example.test" };

export function attributedCoordinator(rootDir: string, sessionId?: string): WriteCoordinator {
  return makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: { kind: "agent", id: "codex-test" }
      },
      principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: `sha256:${"0".repeat(64)}` },
      executorSource: "client-asserted"
    },
    commitAuthor,
    ...(sessionId ? { sessionId, autoMaterialize: false } : {})
  });
}

export function capturingAttributedCoordinator(
  rootDir: string,
  captured: Array<Record<string, unknown>>
): WriteCoordinator {
  const coordinator = attributedCoordinator(rootDir);
  const journalPath = path.join(rootDir, ".harness", "write-journal", "writes.jsonl");
  return {
    ...coordinator,
    enqueue: (op) => coordinator.enqueue(op).pipe(Effect.tap(() => Effect.sync(() => {
      captured.push(...readFileSync(journalPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
    })))
  };
}
