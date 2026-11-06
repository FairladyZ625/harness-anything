// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1, openTodoValueEquals, type TaskProjectionQueries } from "@harness-anything/kernel";
import { runEntityPinAction } from "../src/entity-pin-action.ts";
import { todoSoftLimitWarnings } from "../src/todo-soft-limit.ts";

test("pinning a schedule decides existence with a point read, not the schedule list", () => {
  const readKinds: string[] = [],
    cell = {
      input: { repoId: "bounded-read" },
      projection: {
        getEntity: (kind: string, id: string) => {
          readKinds.push(`${kind}/${id}`);
          return { id, value: {}, kind, ownerId: null, workspaceRevision: 1, freshness: "current", currentVersion: 1 };
        },
        listEntities: () => {
          throw new Error("pin existence must not list every schedule");
        },
        listPinnedEntities: () => [],
        apply: () => undefined,
        readOperation: () => ({ watermark: 2 }),
      },
      store: { readHead: () => ({ revision: 1 }), append: () => ({ revision: 2 }) },
      settings: { readRepository: () => ({ agenda: { pinLimit: 10 } }) },
      operationId: () => "pin-schedule",
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      publicPublication: () => ({}),
      now: () => "2026-11-07T00:00:00.000Z",
    },
    receipt = runEntityPinAction(
      cell as never,
      { kind: "entity-pin", entityRef: "schedule/schedule-1" } as never,
      { actor: { principal: { personId: "pin-owner" }, executor: null }, source: "local" } as never,
    );
  assert.equal(receipt.outcome, "applied");
  assert.deepEqual(readKinds, ["schedule/schedule-1"]);
});

test("todo soft limit counts open todos in SQL instead of materializing every todo", () => {
  const calls: Array<{ readonly kind: string; readonly equals: unknown }> = [],
    projection = {
      getEntity: (kind: string) =>
        kind === "settings" ? { value: { ...INITIAL_SETTINGS_V1, todos: { softLimit: 2 } } } : null,
      countEntities: (kind: string, equals: Readonly<Record<string, unknown>>) => {
        calls.push({ kind, equals });
        return 3;
      },
      listEntities: () => {
        throw new Error("the soft limit must not materialize every todo, including completed ones");
      },
    } as unknown as TaskProjectionQueries,
    warnings = todoSoftLimitWarnings({ projection } as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, "todo");
  assert.deepEqual(calls[0]!.equals, openTodoValueEquals);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /3 unfinished todos exceed the soft limit of 2/u);
});
