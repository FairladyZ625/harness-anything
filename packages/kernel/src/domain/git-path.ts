/** Exact metadata directory spelling, including the case folding Git applies on every platform. */
export function isGitDirectorySegment(segment: string): boolean {
  return segment.toLowerCase() === ".git";
}

// Git v2.51.0: read-cache.c verify_path_internal/verify_dotfile; path.c is_ntfs_dotgit;
// utf8.c next_hfs_char. Apply both supported filesystem protections regardless of the writer's OS.
const hfsIgnored = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;

/** Git-specific restrictions on already canonical portable document paths. Retirements are not writes. */
export function gitPathRejectionReason(value: string, symbolicLink = false): string | null {
  for (const segment of value.split("/")) {
    const hfsName = segment.replace(hfsIgnored, ""),
      ntfsName = segment.split(":", 1)[0]!.replace(/[ .]+$/u, "");
    if (isGitDirectorySegment(hfsName) || isGitDirectorySegment(ntfsName) || /^git~1$/iu.test(ntfsName))
      return `segment ${JSON.stringify(segment)} names Git metadata (.git or a filesystem alias)`;
    // Git permits regular .gitmodules files, but never symlinks under that name (including aliases).
    // path.c is_ntfs_dot_generic("gitmodules", "gi7eba") supplies the two short-name forms.
    if (
      symbolicLink &&
      (hfsName.toLowerCase() === ".gitmodules" ||
        (/^(?:\.gitmodules|gitmod~[1-4]|(?:g|gi|gi7|gi7e|gi7eb|gi7eba)~[1-9][0-9]*)$/iu.test(ntfsName) &&
          (ntfsName.startsWith(".") || ntfsName.length === 8)))
    )
      return `segment ${JSON.stringify(segment)} names .gitmodules in a symbolic-link path`;
  }
  return null;
}
