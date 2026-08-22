// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCensusSummary } from "../src/renderer/components/shell-chrome.tsx";

describe("daemon-backed task census", () => {
  it("renders the supplied aggregate verbatim instead of recounting renderer rows", () => {
    const markup = renderToStaticMarkup(createElement(TaskCensusSummary, { summary: {
      total: 91,
      byStatus: { planned: 3, active: 48, blocked: 12, in_review: 8, done: 18, cancelled: 2, unknown: 0 },
      includingArchived: { total: 91, byStatus: { planned: 3, active: 48, blocked: 12, in_review: 8, done: 18, cancelled: 2, unknown: 0 } }
    } }));
    expect(markup).toContain("共 91 个任务");
    expect(markup).toContain("进行中 48");
    expect(markup).toContain("已阻塞 12");
    expect(markup).toContain("封存中(Finalizing) 8");
  });
});
