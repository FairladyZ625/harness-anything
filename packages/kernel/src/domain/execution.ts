export const executionStates = ["active", "submitted", "accepted", "changes_requested", "abandoned"] as const;
export type ExecutionState = (typeof executionStates)[number];

export interface ExecutionActor {
  readonly principal: {
    readonly personId: string;
    readonly displayName?: string;
    readonly primaryEmail?: string;
    readonly providerId?: string;
    readonly credential?: { readonly kind: string; readonly issuer: string; readonly subject: string };
  };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly responsibleHuman: string;
}

export interface ExecutionCaptureRange {
  readonly range_id: string;
  readonly coordinate: "timestamp";
  readonly start_at: string;
  readonly end_at: string | null;
  readonly bounds: "inclusive";
}

export interface ExecutionSessionBindingRecord {
  readonly binding_id: string;
  readonly session_ref: string | null;
  readonly role: "primary" | "subagent" | "reviewer_observer";
  readonly archive_status: "pending" | "complete" | "partial" | "unavailable";
  readonly attached_at: string;
  readonly session: {
    readonly runtime: string;
    readonly sessionId: string;
    readonly source: string;
    readonly detectedAt: string;
    readonly user?: string;
  } | null;
  readonly capture_range: ExecutionCaptureRange | null;
}

export interface CheckerReceipt {
  readonly checker_id: string;
  readonly checker_version: string;
  readonly target_evidence_id: string;
  readonly target_sha256: string | null;
  readonly checked_at: string;
  readonly result: "pass" | "fail";
}

export type OutputEvidenceLocator =
  | { readonly substrate: "inline"; readonly text: string }
  | { readonly substrate: "file"; readonly path: string }
  | { readonly substrate: "url"; readonly url: string }
  | { readonly substrate: "object"; readonly ref: string; readonly sha256: string; readonly size: number; readonly media_type: string }
  | { readonly substrate: "entity"; readonly entity_ref: string }
  | { readonly substrate: "checker_receipt"; readonly receipt: CheckerReceipt };

export interface OutputEvidence {
  readonly evidence_id: string;
  readonly execution_ref: string;
  readonly locator: OutputEvidenceLocator;
  readonly sha256?: string;
  readonly checker_receipt_ref?: string;
}

export interface SubmissionPacket {
  readonly completion_claim: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly evidence_refs: ReadonlyArray<string>;
  readonly verification_notes: ReadonlyArray<string>;
  readonly known_gaps: ReadonlyArray<string>;
  readonly residual_risks: ReadonlyArray<string>;
}

export interface ExecutionRecord {
  readonly schema: "execution/v2";
  readonly execution_id: string;
  readonly task_ref: string;
  readonly state: ExecutionState;
  readonly primary_actor: ExecutionActor;
  readonly claimed_at: string;
  readonly submitted_at: string | null;
  readonly closed_at: string | null;
  readonly session_bindings: ReadonlyArray<ExecutionSessionBindingRecord>;
  readonly outputs: ReadonlyArray<OutputEvidence>;
  readonly submission: SubmissionPacket | null;
}
