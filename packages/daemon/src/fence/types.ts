import type { AuthorityFenceWitness } from "@harness-anything/application";

export interface AuthorityFenceEndpoint {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface SingleHostAuthorityFenceOptions {
  readonly enrollmentPath: string;
  readonly endpoint: AuthorityFenceEndpoint;
  readonly instanceId: string;
}

export interface AuthorityFenceLease extends AuthorityFenceWitness {
  readonly instanceId: string;
  readonly release: () => Promise<void>;
}

export class AuthorityFenceUnavailableError extends Error {
  readonly code = "AUTHORITY_FENCE_UNAVAILABLE";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AuthorityFenceUnavailableError";
  }
}

export class AuthorityFenceLostError extends Error {
  readonly code = "AUTHORITY_FENCE_LOST";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AuthorityFenceLostError";
  }
}
