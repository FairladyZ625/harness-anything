// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  entityKindLabel,
  eventTypeLabel,
  relationKindLabel,
  workspaceNodeLabel,
  workspaceNodeText,
  workspaceTitleIndex,
  WORKSPACE_TITLE_LIMIT,
} from "../src/renderer/model/workspace-readable.ts";
import type { DecisionRow, FactRef } from "../src/renderer/model/types.ts";

const fact = (anchor: string, text: string): FactRef => ({
  anchor,
  category: "finding",
  text,
  at: "2026-09-20T12:00:00.000Z",
  confidence: "high",
});

describe("workspace readable vocabulary", () => {
  it("speaks canonical event types in both locales and never guesses an unknown one", () => {
    setActiveLocale("zh-CN");
    expect(eventTypeLabel("execution_submitted")).toBe("已提交评审");
    expect(eventTypeLabel("review_recorded")).toBe("评审已记录");
    expect(eventTypeLabel("task_completed")).toBe("任务完成");
    expect(eventTypeLabel("fact_recorded")).toBe("记录了一条事实");
    setActiveLocale("en-US");
    expect(eventTypeLabel("execution_submitted")).toBe("Submitted for review");
    expect(eventTypeLabel("code_doc_reconciled")).toBe("Code and docs reconciled");
    // 词表外的 type 如实回原名:不补造语义,也不吞掉它。
    expect(eventTypeLabel("vertical_thing_happened")).toBe("vertical_thing_happened");
    setActiveLocale("zh-CN");
    expect(eventTypeLabel("vertical_thing_happened")).toBe("vertical_thing_happened");
  });

  it("speaks relation kinds and entity kinds, and falls back to the raw token", () => {
    setActiveLocale("zh-CN");
    expect(relationKindLabel("produces")).toBe("产出");
    expect(relationKindLabel("executes")).toBe("执行");
    expect(relationKindLabel("depends-on")).toBe("依赖");
    expect(relationKindLabel("not-a-kind")).toBe("not-a-kind");
    expect(entityKindLabel("task")).toBe("任务");
    expect(entityKindLabel("runtime-session")).toBe("会话");
    expect(entityKindLabel("entity-kind")).toBe("entity-kind");
    setActiveLocale("en-US");
    expect(relationKindLabel("produces")).toBe("produces");
    expect(entityKindLabel("fact")).toBe("Fact");
    setActiveLocale("zh-CN");
  });

  it("indexes titles from the rows the view already has, clipping long ones", () => {
    const longStatement =
        "GUI 写面 allowlist 与 api-client-invoke 的闭合 facet 表不含任务创建 ingress:task 相关只有 start/progress.append/submit",
      index = workspaceTitleIndex({
        tasks: [
          { taskId: "task_a", title: "解耦 GUI 对 Daemon 的路径穿透" },
          { taskId: "task_blank", title: "" },
        ],
        facts: [fact("fact/F-7E08BD10", longStatement), fact("fact/F-EMPTY", "")],
        decisions: [{ decisionId: "dec_a", title: "并行入口统一" } as DecisionRow],
      });
    expect(index.get("task/task_a")).toBe("解耦 GUI 对 Daemon 的路径穿透");
    expect(index.get("decision/dec_a")).toBe("并行入口统一");
    expect(index.get("fact/F-7E08BD10")).toHaveLength(WORKSPACE_TITLE_LIMIT);
    expect(index.get("fact/F-7E08BD10")?.endsWith("…")).toBe(true);
    // 空标题不入表,免得用空串冒充「有标题」。
    expect(index.has("task/task_blank")).toBe(false);
    expect(index.has("fact/F-EMPTY")).toBe(false);
  });

  it("labels graph nodes as kind plus title, and keeps the raw ref when no title exists", () => {
    setActiveLocale("zh-CN");
    const index = workspaceTitleIndex({
        tasks: [{ taskId: "task_a", title: "解耦 GUI 对 Daemon 的路径穿透" }],
        facts: [fact("fact/F-7E08BD10", "工作空间三列会被长串压穿")],
        decisions: [],
      }),
      titled = workspaceNodeLabel("task/task_a", index),
      factNode = workspaceNodeLabel("fact/F-7E08BD10", index),
      untitled = workspaceNodeLabel("runtime-session/runtime_638084160c01818623df8f5a", index);
    expect(titled.kindLabel).toBe("任务");
    expect(workspaceNodeText(titled)).toBe("解耦 GUI 对 Daemon 的路径穿透");
    expect(titled.ref).toBe("task/task_a");
    expect(workspaceNodeText(factNode)).toBe("工作空间三列会被长串压穿");
    // 执行面实体在现有读面里没有标题:如实显示类型 + 原始 id,不补造。
    expect(untitled.kindLabel).toBe("会话");
    expect(untitled.title).toBeNull();
    expect(workspaceNodeText(untitled)).toBe("runtime_638084160c01818623df8f5a");
  });
});
