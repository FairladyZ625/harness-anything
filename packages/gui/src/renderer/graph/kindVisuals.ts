/**
 * 图节点的按 kind 视觉。**一张表**——聚光灯节点、领地 zone、图例与卡片尺寸都读这里,
 * 不再各留一份 `Record<Entity, …>`(原来有四份,其中图例那份已经和另外三份不一致)。
 *
 * 内建五类保留既有取值(改动不改观感);未登记的 kind——比如 vertical 声明出来的
 * Artifact——走中性默认,**照常渲染**,不因为不认识就把节点丢掉。
 */
export interface EntityKindVisual {
  readonly axisVar: string;
  /** chip 徽标上的单字。 */
  readonly letter: string;
  readonly cardW: number;
  readonly cardWFocus: number;
  readonly minHFocus: number;
  readonly minHPeriph: number;
}

const BUILTIN: Readonly<Record<string, EntityKindVisual>> = {
  task: {
    axisVar: "var(--color-axis-execution)",
    letter: "T",
    cardW: 320,
    cardWFocus: 360,
    minHFocus: 300,
    minHPeriph: 220,
  },
  decision: {
    axisVar: "var(--color-axis-authority)",
    letter: "D",
    cardW: 340,
    cardWFocus: 380,
    minHFocus: 340,
    minHPeriph: 260,
  },
  fact: {
    axisVar: "var(--color-axis-evidence)",
    letter: "F",
    cardW: 300,
    cardWFocus: 340,
    minHFocus: 320,
    minHPeriph: 240,
  },
  agent: {
    axisVar: "var(--color-axis-assoc)",
    letter: "A",
    cardW: 300,
    cardWFocus: 340,
    minHFocus: 300,
    minHPeriph: 230,
  },
  schedule: {
    axisVar: "var(--color-axis-assoc)",
    letter: "S",
    cardW: 320,
    cardWFocus: 360,
    minHFocus: 300,
    minHPeriph: 230,
  },
};

/** `software/coding/architecture-decision-record@1` → `A`;取末段首字母,不猜声明里的 idPrefix。 */
function declaredLetter(kind: string): string {
  const tail = kind.split("/").at(-1) ?? kind;
  return (tail.charAt(0) || "?").toUpperCase();
}

export function entityKindVisual(kind: string): EntityKindVisual {
  return (
    BUILTIN[kind] ?? {
      axisVar: "var(--color-axis-assoc)",
      letter: declaredLetter(kind),
      cardW: 320,
      cardWFocus: 360,
      minHFocus: 280,
      minHPeriph: 220,
    }
  );
}

export function entityKindAxisVar(kind: string): string {
  return entityKindVisual(kind).axisVar;
}
