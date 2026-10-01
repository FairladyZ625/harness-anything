export const PROJECT_DIRECTORY_CHANNEL = "harness:projects:openDirectory";

export interface ProjectDirectoryApi {
  readonly openDirectory: (input: { readonly repoId: string }) => Promise<void>;
}
