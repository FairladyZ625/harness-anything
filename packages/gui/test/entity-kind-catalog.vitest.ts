// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import {
  entityKindLabel,
  graphNodeKinds,
  importableKinds,
  kindRefPrefixes,
  type EntityKindCatalog,
  type EntityKindRow,
} from "../src/renderer/entity-kind-catalog-client.ts";
import { entityDocGroups, entityDocIndex } from "../src/renderer/entity-docs.ts";
import { resolveEntityDocFocus } from "../src/renderer/views/EntitiesView.tsx";
import { entityDetailTargetOf } from "../src/renderer/navigation/entityRoutes.ts";
import { parseEndpoint } from "../src/renderer/graph/endpoint.ts";
import { partitionGoverned } from "../src/renderer/graph/territory.ts";
import { importActionFields } from "../src/renderer/components/entityDoc/NewGovernedEntityForm.tsx";

/**
 * GUI 的实体种类集合只有一个来源:已注册 kind 读面。这里锁住那条派生链——
 * 说明面分组、领地分块、图筛选、路由、新建表单字段全部从同一份 catalog 长出来,
 * 并用**阴性对照**证明它确实来自声明:把 ADR 那条声明从 catalog 里拿掉,
 * 五个消费面同时不再出现这个 kind。
 */

const ADR_KIND = "software/coding/architecture-decision-record@1";

function adrRow(): EntityKindRow {
  return {
    kind: ADR_KIND,
    origin: "vertical",
    verticalId: "software/coding",
    refTemplate: `${ADR_KIND}/{id}`,
    relationEndpoint: true,
    importable: true,
    declaration: {
      id: "architecture-decision-record",
      version: 1,
      idPrefix: "ADR",
      display: { singular: "Architecture Decision Record", plural: "Architecture Decision Records" },
      descriptorSchemaRef: "schema://artifact-descriptor",
      pathTemplate: "entities/architecture-decision-records/{id}.json",
      locatorKinds: ["repository-path"],
      maturityVocabulary: [],
    },
    explanation: {
      kind: ADR_KIND,
      documentSchema: {
        id: `schema://artifact-descriptor#${ADR_KIND}`,
        fields: [
          { name: "entityId", type: "string", required: true, description: null },
          { name: "title", type: "string", required: true, description: null },
          { name: "locator", type: "object", required: true, description: null },
        ],
      },
      relations: { edges: [{ type: "relates", sourceKind: ADR_KIND, targetKind: "decision" }] },
      statusVocabulary: [],
      transitions: {
        available: ["import"],
        actions: [
          {
            id: "import",
            input: {
              schema: "entity-action-input/v1",
              fields: [
                { field: "entityKind", type: "string", required: true },
                { field: "locator", type: "string", required: true },
                { field: "expectedVersion", type: "number", required: true },
                { field: "title", type: "string", required: false },
                { field: "entityId", type: "string", required: false },
                { field: "sourceIdentity", type: "string", required: false },
                { field: "dryRun", type: "boolean", required: false },
              ],
            },
          },
        ],
      },
    },
  };
}

function taskRow(): EntityKindRow {
  return {
    kind: "task",
    origin: "builtin",
    verticalId: null,
    refTemplate: "task/{id}",
    relationEndpoint: true,
    importable: false,
    declaration: null,
    explanation: {
      kind: "task",
      documentSchema: { id: "task-frontmatter", fields: [] },
      relations: { edges: [] },
      statusVocabulary: [],
      transitions: { available: [], actions: [] },
    },
  };
}

const withAdr: EntityKindCatalog = { schema: "entity-kind-catalog/v1", kinds: [taskRow(), adrRow()] };
const withoutAdr: EntityKindCatalog = { schema: "entity-kind-catalog/v1", kinds: [taskRow()] };

