import assert from "node:assert/strict";

export async function bridgeReady(page) {
  assert.equal(await page.evaluate(() => typeof globalThis.harness), "object", "preload bridge unavailable");
  const ready = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  const failed = page.getByTestId("task-error-state");
  await ready.or(failed).first().waitFor();
  if (await failed.isVisible()) throw new Error(await failed.innerText());
}

export async function nav(page, name, testId) {
  await page.getByRole("button", { name }).click();
  await page.getByTestId(testId).first().waitFor();
}
