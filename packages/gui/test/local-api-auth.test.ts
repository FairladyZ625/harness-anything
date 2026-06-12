import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeLocalApiRequest,
  createLocalApiSession,
  localApiBindHost,
  localApiMaxBodyBytes
} from "../src/index.ts";

test("local API binds localhost and rejects missing or wrong authorization", () => {
  const session = createLocalApiSession();

  assert.equal(localApiBindHost, "127.0.0.1");
  assert.equal(session.bindHost, "127.0.0.1");
  assert.deepEqual(session.corsAllowedOrigins, []);
  assert.equal(authorizeLocalApiRequest(session, { headers: {}, bodyBytes: 0 }), false);
  assert.equal(authorizeLocalApiRequest(session, { headers: { authorization: "Bearer wrong" }, bodyBytes: 0 }), false);
  assert.equal(authorizeLocalApiRequest(session, { headers: { authorization: `Bearer ${session.sessionToken}` }, bodyBytes: 0 }), true);
  assert.equal(authorizeLocalApiRequest(session, { headers: { authorization: `Bearer ${session.sessionToken}` }, bodyBytes: localApiMaxBodyBytes + 1 }), false);
});
