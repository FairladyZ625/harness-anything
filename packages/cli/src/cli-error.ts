type CliThrownError =
  | { readonly _tag: "NativeError"; readonly message: string }
  | { readonly _tag: "UnknownThrownValue"; readonly message: string };

export function cliErrorMessage(error: unknown): string {
  let normalized: CliThrownError;
  if (error instanceof Error) normalized = { _tag: "NativeError", message: error.message };
  else normalized = { _tag: "UnknownThrownValue", message: String(error) };
  switch (normalized._tag) {
    case "NativeError":
    case "UnknownThrownValue":
      return normalized.message;
  }
}
