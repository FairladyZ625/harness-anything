// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DenseRow } from "../src/renderer/components/primitives/DenseRow";
import { TitleText, splitTitleFocus } from "../src/renderer/components/primitives/TitleText.tsx";

// 标题只写一个重点:第一个全角/半角冒号前是重点,其后是弱色补充;冒号前不足 4 个字符
// 视作没有重点,整条按原文渲染。总览、工作列表、工作详情都经 TitleText,不在各页各写一套。
describe("splitTitleFocus", () => {
  it("splits at the first fullwidth or halfwidth colon, whichever comes first", () => {
    expect(splitTitleFocus("S5 补回工作详情页的关系图标签:S5 删掉了关系图,业主要保留")).toEqual({
      focus: "S5 补回工作详情页的关系图标签",
      supplement: ":S5 删掉了关系图,业主要保留",
    });
    expect(splitTitleFocus("ha doc sync 接受带 @revision 的锚:直到 submit 才拒绝")).toEqual({
      focus: "ha doc sync 接受带 @revision 的锚",
      supplement: ":直到 submit 才拒绝",
    });
    expect(splitTitleFocus("ratio 1:2 stays one title:second colon ignored")).toEqual({
      focus: "ratio 1",
      supplement: ":2 stays one title:second colon ignored",
    });
  });

  it("keeps the title whole without a colon or with a focus under four characters", () => {
    expect(splitTitleFocus("把总览重做成注意力加权的自适应区")).toEqual({
      focus: "把总览重做成注意力加权的自适应区",
      supplement: null,
    });
    expect(splitTitleFocus("修:一个很短的重点不该被拆成两段,补充再长也整条渲染")).toEqual({
      focus: "修:一个很短的重点不该被拆成两段,补充再长也整条渲染",
      supplement: null,
    });
  });
});

const mounted: Root[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function render(node: ReturnType<typeof createElement>): void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(node);
  });
}

describe("TitleText rendering", () => {
  it("keeps the focus in the row color and dims only the supplement", () => {
    render(createElement(TitleText, { title: "任务标题只写一个重点:背景与原因放到任务包里" }));
    // The focus is a bare text node in the row's own color; the only span is the dimmed supplement.
    const [supplement] = [...document.body.getElementsByTagName("span")];
    expect(supplement?.className).toContain("text-text-faint");
    expect(supplement?.textContent).toBe(":背景与原因放到任务包里");
    expect(document.body.textContent).toBe("任务标题只写一个重点:背景与原因放到任务包里");
  });

  it("renders a colonless title with no faint span", () => {
    render(createElement(TitleText, { title: "总览重做" }));
    expect(document.body.getElementsByTagName("span")).toHaveLength(0);
    expect(document.body.textContent).toBe("总览重做");
  });

  it("splits DenseRow string titles but renders node titles verbatim", () => {
    render(createElement(DenseRow, { title: "工作列表行的长标题:补充说明放弱色" }));
    expect(document.body.querySelector(".text-text-faint")?.textContent).toBe(":补充说明放弱色");

    render(
      createElement(DenseRow, {
        title: createElement("mark", undefined, "搜索高亮的长标题:补充说明"),
      }),
    );
    // The node title keeps its own structure; no TitleText faint span is injected for it.
    const rows = [...document.body.querySelectorAll(".truncate.text-text")];
    expect(rows.at(-1)?.querySelector(".text-text-faint")).toBeNull();
    expect(rows.at(-1)?.textContent).toContain("搜索高亮的长标题:补充说明");
  });
});
