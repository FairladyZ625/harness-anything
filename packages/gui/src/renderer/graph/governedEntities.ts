/**
 * 声明实体在图上的节点行(task_0df76ed3fb Goal 2)。
 *
 * 内建 kind 各自有专门的读面与行类型;vertical 声明出来的 Artifact 只有描述符
 * (标题 + locator 指针),行形状因此是同一个——kind 不同不改变它的形状,所以
 * 图里不需要为每个声明 kind 新写节点组件。
 */
export interface GovernedEntityRow {
  readonly kind: string;
  readonly entityId: string;
  /** canonical ref,与关系图端点同形:`<kind>/<entityId>`。 */
  readonly ref: string;
  readonly title: string | null;
  readonly locator: { readonly kind: string; readonly value: string } | null;
  readonly revision: number;
}

/** 没有标题就显示 entityId——不编造一个好看的名字。 */
export function governedEntityLabel(row: GovernedEntityRow): string {
  return row.title ?? row.entityId;
}

/** 副标题:locator 指针本身。它是这个实体唯一的「正文在哪」。 */
export function governedEntitySub(row: GovernedEntityRow): string | undefined {
  return row.locator?.value;
}
