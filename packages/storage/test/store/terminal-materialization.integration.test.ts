// harness-test-tier: integration
import test from "node:test";
import { makeTaskProjection, makeTaskEventStore } from "../../src/index.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";

test("SQLite terminal documents retain canonical holds and unlock incrementally", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "terminal-materialization", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      await assertTerminalMaterialization({
        append: (bundle) => {
          store.append(bundle);
          projection.apply(bundle.event, bundle.plan);
        },
        document: (path) => projection.readDocument(path).document,
        history: (path) => projection.readDocumentHistory(path).document,
        fact: (id) => projection.readFact(id).fact,
        decision: (id) => projection.readDecision(id).decision,
      });
    } finally {
      await store.drain();
      projection.close();
    }
  });
});
