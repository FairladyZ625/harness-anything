import { daemonProtocolCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export interface ThinCommand {
  readonly rootDir: SafePath;
  readonly repoId?: string;
  readonly json: boolean;
  readonly method: string;
  readonly action: Readonly<Record<string, unknown>> & {
    readonly kind: string;
  };
}

export type ThinParseResult =
  | { readonly ok: true; readonly command: ThinCommand }
  | {
      readonly ok: false;
      readonly code: string;
      readonly nextAction: string;
      readonly json: boolean;
    };

export interface ThinCliInput {
  readonly name: string;
  readonly kind: "single" | "repeated" | "boolean";
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly error: { readonly code: string; readonly nextAction: string };
}

export type ProtocolCommand = (typeof daemonProtocolCommands)[number];

export type ThinCliInputDirectory = ReadonlyMap<
  string,
  { readonly inputs: readonly ThinCliInput[]; readonly helpCommand: string }
>;
