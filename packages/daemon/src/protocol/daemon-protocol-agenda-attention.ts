import type { AgendaAttentionKind, AgendaAttentionRegion } from "../agenda-attention.ts";

export interface AgendaAttentionItem {
  readonly ref: string;
  readonly title: string;
  readonly kind: AgendaAttentionKind;
  readonly region: AgendaAttentionRegion;
  readonly workTaskId: string | null;
  readonly attention: {
    readonly score: number;
    readonly reasons: readonly { readonly label: string; readonly contribution: number }[];
  };
}

export interface AgendaRegionWeights {
  readonly mine: number;
  readonly stuck: number;
  readonly run: number;
  readonly review: number;
  readonly queue: number;
  readonly recent: number;
  readonly works: number;
}
