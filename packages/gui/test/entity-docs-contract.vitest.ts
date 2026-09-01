// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import {
  isAllowedRelationKindTriple,
  relationStates,
  relationTypes,
  type EntityRefKind,
  type RelationType,
} from "../../kernel/src/index.ts";
import decisionPackageSchema from "../../kernel/schemas/json/decision-package.schema.json";
import factEventSchema from "../../kernel/schemas/json/fact-event.schema.json";
import {
  checkEntityDocContract,
  explainEntityKind,
  projectedEntityKinds,
} from "../../../tools/generate-entity-doc-contract.mjs";
import {
  ENTITY_DOC_BY_KIND,
  ENTITY_DOC_GROUPS,
  FACT_TYPE_VOCABULARY,
  entityDocKinds,
} from "../src/renderer/entity-docs.ts";
import type { EntityFieldDoc } from "../src/renderer/entity-docs.ts";

/**
 * 实体说明面的内容契约:说明目录逐项对照 kernel 实况——字段名、必填位、
 * 状态词表、关系三元组、写入动作、ref 模板。说明内容可以策展(选核心字段),
 * 但不许编造:文档里出现的每个字段都必须真实存在于 kernel schema,枚举词表
 * 必须逐字一致,关系必须是方向注册表里的合法三元组且不漏不重。
 * 漂移在这里红,而不是在用户眼前过期。
 */

/**
 * kernel 登记的实体 kind,直接问生成器要——它枚举 kernel 自己的 kind 表。
 * 以前这里是一份手抄快照,并自认「新增 kind 不改这里不会红」;那个盲点已经删掉。
 */
const KERNEL_KINDS: readonly string[] = projectedEntityKinds();
/** 说明面额外收录的目录层实体(不是 kernel 生命周期 kind)。 */
const CATALOG_KINDS: readonly string[] = ["preset", "adapter"];

function fieldsOf(kind: string): readonly EntityFieldDoc[] {
  const doc = ENTITY_DOC_BY_KIND.get(kind);
  if (doc === undefined) throw new Error(`entity doc missing for ${kind}`);
  return doc.fields;
}

describe("entity docs cover the registered entity universe", () => {
  it("catalog kinds are exactly kernel kinds plus the two catalog planes", () => {
    expect([...entityDocKinds()].sort()).toEqual([...KERNEL_KINDS, ...CATALOG_KINDS].sort());
  });

  it("every group doc kind is unique and resolvable", () => {
    const listed = ENTITY_DOC_GROUPS.flatMap((group) => group.docs.map((doc) => doc.kind));
    expect(new Set(listed).size).toBe(listed.length);
    for (const kind of listed) expect(ENTITY_DOC_BY_KIND.get(kind)?.kind).toBe(kind);
  });
});

describe("per-kind contract against kernel explainEntityKind", () => {
  /**
   * 目录的机器半现在是从 kernel 生成并提交进仓库的,所以再断言「目录 == kernel」
   * 已经是同源恒等、零信息。真正有信息的是:**已提交的生成区块**与**当前 kernel**
   * 是否还一致——kernel 改了而没重跑生成器,这里红。
   */
  it("committed generated region is not stale against the live kernel", async () => {
    await expect(checkEntityDocContract()).resolves.toBeUndefined();
  });

  it.each(KERNEL_KINDS)("%s: has a doc entry carrying the kernel contract", (kind) => {
    const explanation = explainEntityKind(kind),
      doc = ENTITY_DOC_BY_KIND.get(kind);
    expect(doc, `entity doc missing for kernel kind ${kind}`).toBeDefined();
    expect(doc!.schemaId).toBe(explanation.documentSchema.id);
    expect(doc!.actions).toEqual(explanation.transitions.available);
  });

  it.each(KERNEL_KINDS)("%s: documented fields exist in the kernel schema with matching required flags", (kind) => {
    const kernelFields = new Map(
      explainEntityKind(kind).documentSchema.fields.map((field) => [field.name, field.required]),
    );
    for (const field of fieldsOf(kind)) {
      const required = kernelFields.get(field.name);
      expect(required, `${kind}.${field.name} is documented but absent from the kernel schema`).toBeDefined();
      expect(field.required, `${kind}.${field.name} required flag drifted`).toBe(required);
    }
  });
});

