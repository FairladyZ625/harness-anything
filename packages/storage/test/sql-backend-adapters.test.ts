// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerSqlBackendAdapters,
  requireSqlTaskQueryReader,
  type SqlTaskQueryReaderOpener,
} from "../src/sql-backend-adapters.ts";

// dec_04A9211B073F29F0FC1E1CA573 CH2: importing one driver subpath must not replace another driver's ports.
test("PG and PGlite adapter registration is isolated in either import order", () => {
  const common: SqlTaskQueryReaderOpener = () => {
      throw new Error("not invoked");
    },
    pg: SqlTaskQueryReaderOpener = () => {
      throw new Error("not invoked");
    },
    embedded: SqlTaskQueryReaderOpener = () => {
      throw new Error("not invoked");
    };
  registerSqlBackendAdapters({ createSqlTaskQueryReader: common });
  registerSqlBackendAdapters({ createSqlTaskQueryReader: pg }, "postgres");
  assert.equal(requireSqlTaskQueryReader("postgres"), pg);
  assert.equal(requireSqlTaskQueryReader("pglite"), common);
  registerSqlBackendAdapters({ createSqlTaskQueryReader: embedded }, "pglite");
  assert.equal(requireSqlTaskQueryReader("pglite"), embedded);
  assert.equal(requireSqlTaskQueryReader("postgres"), pg);
});
