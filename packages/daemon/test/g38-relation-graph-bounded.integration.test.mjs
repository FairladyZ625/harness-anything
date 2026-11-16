// harness-test-tier: integration
import test from "node:test";
import { P4_READ_BACKENDS, verifyPgRelationReadCost } from "./fixtures/g38-relation-bounded.mjs";

// Removal authority: dec_193D3BD6C59FCA1ECE4C820415 and dec_9806C22E9717DD821A205AABAA.
// Preserve every original 200/2000 probe and assertion; split only the execution files.
for (const backend of P4_READ_BACKENDS)
  for (const dimension of ["runtime-sessions", "relations"])
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
