import { copyFileSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * The one implementation of "give a checkout the root store's dependencies without sharing its workspace links"
 * (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3). npm workspaces hoist every package's dependencies to the repository root
 * store, so a fresh checkout shares that store entry by entry instead of installing.
 *
 * Linking the whole store would also share its workspace links, and every workspace import would resolve to the
 * canonical checkout's source (F-81A23176). Worse, the shared directory is then writable through the link: a
 * `ln -sfn` or an install inside the checkout rewrites the canonical links in place, and deleting the checkout
 * leaves the canonical root resolving into a path that no longer exists (the 2026-10-27 incident).
 *
 * npm writes workspace links relative (`@scope/pkg -> ../../packages/pkg`), so a relative link copied verbatim
 * resolves inside the new checkout's own `packages`. Only links that leave the repository stay absolute, and they
 * point at the shared store entry — which is the hoisting this mirror exists to reuse.
 *
 * Scope directories and `.bin` hold links of their own, so they are mirrored rather than linked.
 */
export function mirrorNodeModules(rootDir: string, checkoutDir: string): void {
  mirrorStore(rootDir, checkoutDir, "node_modules");
}

function mirrorStore(rootDir: string, checkoutDir: string, relative: string): void {
  mkdirSync(path.join(checkoutDir, relative));
  for (const entry of readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name),
      source = path.join(rootDir, name);
    if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) {
      mirrorStore(rootDir, checkoutDir, name);
      continue;
    }
    const link = entry.isSymbolicLink() ? readlinkSync(source) : null,
      inRepository =
        link !== null &&
        !path.isAbsolute(link) &&
        !path.relative(rootDir, path.resolve(path.dirname(source), link)).startsWith(".."),
      type = statSync(source, { throwIfNoEntry: false })?.isDirectory() ? "junction" : "file";
    if (type === "file" && process.platform === "win32") {
      // Ordinary Windows users cannot create file symlinks. The package store is immutable
      // for the checkout lifetime, so a byte copy is the usable equivalent for .bin entries.
      copyFileSync(inRepository ? path.resolve(path.dirname(source), link!) : source, path.join(checkoutDir, name));
    } else symlinkSync(inRepository ? link! : source, path.join(checkoutDir, name), type);
  }
}
