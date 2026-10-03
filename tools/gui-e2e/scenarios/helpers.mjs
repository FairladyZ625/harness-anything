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

// Measure the local surface: document.scrollWidth misses clipped children and
// forced scrollbars whose contents happen to fit.
export async function assertUnscrolledLayout(container, childSelector = ":scope > *") {
  const layout = await container.evaluate((node, selector) => {
    const box = node.getBoundingClientRect();
    const children = [...node.querySelectorAll(selector)]
      .filter((child) => child.getClientRects().length > 0)
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          left: rect.left - box.left,
          right: rect.right - box.left,
          top: rect.top - box.top,
          bottom: rect.bottom - box.top,
        };
      });
    const previous = node.scrollLeft;
    node.scrollLeft = 100;
    const scrollLeft = node.scrollLeft;
    node.scrollLeft = previous;
    return {
      width: box.width,
      height: box.height,
      client: node.clientWidth,
      scroll: node.scrollWidth,
      overflowX: globalThis.getComputedStyle(node).overflowX,
      scrollLeft,
      children,
    };
  }, childSelector);
  assert.ok(layout.width > 0 && layout.height > 0 && layout.children.length > 0, JSON.stringify(layout));
  assert.ok(
    !["auto", "scroll", "overlay"].includes(layout.overflowX),
    `surface must not scroll horizontally: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.scroll <= layout.client + 1 && layout.scrollLeft === 0,
    `content must fit locally: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.children.every(
      (child) =>
        child.left >= -1 && child.right <= layout.width + 1 && child.top >= -1 && child.bottom <= layout.height + 1,
    ),
    `visible children must remain inside the surface: ${JSON.stringify(layout)}`,
  );
  return layout;
}
