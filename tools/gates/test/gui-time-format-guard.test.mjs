// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { ESLint } from "eslint";

const root = path.resolve(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: root });
const pagePath = "packages/gui/src/renderer/views/time-guard-probe.ts";
async function restricted(source, filePath = pagePath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax");
}

test("renderer date formatting and calendar getters must use the shared time model", async () => {
  for (const expression of [
    "new Date().toLocaleString()",
    "new Date().toLocaleDateString()",
    "new Date().toLocaleTimeString()",
    "new Intl.DateTimeFormat()",
    "new Date().getFullYear()",
    "new Date().getMonth()",
    "new Date().getDate()",
    "new Date().getHours()",
    "new Date().getUTCFullYear()",
  ]) {
    const messages = await restricted(`export const value = ${expression};`);
    assert.equal(messages.length, 1, `${expression}: ${JSON.stringify(messages)}`);
    assert.match(messages[0].message, /model\/time\.ts/u);
  }
});

test("the time model itself and code outside renderer remain able to format dates", async () => {
  for (const filePath of ["packages/gui/src/renderer/model/time.ts", "packages/gui/src/main/time-guard-probe.ts"])
    assert.deepEqual(await restricted("export const value = new Date().toLocaleDateString();", filePath), []);
  assert.deepEqual(
    await restricted('import { formatTime } from "../model/time.ts"; export const value = formatTime(0);'),
    [],
  );
});

test("adding date restrictions does not replace the existing renderer IPC and import boundary", async () => {
  const source = 'import { ipcRenderer } from "electron"; ipcRenderer.invoke("arbitrary");';
  const [result] = await eslint.lintText(source, { filePath: pagePath });
  assert.ok(
    result.messages.some((message) => message.ruleId === "no-restricted-imports"),
    JSON.stringify(result.messages),
  );
  assert.ok(
    result.messages.some((message) => message.ruleId === "no-restricted-syntax"),
    JSON.stringify(result.messages),
  );
});
