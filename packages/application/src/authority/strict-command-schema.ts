export class StrictCommandDecodeError extends Error {
  constructor(path: string, expected: string) {
    super(`REPO_WRITE_COMMAND_ACTION_INVALID:${path}:${expected}`);
    this.name = "StrictCommandDecodeError";
  }
}

export interface StrictSchema<Value> {
  readonly decode: (value: unknown, path: string) => Value;
}

export type StrictSchemaValue<Schema> =
  Schema extends StrictSchema<infer Value> ? Value : never;

type StrictShape = Readonly<Record<string, StrictSchema<unknown>>>;

type StrictObject<
  Required extends StrictShape,
  Optional extends StrictShape
> = Readonly<{
  [Key in keyof Required]: StrictSchemaValue<Required[Key]>;
} & {
  [Key in keyof Optional]?: StrictSchemaValue<Optional[Key]>;
}>;

export function strictObject<
  const Required extends StrictShape,
  const Optional extends StrictShape = Record<never, never>
>(
  required: Required,
  optional = {} as Optional
): StrictSchema<StrictObject<Required, Optional>> {
  return {
    decode: (value, path) => {
      const input = strictRecord(value, path);
      const requiredKeys = Object.keys(required);
      const optionalKeys = Object.keys(optional);
      const allowed = new Set([...requiredKeys, ...optionalKeys]);
      const unknownKey = Object.keys(input).find((key) => !allowed.has(key));
      if (unknownKey) strictInvalid(`${path}.${unknownKey}`, "no unknown fields");
      const missingKey = requiredKeys.find((key) => !Object.hasOwn(input, key));
      if (missingKey) strictInvalid(`${path}.${missingKey}`, "required field");
      const output: Record<string, unknown> = {};
      for (const key of requiredKeys) {
        output[key] = required[key]!.decode(input[key], `${path}.${key}`);
      }
      for (const key of optionalKeys) {
        if (Object.hasOwn(input, key)) {
          output[key] = optional[key]!.decode(input[key], `${path}.${key}`);
        }
      }
      return output as StrictObject<Required, Optional>;
    }
  };
}

export function strictLiteral<const Value extends string | number | boolean>(
  expected: Value
): StrictSchema<Value> {
  return {
    decode: (value, path) => {
      if (value !== expected) strictInvalid(path, String(expected));
      return expected;
    }
  };
}

export function strictEnum<const Values extends ReadonlyArray<string>>(
  ...allowed: Values
): StrictSchema<Values[number]> {
  return {
    decode: (value, path) => {
      if (typeof value !== "string" || !allowed.includes(value)) {
        strictInvalid(path, allowed.join(", "));
      }
      return value as Values[number];
    }
  };
}

export const strictString: StrictSchema<string> = {
  decode: (value, path) => {
    if (typeof value !== "string") strictInvalid(path, "string");
    return value;
  }
};

export const strictBoolean: StrictSchema<boolean> = {
  decode: (value, path) => {
    if (typeof value !== "boolean") strictInvalid(path, "boolean");
    return value;
  }
};

export const strictNumber: StrictSchema<number> = {
  decode: (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      strictInvalid(path, "finite number");
    }
    return value;
  }
};

export function strictArray<Value>(
  item: StrictSchema<Value>
): StrictSchema<ReadonlyArray<Value>> {
  return {
    decode: (value, path) => {
      if (!Array.isArray(value)) strictInvalid(path, "array");
      return value.map((entry, index) => item.decode(entry, `${path}[${index}]`));
    }
  };
}

export function strictNullable<Value>(
  schema: StrictSchema<Value>
): StrictSchema<Value | null> {
  return {
    decode: (value, path) => value === null ? null : schema.decode(value, path)
  };
}

export function strictUnion<const Schemas extends ReadonlyArray<StrictSchema<unknown>>>(
  ...schemas: Schemas
): StrictSchema<StrictSchemaValue<Schemas[number]>> {
  return {
    decode: (value, path) => {
      for (const schema of schemas) {
        try {
          return schema.decode(value, path) as StrictSchemaValue<Schemas[number]>;
        } catch (error) {
          if (!(error instanceof StrictCommandDecodeError)) throw error;
        }
      }
      strictInvalid(path, "one supported object shape");
    }
  };
}

export function strictStringRecord(): StrictSchema<Readonly<Record<string, string>>> {
  return {
    decode: (value, path) => {
      const input = strictRecord(value, path);
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [
        key,
        strictString.decode(entry, `${path}.${key}`)
      ]));
    }
  };
}

export function strictRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    strictInvalid(path, "plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    strictInvalid(path, "plain object");
  }
  return value as Record<string, unknown>;
}

export function strictInvalid(path: string, expected: string): never {
  throw new StrictCommandDecodeError(path, expected);
}
