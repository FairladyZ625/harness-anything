import type { EntityDeclarationEventV1 } from "../domain/entity-event.ts";

export interface EntityDeclarationState {
  readonly declaration: EntityDeclarationEventV1 | null;
  readonly retirement: { readonly retiredAt: string; readonly reason: string; readonly successor?: string } | null;
}
export interface EntityDeclarationReadQuery {
  readonly kind: string;
  readonly id?: string;
  readonly limit?: number;
}
