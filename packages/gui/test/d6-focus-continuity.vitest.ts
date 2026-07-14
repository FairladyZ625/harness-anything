import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import { GenealogyTimelineView } from "../src/renderer/views/GenealogyTimelineView.tsx";
import {
  createFocusHistory,
  currentFocus,
  goBack,
  goForward,
  pushFocus,
  type FocusHistoryState,
} from "../src/renderer/graph/focusHistory.ts";
import { egoFocusIdOf } from "../src/renderer/graph/canvasEgoLayout.ts";

/**
 * D6 焦点连续性回归。
 *
 * 生产路径:
 *   openFocus / stepHistory / clearFocus → onFocusChange(id)
 *     → App.focusEntityInWorkspace → AppLocation.focusedEntityRef
 *     → EntityWorkspace 把 focusedEntityRef 当 GenealogyTimelineView.focusRef
 *
 * 历史导航若漏上行 onFocusChange,画布焦点已是 A 但 AppLocation 仍停在 B,
 * 切到演化史会开 B 的谱系(adversarial P1)。
 *
 * vitest 环境是 node(无 jsdom / react-test-renderer),不能真正挂 useEgoCanvas
 * 钩子;这里用「与 useEgoCanvas.stepHistory / openFocus / clearFocus 同构的
 * 纯状态机」+ GenealogyTimelineView 的 focusRef 消费,把契约钉死。
 */

function decision(id: string, title?: string): DecisionRow {
  return {
    decisionId: id,
    title: title ?? `D ${id}`,
    state: "active",
    question: "q",
    chosen: [],
    rejected: [],
    claims: [],
  } as DecisionRow;
}

/** 镜像 useEgoCanvas 焦点状态机(openFocus / stepHistory / clearFocus 的上行契约)。 */
class FocusContinuityHarness {
  focusId: string | null = null;
  history: FocusHistoryState = createFocusHistory();
  /** 模拟 AppLocation.focusedEntityRef —— 只由 onFocusChange 写入。 */
  appLocationFocusRef: string | null = null;

  private onFocusChange = (id: string | null) => {
    // App.focusEntityInWorkspace:裸 task id → task/<id>;decision/fact 原样。
    if (id === null) {
      this.appLocationFocusRef = null;
      return;
    }
    this.appLocationFocusRef = id.includes("/") ? id : `task/${id}`;
  };

  openFocus(id: string): void {
    const canonical = egoFocusIdOf(id);
    this.focusId = canonical;
    this.history = pushFocus(this.history, canonical);
    this.onFocusChange(canonical);
  }

  goBack(): void {
    const next = goBack(this.history);
    if (next === this.history) return;
    this.history = next;
    const f = currentFocus(next);
    this.focusId = f;
    this.onFocusChange(f);
  }

  goForward(): void {
    const next = goForward(this.history);
    if (next === this.history) return;
    this.history = next;
    const f = currentFocus(next);
    this.focusId = f;
    this.onFocusChange(f);
  }

  clearFocus(): void {
    this.focusId = null;
    // 历史不动(与 useEgoCanvas.clearFocus 一致),但 AppLocation 必须清空。
    this.onFocusChange(null);
  }
}

