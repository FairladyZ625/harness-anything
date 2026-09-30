/**
 * 图节点的按 kind 视觉。**一张表**——聚光灯节点、领地 zone、图例都读这里,
 * 不再各留一份 `Record<Entity, …>`(原来有四份,其中图例那份已经和另外三份不一致)。
 *
 * 内建五类保留既有取值(改动不改观感);未登记的 kind——比如 vertical 声明出来的
 * Artifact——走中性默认,**照常渲染**,不因为不认识就把节点丢掉。
 *
 * §5.2 后 ego 节点只有紧凑 chip 一种形态(尺寸常量在 egoCanvas.ts),本表只保留
 * 轴色与单字徽标;卡片尺寸字段随节点放大路径一起删除。
 */
export interface EntityKindVisual {
  readonly axisVar: string;
  /** chip 徽标上的单字。 */
  readonly letter: string;
}

const BUILTIN: Readonly<Record<string, EntityKindVisual>> = {
  task: { axisVar: "var(--color-axis-execution)", letter: "T" },
  decision: { axisVar: "var(--color-axis-authority)", letter: "D" },
  fact: { axisVar: "var(--color-axis-evidence)", letter: "F" },
  agent: { axisVar: "var(--color-axis-assoc)", letter: "A" },
  schedule: { axisVar: "var(--color-axis-assoc)", letter: "S" },
};

/** `entity-kind/KND-1f5c…` → `K`;取末段首字母,不猜声明里的 idPrefix。 */
function declaredLetter(kind: string): string {
  const tail = kind.split("/").at(-1) ?? kind;
  return (tail.charAt(0) || "?").toUpperCase();
}

export function entityKindVisual(kind: string): EntityKindVisual {
  return BUILTIN[kind] ?? { axisVar: "var(--color-axis-assoc)", letter: declaredLetter(kind) };
}

export function entityKindAxisVar(kind: string): string {
  return entityKindVisual(kind).axisVar;
}