describe("nested payload fields against the JSON schemas", () => {
  it("fact payload fields match fact-event.schema.json", () => {
    const payload = factEventSchema.properties.payload as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    const nested = ENTITY_DOC_BY_KIND.get("fact")!.nestedFields.find((group) => group.container === "payload");
    expect(nested).toBeDefined();
    for (const field of nested!.fields) {
      expect(
        Object.hasOwn(payload.properties, field.name),
        `fact payload.${field.name} is documented but absent from the schema`,
      ).toBe(true);
      expect(field.required).toBe(payload.required?.includes(field.name) ?? false);
    }
  });

  it("decision proposal/accept payload fields match decision-package.schema.json", () => {
    const defs = decisionPackageSchema.$defs as Record<
      string,
      { required?: string[]; properties: Record<string, unknown> }
    >;
    const nested = ENTITY_DOC_BY_KIND.get("decision")!.nestedFields;
    const proposal = nested.find((group) => group.container.startsWith("payload(proposal"));
    const accept = nested.find((group) => group.container.startsWith("payload(accept"));
    expect(proposal).toBeDefined();
    expect(accept).toBeDefined();
    for (const field of proposal!.fields) {
      expect(Object.hasOwn(defs.proposal!.properties, field.name)).toBe(true);
      expect(field.required).toBe(defs.proposal!.required?.includes(field.name) ?? false);
    }
    for (const field of accept!.fields) {
      expect(Object.hasOwn(defs.accept!.properties, field.name)).toBe(true);
      expect(field.required).toBe(defs.accept!.required?.includes(field.name) ?? false);
    }
  });
});

describe("relation edges mirror the canonical direction registry", () => {
  // relation 现在自己就是登记过的 kernel kind(G3a 把它补成了真 aggregate),不再额外追加。
  const endpointKinds = KERNEL_KINDS;

  /** 全部合法三元组:方向注册表是唯一权威,这里用 kernel 谓词穷举重建。 */
  const allowedTriples: readonly { sourceKind: string; type: string; targetKind: string }[] = [];
  for (const source of endpointKinds)
    for (const type of relationTypes)
      for (const target of endpointKinds)
        if (isAllowedRelationKindTriple(source as EntityRefKind, type as RelationType, target as EntityRefKind))
          allowedTriples.push({ sourceKind: source, type, targetKind: target });

  const documentedTriples = (kind: string) =>
    new Set(
      (ENTITY_DOC_BY_KIND.get(kind)?.edges ?? []).map((edge) => `${edge.sourceKind}|${edge.type}|${edge.targetKind}`),
    );

  it("every documented edge is an allowed kernel triple", () => {
    for (const doc of ENTITY_DOC_BY_KIND.values())
      for (const edge of doc.edges) {
        const key = `${edge.sourceKind}|${edge.type}|${edge.targetKind}`;
        expect(
          allowedTriples.some((triple) => `${triple.sourceKind}|${triple.type}|${triple.targetKind}` === key),
          `${key} is documented but not an allowed kernel triple`,
        ).toBe(true);
      }
  });

  /**
   * 完整性只覆盖**实体之间的语义边**。G3a 把 relation 补成真 aggregate 之后,
   * 它自己也成了合法端点,于是「任何 kind --relates--> relation」把三元组从 22 涨到 47。
   * 把这 25 条摊到每个实体页上是纯噪音——「agent --relates--> relation」讲不出 agent 是什么。
   * 这条能力属于关系面本身,在 relation 页说明一次(见下一条断言),不在每页重复。
   */
  it("every allowed entity-to-entity triple is documented on both endpoint kinds", () => {
    const semanticTriples = allowedTriples.filter(
      (triple) => triple.sourceKind !== "relation" && triple.targetKind !== "relation",
    );
    expect(semanticTriples.length).toBeGreaterThan(0);
    for (const triple of semanticTriples) {
      for (const endpoint of [triple.sourceKind, triple.targetKind]) {
        const doc = ENTITY_DOC_BY_KIND.get(endpoint);
        if (doc === undefined) continue;
        expect(
          documentedTriples(endpoint).has(`${triple.sourceKind}|${triple.type}|${triple.targetKind}`),
          `${endpoint} doc is missing allowed triple ${triple.sourceKind} --${triple.type}--> ${triple.targetKind}`,
        ).toBe(true);
      }
    }
  });

  it("relation doc states that any registered kind may be related to an edge", () => {
    const relationEndpointTriples = allowedTriples.filter(
      (triple) => triple.sourceKind === "relation" || triple.targetKind === "relation",
    );
    expect(relationEndpointTriples.length).toBeGreaterThan(0);
    expect(ENTITY_DOC_BY_KIND.get("relation")!.definition).toMatch(/边本身也可以作为关系端点/u);
  });
});

describe("relation plane vocabulary", () => {
  it("type and state words are the kernel vocabularies verbatim", () => {
    const doc = ENTITY_DOC_BY_KIND.get("relation")!;
    const words = (field: string) => [...(doc.statuses.find((status) => status.field === field)?.words ?? [])].sort();
    expect(words("type")).toEqual([...relationTypes].sort());
    expect(words("state")).toEqual([...relationStates].sort());
  });
});

describe("fact type vocabulary area follows the controlled read surface", () => {
  it("stores only the ruling anchor and documents the list action", () => {
    expect(FACT_TYPE_VOCABULARY.decisionId).toBe("dec_2935057783CD5D56E9F287AE4D");
    expect(Object.keys(FACT_TYPE_VOCABULARY)).toEqual(["decisionId"]);
    expect(ENTITY_DOC_BY_KIND.get("fact")?.actions).toContain("type-list");
  });
});
