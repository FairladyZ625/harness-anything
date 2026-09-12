# Shared helpers for the dist-rebuild hooks (post-checkout, post-commit,
# post-merge). Each hook sources this from its own directory after cd-ing to
# its repo root: git fires these hooks from the absolute core.hooksPath of the
# main checkout even inside linked worktrees, whose own tree may predate this
# file, so lib.sh must travel with the hook that uses it. $repo_root is
# already set by the sourcing hook.

# Resolve tsc from the main checkout, not the current one: linked worktrees
# share the repository but not node_modules, so the relative
# node_modules/.bin/tsc died with "No such file or directory" in any worktree
# without its own install. The git common dir anchors the main checkout, whose
# node_modules npm install keeps populated; inside the main checkout itself
# this resolves to the same absolute path as the old relative one.
main_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
hook_tsc="$main_root/node_modules/.bin/tsc"

# Trigger paths for one workspace package's build program: the package roots
# tsc compiles (tsconfig include + every followed import) plus the npm-level
# build inputs, so adding an upstream source dependency extends the trigger
# list with the code instead of a second hand-maintained copy that drifts
# stale. Same derivation for every rebuilt package; no per-package lists.
package_trigger_paths() {
  package_dir=$1
  trigger_roots=$("$hook_tsc" -p "$package_dir/tsconfig.build.json" --listFilesOnly \
    | awk -v root="$repo_root" \
      'index($0, root "/packages/") == 1 { sub(root "/", ""); split($0, seg, "/"); print seg[1] "/" seg[2] }' \
    | sort -u)
  trigger_paths="package-lock.json package.json $package_dir/package.json"
  trigger_paths="$trigger_paths $package_dir/tsconfig.build.json"
  trigger_paths="$trigger_paths $package_dir/scripts/copy-assets.mjs packages/preset/assets"
  for trigger_root in $trigger_roots; do
    trigger_paths="$trigger_paths $trigger_root $trigger_root/package.json"
  done
  printf '%s\n' "$trigger_paths"
}
