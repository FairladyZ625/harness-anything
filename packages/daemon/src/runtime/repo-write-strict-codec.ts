export function makeRepoWriteStrictCodec(errorPrefix: string): {
  readonly record: (
    value: unknown,
    path: string
  ) => Record<string, unknown>;
  readonly exactKeys: (
    value: Record<string, unknown>,
    required: ReadonlyArray<string>,
    path: string,
    optional?: ReadonlyArray<string>
  ) => void;
  readonly text: (value: unknown, path: string) => string;
  readonly nonNegativeInteger: (value: unknown, path: string) => number;
  readonly invalid: (path: string) => never;
} {
  const invalid = (path: string): never => {
    throw new Error(`${errorPrefix}:${path}`);
  };
  const record = (
    value: unknown,
    path: string
  ): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalid(path);
    }
    return value as Record<string, unknown>;
  };
  const exactKeys = (
    value: Record<string, unknown>,
    required: ReadonlyArray<string>,
    path: string,
    optional: ReadonlyArray<string> = []
  ): void => {
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) {
      invalid(path);
    }
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      invalid(path);
    }
    return value as string;
  };
  const nonNegativeInteger = (value: unknown, path: string): number => {
    if (typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 0) {
      invalid(path);
    }
    return value as number;
  };
  return { record, exactKeys, text, nonNegativeInteger, invalid };
}
