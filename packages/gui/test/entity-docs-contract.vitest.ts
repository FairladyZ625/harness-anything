// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import {
  explainEntityKind,
  isAllowedRelationKindTriple,
  relationStates,
  relationTypes,
  type EntityRefKind,
  type RelationType,
} from "../../kernel/src/index.ts";
import decisionPackageSchema from "../../kernel/schemas/json/decision-package.schema.json";
import factEventSchema from "../../kernel/schemas/json/fact-event.schema.json";
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
 * kernel 登记的实体 kind 快照(镜像 entityKindRefAuthorities 的 kind 列;
 * kernel 未从公共桶导出该表,深路径 import 被 lint 禁止)。逐个跑
 * explainEntityKind 保证快照里的名字全部真实登记;kernel 未来新增 kind
 * 需要同步这里——这是本测试唯一靠人工同步的锚点,新增 kind 不改这里不会红。
 */
const KERNEL_KINDS: readonly string[] = [
  "task",
  "fact",
  "decision",
  "agent",
  "squad",
  "policy",
  "execution",
  "review",
  "runtime-session",
  "schedule",
  "settings",
  "person",
];
/** 说明面额外收录的两个目录层实体(不是 kernel 生命周期 kind)。 */
const CATALOG_KINDS: readonly string[] = ["relation", "preset", "adapter"];

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
  it.each(KERNEL_KINDS)("%s: schema id, ref template, statuses, actions match the kernel contract", (kind) => {
    const explanation = explainEntityKind(kind),
      doc = ENTITY_DOC_BY_KIND.get(kind);
    expect(doc, `entity doc missing for kernel kind ${kind}`).toBeDefined();
    expect(doc!.schemaId).toBe(explanation.documentSchema.id);
    expect(doc!.refTemplate).toBe(explanation.id.refTemplate);
    expect(doc!.statuses).toEqual(explanation.statusVocabulary);
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
  const endpointKinds = [...KERNEL_KINDS, "relation"] as const;

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

  it("every allowed triple touching a kind is documented on both endpoint kinds", () => {
    expect(allowedTriples.length).toBeGreaterThan(0);
    for (const triple of allowedTriples) {
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
});

describe("relation plane vocabulary", () => {
  it("type and state words are the kernel vocabularies verbatim", () => {
    const doc = ENTITY_DOC_BY_KIND.get("relation")!;
    expect(doc.statuses.find((status) => status.field === "type")?.words.sort()).toEqual([...relationTypes].sort());
    expect(doc.statuses.find((status) => status.field === "state")?.words.sort()).toEqual([...relationStates].sort());
  });
});

describe("fact type vocabulary area is an honest empty state", () => {
  it("registers no types while the registration backend is unmerged", () => {
    // 阴性对照:登记面未合入前词表必须为空——示例词冒充词表会在这里红。
    expect(FACT_TYPE_VOCABULARY.registeredTypes).toEqual([]);
  });

  it("cites the ruling decision and the in-flight backend task", () => {
    expect(FACT_TYPE_VOCABULARY.decisionId).toBe("dec_2935057783CD5D56E9F287AE4D");
    expect(FACT_TYPE_VOCABULARY.backendTaskId).toBe("task_bee3a7e874110347e48a102b67");
  });
});
