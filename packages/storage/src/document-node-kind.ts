/** Decode the two canonical Git modes at the storage representation boundary. */
export function documentNodeKind(mode: "100644" | "120000"): "file" | "symbolic-link" {
  return mode === "120000" ? "symbolic-link" : "file";
}
