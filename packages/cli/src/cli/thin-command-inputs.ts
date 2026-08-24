import { nonEmpty } from "./thin-command-flags.ts";
import type {
  ProtocolCommand,
  ThinCliInput,
  ThinCliInputDirectory,
} from "./thin-command-types.ts";

export function deriveThinCliInputs(command: {
  readonly id: string;
  readonly inputs?: readonly unknown[];
  readonly flags?: readonly unknown[];
}): readonly ThinCliInput[] {
  if (!Array.isArray(command.inputs))
    throw new Error(`${command.id} inputs must be an array`);
  const names = new Set<string>();
  for (const value of command.inputs) {
    if (!isInput(value) || names.has(value.name))
      throw new Error(`${command.id} has an invalid input facet`);
    names.add(value.name);
    if (
      value.enum !== undefined &&
      (!Array.isArray(value.enum) ||
        value.enum.length === 0 ||
        value.enum.some((entry) => !nonEmpty(entry)))
    )
      throw new Error(`${command.id}:${value.name} enum is invalid`);
    if (value.regex !== undefined)
      try {
        void new RegExp(value.regex, "u");
      } catch {
        throw new Error(`${command.id}:${value.name} regex is invalid`);
      }
  }
  if (
    !Array.isArray(command.flags) ||
    JSON.stringify(command.flags) !== JSON.stringify(command.inputs)
  )
    throw new Error(`${command.id} inputs and flags differ`);
  return Object.freeze(command.inputs as readonly ThinCliInput[]);
}

export function isInput(value: unknown): value is ThinCliInput {
  if (value === null || typeof value !== "object") return false;
  const input = value as Partial<ThinCliInput>;
  return (
    typeof input.name === "string" &&
    input.name.startsWith("--") &&
    ["single", "repeated", "boolean"].includes(input.kind ?? "") &&
    Object.hasOwn(input, "required") &&
    typeof input.required === "boolean" &&
    input.error !== undefined &&
    typeof input.error.code === "string" &&
    nonEmpty(input.error.nextAction)
  );
}

export function deriveInputDirectory(
  command: ProtocolCommand | undefined,
): ThinCliInputDirectory {
  return command
    ? new Map([
        [
          command.id,
          {
            inputs: deriveThinCliInputs(command),
            helpCommand: `ha ${command.path.join(" ")} --help`,
          },
        ],
      ])
    : new Map();
}
