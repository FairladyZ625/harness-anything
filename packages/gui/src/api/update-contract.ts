export const UPDATE_CHECK_CHANNEL = "harness:update-check";
export const UPDATE_INSTALL_CHANNEL = "harness:update-install";
export const UPDATE_STATUS_CHANNEL = "harness:update-status";
export const UPDATE_STATUS_EVENT = "harness:update-status-event";

export type UpdateState =
  | { readonly state: "idle" | "checking" | "not-available"; readonly version?: string }
  | { readonly state: "available" | "downloaded"; readonly version: string }
  | { readonly state: "error"; readonly message: string };

export interface UpdateApi {
  check: () => Promise<UpdateState>;
  install: () => Promise<void>;
  status: () => Promise<UpdateState>;
  onStatus: (listener: (status: UpdateState) => void) => () => void;
}
