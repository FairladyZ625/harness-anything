// harness-test-tier: unit
import { describe, expect, it } from "vitest";
import {
  emptyAttributeDraft,
  entityAttributeFields,
  readAttributeDraft,
} from "../src/renderer/entity-attribute-form.ts";
import { soleContentFile } from "../src/renderer/entity-content-client.ts";

/**
 * 属性表单的判定面(E5)。这一层决定「填什么、怎么算填对了、递出去的是什么类型」,
 * 与渲染分开——判定分开才测得动,也才保证 GUI 里没有按 kind 名字写死的分支。
 */
describe("declared attributes become form fields", () => {
  it("takes every supported declaration in the order the author wrote it", () => {
    expect(
      entityAttributeFields({
        region: { type: "string", enum: ["north", "south"], required: true },
        fiscalYear: { type: "integer" },
        reviewed: { type: "boolean", required: true },
        weight: { type: "number" },
      }),
    ).toEqual([
      { name: "region", type: "string", options: ["north", "south"], required: true },
      { name: "fiscalYear", type: "integer", options: null, required: false },
      { name: "reviewed", type: "boolean", options: null, required: true },
      { name: "weight", type: "number", options: null, required: false },
    ]);
  });

  it("leaves out declarations no control can honestly generate", () => {
    // 猜一个控件出来,人填进去的值会在中心被拒——那比不摆更糟。
    expect(entityAttributeFields({ nested: { type: "object" }, loose: "string", empty: null })).toEqual([]);
    expect(entityAttributeFields(null)).toEqual([]);
    expect(entityAttributeFields([{ type: "string" }])).toEqual([]);
    expect(entityAttributeFields(undefined)).toEqual([]);
  });

  it("starts booleans at false and everything else unfilled", () => {
    const fields = entityAttributeFields({ reviewed: { type: "boolean" }, region: { type: "string" } });
    expect(emptyAttributeDraft(fields)).toEqual({ reviewed: "false", region: "" });
  });
});

describe("a draft becomes the values the center is given", () => {
  const fields = entityAttributeFields({
    region: { type: "string", enum: ["north", "south"], required: true },
    fiscalYear: { type: "integer", required: true },
    weight: { type: "number" },
    note: { type: "string" },
    reviewed: { type: "boolean" },
  });

  it("restores the declared types instead of shipping every value as a string", () => {
    const reading = readAttributeDraft(fields, {
      region: "north",
      fiscalYear: "2026",
      weight: "1.5",
      note: "  之后再说  ",
      reviewed: "true",
    });
    expect(reading.issues).toEqual({});
    expect(reading.values).toEqual({
      region: "north",
      fiscalYear: 2026,
      weight: 1.5,
      note: "之后再说",
      reviewed: true,
    });
    expect(typeof reading.values.fiscalYear).toBe("number");
  });

  it("omits an untouched optional attribute rather than inventing an empty value", () => {
    // 声明没给它默认值:替调用者写一个空串,就是在描述符里写下一个人没说过的事实。
    const reading = readAttributeDraft(fields, { region: "south", fiscalYear: "1", weight: "", note: "" });
    expect(Object.keys(reading.values).sort()).toEqual(["fiscalYear", "region", "reviewed"]);
    expect(reading.values.reviewed).toBe(false);
  });

  it("names the cell that is wrong and refuses to guess past it", () => {
    const reading = readAttributeDraft(fields, {
      region: "east",
      fiscalYear: "2026.5",
      weight: "很重",
      reviewed: "false",
    });
    expect(reading.issues).toEqual({
      region: "只能是:north、south。",
      fiscalYear: "必须是整数。",
      weight: "必须是数字。",
    });
    // 判定不通过的格子不进提交值。
    expect(Object.keys(reading.values)).toEqual(["reviewed"]);
  });

  it("calls an empty required attribute out by name", () => {
    expect(readAttributeDraft(fields, { region: "", fiscalYear: "" }).issues).toEqual({
      region: "必填。",
      fiscalYear: "必填。",
    });
  });
});

describe("opening an entity's own content", () => {
  it("opens a lone file and leaves a real choice to the reader", () => {
    expect(soleContentFile([{ path: "ADR-0001.md", directory: false, sizeBytes: 12 }])).toBe("ADR-0001.md");
    expect(
      soleContentFile([
        { path: "README.md", directory: false, sizeBytes: 12 },
        { path: "notes.md", directory: false, sizeBytes: 12 },
      ]),
    ).toBeNull();
    expect(
      soleContentFile([
        { path: "README.md", directory: false, sizeBytes: 12 },
        { path: "research", directory: true, sizeBytes: null },
      ]),
    ).toBeNull();
    expect(soleContentFile([])).toBeNull();
  });
});
