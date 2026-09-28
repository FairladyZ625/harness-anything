# Shared helpers for the dist-rebuild hooks (post-checkout, post-commit,
# post-merge). Each hook sources this from its own directory after cd-ing to
# its repo root: git fires these hooks from the absolute core.hooksPath of the
# main checkout even inside linked worktrees, whose own tree may predate this
# file, so lib.sh must travel with the hook that uses it. $repo_root is
# already set by the sourcing hook.

# The rebuilt dist serves the local `ha` and the resident daemon, which run from
# the main checkout. A linked worktree has no node_modules of its own, so a build
# there compiles against the main checkout's packages and fails whenever the main
# checkout lags the worktree's branch, failing the git command that fired the hook
# (`git worktree add` included). Rebuild only in the main checkout.
if [ "$(git rev-parse --path-format=absolute --git-dir)" != "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "$(basename -- "$0"): linked worktree; skipping dist rebuild."
  exit 0
fi

hook_tsc="$repo_root/node_modules/.bin/tsc"

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