describe("declared kinds reach every GUI consumer through the catalog", () => {
  it("adds a 声明实体 group to the entity docs page without touching curated content", () => {
    const groups = entityDocGroups(withAdr);
    const declared = groups.find((group) => group.id === "declared");
    expect(declared?.docs.map((doc) => doc.kind)).toEqual([ADR_KIND]);
    // 说明内容逐字来自声明与 explanation,不是这一页手写的。
    const doc = entityDocIndex(withAdr).get(ADR_KIND);
    expect(doc?.schemaId).toBe(`schema://artifact-descriptor#${ADR_KIND}`);
    expect(doc?.refTemplate).toBe(`${ADR_KIND}/{id}`);
    expect(doc?.fields.map((field) => field.name)).toEqual(["entityId", "title", "locator"]);
    expect(doc?.edges).toEqual([{ type: "relates", sourceKind: ADR_KIND, targetKind: "decision" }]);
    expect(doc?.actions).toEqual(["import"]);
    expect(doc?.storage).toContain("entities/architecture-decision-records/{id}.json");
  });

  it("offers the kind as a graph node type with its declared display name", () => {
    expect(graphNodeKinds(withAdr)).toContain(ADR_KIND);
    expect(entityKindLabel(adrRow())).toBe("Architecture Decision Record");
  });

  it("parses a multi-segment declared ref as an ordinary graph endpoint", () => {
    const ref = `${ADR_KIND}/ADR-0123456789abcdef`;
    expect(parseEndpoint(ref, graphNodeKinds(withAdr))).toEqual({ id: ref, entity: ADR_KIND });
    // 最长前缀优先:kind 本身含斜杠,按段数猜会切错。
    expect(kindRefPrefixes(withAdr)[0]?.kind).toBe(ADR_KIND);
  });

  it("gives the kind its own territory zone with the locator as the chip subtitle", () => {
    const zones = partitionGoverned(
      [
        {
          kind: ADR_KIND,
          entityId: "ADR-0123456789abcdef",
          ref: `${ADR_KIND}/ADR-0123456789abcdef`,
          title: "ADR-0020 · Decision 与 ADR 边界",
          locator: { kind: "repository-path", value: "harness/adr/ADR-0020.md" },
          revision: 7,
        },
      ],
      (kind) => (kind === ADR_KIND ? "Architecture Decision Record" : kind),
    );
    expect(zones).toHaveLength(1);
    expect(zones[0]?.title).toBe("Architecture Decision Record");
    expect(zones[0]?.entity).toBe(ADR_KIND);
    expect(zones[0]?.chips[0]?.sub).toBe("harness/adr/ADR-0020.md");
  });

  it("routes a declared entity ref to the entity docs surface", () => {
    const ref = `${ADR_KIND}/ADR-0123456789abcdef`;
    expect(entityDetailTargetOf(ref, graphNodeKinds(withAdr))).toEqual({
      view: "entities",
      focusedEntityRef: ref,
    });
    expect(resolveEntityDocFocus(ref, withAdr)).toEqual({ kind: ADR_KIND, entityRef: ref });
    expect(resolveEntityDocFocus(`entitydoc/${ADR_KIND}`, withAdr)).toEqual({ kind: ADR_KIND, entityRef: null });
  });

  it("derives the new-entity form fields from the import action contract", () => {
    // kind / expectedVersion / relink 三类字段不出现在表单里(见 NewGovernedEntityForm 注释)。
    expect(importActionFields(adrRow()).map(({ field }) => field)).toEqual(["locator", "title"]);
    expect(importableKinds(withAdr).map(({ kind }) => kind)).toEqual([ADR_KIND]);
  });
});

describe("negative control: removing the declaration removes the kind everywhere", () => {
  it("drops the kind from docs, graph, routing and the creatable set", () => {
    expect(entityDocGroups(withoutAdr).some((group) => group.id === "declared")).toBe(false);
    expect(entityDocIndex(withoutAdr).get(ADR_KIND)).toBeUndefined();
    expect(graphNodeKinds(withoutAdr)).not.toContain(ADR_KIND);
    expect(parseEndpoint(`${ADR_KIND}/ADR-0123456789abcdef`, graphNodeKinds(withoutAdr))).toBeNull();
    expect(entityDetailTargetOf(`${ADR_KIND}/ADR-0123456789abcdef`, graphNodeKinds(withoutAdr))).toBeNull();
    expect(resolveEntityDocFocus(`${ADR_KIND}/ADR-0123456789abcdef`, withoutAdr)).toBeNull();
    expect(importableKinds(withoutAdr)).toEqual([]);
  });

  it("keeps the builtin kinds untouched by the declaration going away", () => {
    expect(graphNodeKinds(withoutAdr)).toEqual(["task"]);
    expect(
      entityDocGroups(withoutAdr)
        .flatMap((group) => group.docs)
        .some((doc) => doc.kind === "task"),
    ).toBe(true);
  });
});
