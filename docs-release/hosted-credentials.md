# Hosted Git credentials

Task branch publishing and pull request creation go through the daemon.
Workers read CI checks directly with their hosting-platform CLI and their own
platform credentials. The daemon credential is a GitHub or GitLab token the
machine's operator configures once per runtime instance. This page is the
operator setup; the worker-facing commands are described in
[Task branch publishing and direct-push protection](operations-server-daemon.md#task-branch-publishing-and-direct-push-protection).

## What the credential powers

Each command resolves the credential bound to the runtime instance that runs
the dispatch, and uses it only for that task:

| Command | What it does with the credential |
| --- | --- |
| `ha task push <task-id>` | Pushes the task branch over HTTPS git (`git push --force-with-lease`). |
| `ha task pr <task-id>` | Runs the repository PR body gate, then creates or updates the pull request through the GitHub CLI. |

The GitHub CLI (`gh`) and `git` must be on the daemon's `PATH`; a resident
service records the installing shell's `PATH` (see
[Resident service](operations-server-daemon.md#resident-service-macos-and-linux)).

## Bind the credential to a runtime instance

```bash
ha runtime instance hosting-credential set <instance-id> --provider github --ref credential:v1:<slug>
ha runtime instance hosting-credential unset <instance-id> --provider github
ha runtime instance hosting-credential set <instance-id> --provider gitlab --ref credential:v1:<slug>
ha runtime instance hosting-credential unset <instance-id> --provider gitlab
```

`--ref` takes an opaque reference into the machine's native credential store,
not the token itself. `credential:v1:<slug>` is the current grammar; the legacy
`keychain:<service>/<account>` form keeps resolving on macOS only.
`ha runtime instance show <instance-id>` projects only credential state —
receipts never echo the reference or the secret. A worker session cannot change this binding; it is an
operator-side setting, and a missing binding surfaces as
`runtime_credential_unavailable` (see
[Recovering from task and runtime rejections](operations-server-daemon.md#recovering-from-task-and-runtime-rejections)).

## Create the vault item

The reference resolves inside the same native vault the daemon uses for
provider API keys: service `com.harness-anything.runtime-instance`, account
`<slug>`. Create the item with your platform's tool, then bind the reference
from the previous section. Choose the token's permissions before storing it
(see the next section); replacing it means storing a new item and binding the
new reference.

macOS Keychain (`-w` without a value prompts for the secret twice, entry and
retype):

```bash
security add-generic-password -U -s com.harness-anything.runtime-instance -a <slug> -w
```

Linux Secret Service (headless setup for the daemon itself is covered in
[Provider API keys](provider-credentials.md#linux-without-a-desktop)):

```bash
printf '%s' "$github_token" | secret-tool store --label "harness github credential" service com.harness-anything.runtime-instance account <slug>
unset github_token
```

Windows Credential Manager: create a generic credential named
`com.harness-anything.runtime-instance/<slug>` whose secret is the token.

## What the token must be able to do

The daemon performs a fixed set of operations with the token. Grant it exactly
these permissions on the one repository the workspace publishes to:

| Operation | Used by | Fine-grained PAT permission |
| --- | --- | --- |
| Push the task branch over HTTPS | `ha task push` | Contents: Read and write |
| Create or update the pull request | `ha task pr` | Pull requests: Read and write |

A classic personal access token covers the same operations with the `repo`
scope. A token without push access fails at `ha task push`; a token without
pull request access fails at `ha task pr`. Rotating
the token means storing a new vault item and rebinding — the daemon removes a
retired vault item only when no other instance or credential setting still
references it.

## Current limits

GitHub and GitLab task delivery are supported. GitHub tokens need repository
contents write access for pushes; GitLab tokens need `write_repository` for
pushes. The daemon resolves the provider-specific reference and supplies the
token only to its own git/API operation. Workers wait for checks with
`ha task pr <task-id> --wait-ci`, which reads through the daemon-held
credential; inspecting a failure with `gh run view --log-failed` uses the
worker's own platform CLI session. Provider selection is inferred from
`origin`; declare `hosting.provider` and `hosting.host` in repository settings
for an unrecognized or self-hosted GitLab host. GitLab CI uses REST API v4 and
does not require `glab` for daemon-managed publishing (see [Provider credentials](provider-credentials.md#github-and-gitlab-task-delivery)).
