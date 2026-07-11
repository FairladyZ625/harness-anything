import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { PublishableProjection } from "../schemas/registry.ts";

export type PublishProjectionRejectionCode =
  | "redaction_failed"
  | "closeout_not_ready"
  | "duplicate_publish";

export interface PublishableLink {
  readonly label: string;
  readonly href: string;
  readonly kind: "artifact" | "commit" | "review";
}

export interface PublishReadinessEvidence {
  readonly closeoutReadiness: "passed" | "ready" | "missing" | "incomplete" | "failed";
  readonly reviewGate: "passed" | "missing" | "failed";
  readonly ciGate: "passed" | "missing" | "failed";
  readonly evidenceLinks: ReadonlyArray<PublishableLink>;
}

export interface PublishProjectionInput {
  readonly sourceTaskId: string;
  readonly title: string;
  readonly summary: string;
  readonly links: ReadonlyArray<PublishableLink>;
  readonly readiness: PublishReadinessEvidence;
}

export interface PublishProjectionRejection {
  readonly ok: false;
  readonly code: PublishProjectionRejectionCode;
  readonly findings: ReadonlyArray<PublishRedactionFinding>;
}

export interface PublishProjectionSuccess {
  readonly ok: true;
  readonly projection: PublishableProjection;
}

export type PublishProjectionResult = PublishProjectionSuccess | PublishProjectionRejection;

export interface PublishIdempotencyLedger {
  readonly has: (key: string) => boolean;
  readonly record: (key: string) => void;
}

export interface PublishRedactionFinding {
  readonly ruleId: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly path?: string;
}

export const privateTextScannerVersion = "publish-redaction/v1";

const privateTextPatterns: ReadonlyArray<{
  readonly ruleId: string;
  readonly pattern: RegExp;
  readonly message: string;
}> = [
  {
    ruleId: "private-harness-path",
    pattern: /\.harness-private/u,
    message: "Private harness paths are not publishable."
  },
  {
    ruleId: "absolute-local-path",
    pattern: /(?:^|[\s(["'=])\/(?:Users|Volumes|tmp|var|private|home|root|opt|etc)(?:\/|$)[^\s)"']*/u,
    message: "Absolute local filesystem paths are not publishable."
  },
  {
    ruleId: "file-uri-local-path",
    pattern: /\bfile:\/\/\/[^\s)"']+/u,
    message: "Local file URIs are not publishable."
  },
  {
    ruleId: "windows-local-path",
    pattern: /(?:^|[\s(["'=])[A-Za-z]:\\[^\s)"']+/u,
    message: "Windows local filesystem paths are not publishable."
  },
  {
    ruleId: "private-evidence-marker",
    pattern: /\bPRIVATE:/u,
    message: "Private evidence markers must not leave the private harness."
  },
  {
    ruleId: "secret-token-marker",
    pattern: /\b(?:token|secret|password|api[_-]?key|access[_-]?token|auth(?:orization)?)\s*[:=]/iu,
    message: "Secret-like key/value text is not publishable."
  },
  {
    ruleId: "bearer-token-marker",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{6,}/u,
    message: "Bearer tokens are not publishable."
  },
  {
    ruleId: "private-key-marker",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    message: "Private key material is not publishable."
  },
  {
    ruleId: "env-secret-marker",
    pattern: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=/u,
    message: "Secret-like environment variables are not publishable."
  }
];

export function buildPublishableProjection(input: PublishProjectionInput): PublishProjectionResult {
  const findings = scanPublishInput(input);
  if (findings.some((finding) => finding.severity === "error")) {
    return {
      ok: false,
      code: "redaction_failed",
      findings
    };
  }

  if (!readinessPassed(input.readiness)) {
    return {
      ok: false,
      code: "closeout_not_ready",
      findings: [
        {
          ruleId: "publish-readiness",
          severity: "error",
          message: "Publishable output requires passed closeout, review, and CI gates."
        }
      ]
    };
  }

  const links = [...input.links, ...input.readiness.evidenceLinks].sort(compareLinks);
  const readiness = {
    closeoutReadiness: "passed" as const,
    reviewGate: "passed" as const,
    ciGate: "passed" as const,
    evidenceLinks: [...input.readiness.evidenceLinks].sort(compareLinks)
  };
  const idempotencyPayload = {
    sourceTaskId: input.sourceTaskId,
    title: input.title,
    summary: input.summary,
    links,
    readiness
  };

  return {
    ok: true,
    projection: {
      visibility: "public-safe",
      sourceTaskId: input.sourceTaskId,
      title: input.title,
      summary: input.summary,
      links,
      readiness,
      redactionReport: {
        scannerVersion: privateTextScannerVersion,
        findings,
        passed: true
      },
      idempotencyKey: `sha256:${stablePayloadHash(idempotencyPayload)}`
    }
  };
}

export function createInMemoryPublishIdempotencyLedger(): PublishIdempotencyLedger {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    record: (key) => {
      keys.add(key);
    }
  };
}

export function reservePublishIdempotencyKey(
  projection: PublishableProjection,
  ledger: PublishIdempotencyLedger
): PublishProjectionResult {
  if (ledger.has(projection.idempotencyKey)) {
    return {
      ok: false,
      code: "duplicate_publish",
      findings: [
        {
          ruleId: "publish-idempotency",
          severity: "error",
          message: "Publishable projection idempotency key has already been reserved."
        }
      ]
    };
  }

  ledger.record(projection.idempotencyKey);
  return {
    ok: true,
    projection
  };
}

function readinessPassed(readiness: PublishReadinessEvidence): boolean {
  return readiness.closeoutReadiness === "passed"
    && readiness.reviewGate === "passed"
    && readiness.ciGate === "passed"
    && readiness.evidenceLinks.length > 0;
}

function scanPublishInput(input: PublishProjectionInput): ReadonlyArray<PublishRedactionFinding> {
  const findings: PublishRedactionFinding[] = [];
  scanText(input.sourceTaskId, "sourceTaskId", findings);
  scanText(input.title, "title", findings);
  scanText(input.summary, "summary", findings);
  scanLinks(input.links, "links", findings);
  scanLinks(input.readiness.evidenceLinks, "readiness.evidenceLinks", findings);
  return findings;
}

export function scanPrivateText(text: string, path: string): ReadonlyArray<PublishRedactionFinding> {
  const findings: PublishRedactionFinding[] = [];
  scanText(text, path, findings);
  return findings;
}

function scanLinks(
  links: ReadonlyArray<PublishableLink>,
  prefix: string,
  findings: PublishRedactionFinding[]
): void {
  links.forEach((link, index) => {
    scanText(link.label, `${prefix}.${index}.label`, findings);
    scanText(link.href, `${prefix}.${index}.href`, findings);
  });
}

function scanText(text: string, path: string, findings: PublishRedactionFinding[]): void {
  for (const rule of privateTextPatterns) {
    if (!rule.pattern.test(text)) continue;
    findings.push({
      ruleId: rule.ruleId,
      severity: "error",
      message: rule.message,
      path
    });
  }
}

function compareLinks(a: PublishableLink, b: PublishableLink): number {
  return `${a.kind}\0${a.href}\0${a.label}`.localeCompare(`${b.kind}\0${b.href}\0${b.label}`);
}
