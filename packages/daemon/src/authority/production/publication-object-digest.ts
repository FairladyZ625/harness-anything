import { createHash } from "node:crypto";
import { readPublicationGitObject } from "./publication-object-reader.ts";

export async function publicationGitBlobDigest(
  rootDir: string,
  revision: string,
  changedPath: string,
  options: NonNullable<Parameters<typeof readPublicationGitObject>[2]>
): Promise<string | null> {
  try {
    const bytes = await readPublicationGitObject(rootDir, `${revision}:${changedPath}`, options);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}
