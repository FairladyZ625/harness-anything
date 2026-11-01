/** Browser-safe protocol constants and response types shared by Host and Client. */
export const BROKER_ROUTE = "/__harness_anything/broker";

export interface BrokerSuccess {
  readonly ok: true;
  readonly url: string;
  readonly summary?: string;
}

export interface BrokerFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly hint: string;
  };
}

export type BrokerResponse = BrokerSuccess | BrokerFailure;
