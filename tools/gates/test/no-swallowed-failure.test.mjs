// harness-test-tier: contract
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

test("G05 baseline fingerprints agree across LF and CRLF checkouts of the same source (#1538)", () => {
  const lf = "try {\n  work();\n} catch (error) {\n  return undefined;\n}";
  const first = lint(lf);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.ok(fingerprint);
  // A Git-for-Windows checkout with core.autocrlf=true carries \r\n; the baseline was
  // generated on an LF checkout, so the same source must fingerprint identically either way.
  assert.deepEqual(lint(lf.replaceAll("\n", "\r\n"), [fingerprint]), []);
});

test("G05 baseline exempts only the exact existing catch body", () => {
  const source = "try { work(); } catch (error) { return undefined; }";
  const first = lint(source);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.ok(fingerprint);
  assert.deepEqual(lint(source, [fingerprint]), []);
  assert.equal(lint("try { work(); } catch (error) { log(error); return undefined; }", [fingerprint]).length, 1);
});

test("G05 baseline exemption survives a reformat that shifts the catch clause's line number (#w2c-line-drift)", () => {
  const source = "try { work(); } catch (error) { return undefined; }";
  const first = lint(source);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.ok(fingerprint);
  // Unrelated lines added above the catch clause (e.g. Prettier wrapping an earlier
  // function's signature onto more lines) shift its line:column without touching its
  // own text — the stored fingerprint's line:column no longer matches, but the catch
  // clause is the exact same one that was already reviewed and grandfathered.
  const reflowed = `\n\n\n${source}`;
  assert.deepEqual(lint(reflowed, [fingerprint]), []);
});

test("G05 a genuinely different catch body at the baselined position is still rejected", () => {
  const source = "try { work(); } catch (error) { return undefined; }";
  const first = lint(source);
  const fingerprint = /Baseline key: (\S+)/u.exec(first[0].message)?.[1];
  assert.ok(fingerprint);
  const different = "try { work(); } catch (error) { report(error); return undefined; }";
  assert.equal(lint(different, [fingerprint]).length, 1);
});
