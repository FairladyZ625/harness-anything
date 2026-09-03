import type { EntityActionContract, EntityActionInputField } from "../../kernel/src/index.ts";

export interface CliInputError {
  readonly code: string;
}
export type CommandAdmissionRoute = "direct" | "via-assignment" | "via-center-forward" | "rejected";
export type CommandAdmission = Readonly<
  Record<"local" | "remote-proxy" | "remote-center" | "remote-edge", CommandAdmissionRoute>
>;
export interface CommandTopology {
  readonly commandClass: "admin" | "repo-write" | "repo-read" | "arbiter";
  readonly admission: CommandAdmission;
}
export interface CliInputFacet {
  readonly name: string;
  readonly kind: "single" | "repeated" | "boolean";
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly error: CliInputError;
  readonly jsonFields?: readonly string[];
  readonly jsonAllowedFields?: readonly string[];
  readonly jsonEnums?: Readonly<Record<string, readonly string[]>>;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly lengthUnit?: "characters" | "bytes";
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly unique?: boolean;
  readonly requiredWhen?: { readonly field: string; readonly values: readonly string[] };
  readonly allowedWhen?: { readonly field: string; readonly values: readonly string[] };
  readonly requires?: readonly string[];
  readonly requiresAny?: readonly string[];
  readonly conflictsWith?: readonly string[];
}
export type RpcShape = {
  readonly fields: Readonly<
    Record<string, "string" | "number" | "boolean?" | "string?" | "json" | "json?" | "array" | "array?" | RpcShape>
  >;
  readonly open?: boolean;
};
export type GeneratedTaskActionInputField = Pick<EntityActionInputField, "field" | "type" | "enum" | "regex"> & {
  readonly required?: boolean;
  readonly cli?: Omit<NonNullable<EntityActionInputField["cli"]>, "jsonSchema" | "error"> & {
    readonly error?: string;
  };
};
export interface GeneratedTaskActionProtocolDeclaration {
  readonly id: string;
  readonly input: {
    readonly schema: "entity-action-input/v1";
    readonly fields: readonly GeneratedTaskActionInputField[];
    readonly exactlyOneOf: readonly (readonly string[])[];
  };
  readonly explain: string;
  readonly execution: Pick<NonNullable<EntityActionContract["execution"]>, "ingress" | "topology"> & {
    readonly lifecycle: Pick<
      NonNullable<NonNullable<EntityActionContract["execution"]>["lifecycle"]>,
      "transitionId" | "commandType" | "targetIdField" | "coordination"
    >;
  };
}
export interface GeneratedTaskActionProtocolProjection {
  readonly writeReceiptFields: readonly string[];
  readonly taskCreateResultFields: readonly string[];
  readonly actions: readonly GeneratedTaskActionProtocolDeclaration[];
}
