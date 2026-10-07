export interface EventListQuery {
  readonly type?: string;
  readonly entity?: string;
  readonly actor?: string;
  readonly after?: string;
  readonly before?: string;
  readonly limit: number;
  /** Exclusive upper revision bound decoded from --cursor; absent means "newest page". */
  readonly revisionBound?: number;
}

export interface EventListRow {
  readonly revision: number;
  readonly opId: string;
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly actor: { readonly personId: string; readonly executorId: string | null };
  readonly entityRefs: readonly string[];
}

export interface EventListPage {
  readonly rows: readonly EventListRow[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
