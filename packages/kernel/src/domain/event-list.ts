export interface EventListQuery {
  readonly type?: string;
  readonly entity?: string;
  readonly actor?: string;
  readonly actorPersonId?: string;
  readonly nodeId?: string;
  readonly after?: string;
  readonly before?: string;
  readonly limit: number;
  /** Exclusive lower revision bound for bounded window scans. */
  readonly afterRevision?: number;
  /** Exclusive upper revision bound decoded from --cursor; absent means "newest page". */
  readonly revisionBound?: number;
  /** Revision scan order within (afterRevision, revisionBound); defaults to "desc". */
  readonly order?: "asc" | "desc";
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
