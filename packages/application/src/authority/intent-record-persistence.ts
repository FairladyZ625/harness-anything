import type { AuthorityGenerationFence, DaemonGenerationWriteRejectionV1 } from "./types.ts";
import { isDaemonGenerationFenced } from "./generation-fence-enforcement.ts";

type GenerationIntentRejection = Error & {
  readonly code: "DAEMON_GENERATION_FENCED";
  readonly context: DaemonGenerationWriteRejectionV1;
};

export async function persistAuthorityIntentWhileGenerationCurrent(input: {
  readonly generationFence?: AuthorityGenerationFence;
  readonly identity: { readonly workspaceId: string; readonly opId: string };
  readonly persist: () => Promise<void>;
}): Promise<GenerationIntentRejection | undefined> {
  try {
    if (!input.generationFence) {
      await input.persist();
      return undefined;
    }
    await input.generationFence.runExclusive("before-prepare", input.identity, async () => {
      await input.generationFence!.assertHeld("before-prepare", input.identity);
      await input.persist();
    });
    return undefined;
  } catch (error) {
    if (!isDaemonGenerationFenced(error)) throw error;
    return error;
  }
}