describe("D6 · focus continuity (spotlight history ↔ lineage subject)", () => {
  it("spotlight focus X → AppLocation 同步为 X(lineage 可直接消费)", () => {
    const h = new FocusContinuityHarness();
    h.openFocus("decision/dec_x");
    expect(h.focusId).toBe("decision/dec_x");
    expect(h.appLocationFocusRef).toBe("decision/dec_x");
  });

  it("history-back 后 AppLocation 跟随新焦点(修复前会停在 stale decision)", () => {
    const h = new FocusContinuityHarness();
    h.openFocus("decision/dec_a");
    h.openFocus("decision/dec_b");
    expect(h.appLocationFocusRef).toBe("decision/dec_b");

    h.goBack(); // canvas → A;AppLocation 必须也是 A
    expect(h.focusId).toBe("decision/dec_a");
    expect(h.appLocationFocusRef).toBe("decision/dec_a");

    h.goForward(); // canvas → B
    expect(h.focusId).toBe("decision/dec_b");
    expect(h.appLocationFocusRef).toBe("decision/dec_b");
  });

  it("clearFocus 清空 AppLocation(切 lineage 不应再开旧谱系)", () => {
    const h = new FocusContinuityHarness();
    h.openFocus("decision/dec_a");
    h.clearFocus();
    expect(h.focusId).toBeNull();
    expect(h.appLocationFocusRef).toBeNull();
  });

  it("lineage 消费 AppLocation focusRef:history-back 后谱系主体跟随", () => {
    const decisions = [
      decision("dec_a", "Decision A"),
      decision("dec_b", "Decision B"),
    ];
    // A refines B —— 两端皆 decision,谱系边成立。
    const relations: RelationEdge[] = [
      {
        from: "decision/dec_a",
        to: "decision/dec_b",
        kind: "refines",
        provenance: "local-document",
      } as RelationEdge,
    ];

    const h = new FocusContinuityHarness();
    h.openFocus("decision/dec_a");
    h.openFocus("decision/dec_b");
    // 模拟用户点 FocusHistoryBar Back → 焦点回到 A,AppLocation 同步。
    h.goBack();
    expect(h.appLocationFocusRef).toBe("decision/dec_a");

    // EntityWorkspace 在 lineage 面把 focusedEntityRef 原样交给 GenealogyTimelineView。
    const markup = renderToStaticMarkup(
      createElement(GenealogyTimelineView, {
        decisions,
        relations,
        focusRef: h.appLocationFocusRef,
      }),
    );
    // 主体是 A;不应渲染成 B 为焦点的谱系。
    expect(markup).toContain("Decision A");
    // 空态(无 focusRef)文案不应出现。
    expect(markup).not.toMatch(/选择一个决策|Pick a decision|no focus/i);
  });

  it("阴性对照:history-back 若漏上行 → AppLocation 停在 stale B(复现 P1)", () => {
    // 这是修复前 useEgoCanvas.stepHistory 的行为:只 setFocusId,不上行 onFocusChange。
    let appLocation: string | null = null;
    let focusId: string | null = null;
    let history = createFocusHistory();

    const openFocusBroken = (id: string) => {
      const canonical = egoFocusIdOf(id);
      focusId = canonical;
      history = pushFocus(history, canonical);
      appLocation = canonical.includes("/") ? canonical : `task/${canonical}`;
    };
    const goBackBroken = () => {
      const next = goBack(history);
      if (next === history) return;
      history = next;
      focusId = currentFocus(next);
      // 故意不上行 appLocation —— 复现 bug。
    };

    openFocusBroken("decision/dec_a");
    openFocusBroken("decision/dec_b");
    goBackBroken();
    expect(focusId).toBe("decision/dec_a"); // 画布已是 A
    expect(appLocation).toBe("decision/dec_b"); // AppLocation 仍 stale B

    // EntityWorkspace 读 AppLocation → GenealogyTimelineView 拿到 B 而非 A。
    // (有谱系边时 B 会渲染为主体;此处只钉契约:focusRef 错位。)
    const decisions = [decision("dec_a", "Decision A"), decision("dec_b", "Decision B")];
    const relations: RelationEdge[] = [
      {
        from: "decision/dec_a",
        to: "decision/dec_b",
        kind: "refines",
        provenance: "local-document",
      } as RelationEdge,
    ];
    const markup = renderToStaticMarkup(
      createElement(GenealogyTimelineView, {
        decisions,
        relations,
        focusRef: appLocation, // 用 stale AppLocation
      }),
    );
    // stale focusRef=B → 谱系主体是 B,不是用户刚 back 到的 A。
    expect(markup).toContain("Decision B");
    // 若正确同步,focusRef 应是 A;这里刻意证明错误路径。
    expect(appLocation).not.toBe(focusId);
  });
});
