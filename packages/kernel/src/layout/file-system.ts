export interface LayoutDirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
}

export interface LayoutFileSystem {
  readonly exists: (inputPath: string) => boolean;
  readonly readText: (inputPath: string) => string;
  readonly readDirents: (inputPath: string) => ReadonlyArray<LayoutDirectoryEntry>;
}
