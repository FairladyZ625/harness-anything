// harness-test-tier: integration
import test from "node:test";
import { P4_READ_BACKENDS, verifyPgRelationReadCost } from "./fixtures/g38-relation-bounded.mjs";

// Removal authority: dec_193D3BD6C59FCA1ECE4C820415 and dec_9806C22E9717DD821A205AABAA.
// One file shares the database/schema setup across all original 200/2000 dimensions.
// Every dimension still resets its data before measurement and keeps every assertion.
for (const backend of P4_READ_BACKENDS)
  for (const dimension of ["runtime-sessions", "relations", "dispatches", "relation-visibility"])
    test(
      `P4 ${backend}/${dimension} original-scale reads stay bounded`,
      {
        skip:
          backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
            ? "PGlite database measurements require Node 26; cost-budget-reads runs on Node 26"
            : false,
      },
      (t) => verifyPgRelationReadCost(t, backend, dimension),
    );
