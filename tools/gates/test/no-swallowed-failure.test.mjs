import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";
import noSwallowedFailure from "../eslint-rules/no-swallowed-failure.js";

function lint(source, baseline = []) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(`async function run() { ${source} }`, {
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    plugins: { ha: { rules: { "no-swallowed-failure": noSwallowedFailure } } },
    rules: { "ha/no-swallowed-failure": ["error", { baseline }] }
  }, { filename: "packages/kernel/src/new-code.js" });
}

test("G05 accepts rethrow, explicit consumption, and explicit failure returns", () => {
  assert.deepEqual(lint("try { work(); } catch (error) { throw error; }"), []);
  assert.deepEqual(lint("try { work(); } catch (error) { consumeKnownError(error); return undefined; }"), []);
  assert.deepEqual(lint("try { work(); } catch (error) { report(error); return { ok: false }; }"), []);
});

test("G05 rejects fallthrough and undefined or success projections", () => {
  assert.match(lint("try { work(); } catch (error) { report(error); }")[0].message, /can fall through/u);
  assert.match(lint("try { work(); } catch (error) { return undefined; }")[0].message, /projected as undefined or success/u);
  assert.match(lint("try { work(); } catch (error) { return { ok: true }; }")[0].message, /projected as undefined or success/u);
});

test("G05 baseline exempts only the exact existing catch body", () => {
  const source = "try { work(); } catch (error) { return undefined; }";
  const first = lint(source);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.ok(fingerprint);
  assert.deepEqual(lint(source, [fingerprint]), []);
  assert.equal(lint("try { work(); } catch (error) { log(error); return undefined; }", [fingerprint]).length, 1);
});
