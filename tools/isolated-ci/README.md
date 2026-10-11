# Remote isolated tests

The default dispatch target is the company server `cjsz-tencent-server`. All producers use
one dedicated `harness-test` SSH account and one server configuration, not per-worker quotas.
Local Docker and Ubuntu VM dispatch targets have been removed. The existing Windows route
is retained; it is not the default and does not provide the server's admission contract.

```sh
node tools/dispatch-isolated-test.mjs --file tools/dispatch-isolated-test.test.mjs
node tools/dispatch-isolated-test.mjs --tier integration
node tools/dispatch-isolated-test.mjs --file tools/run-node-tests.test.mjs --coverage /tmp/run.lcov
node tools/dispatch-isolated-test.mjs --target local --file tools/run-node-tests.test.mjs
```

Prefer targeted files before a worker commit. Complete PR tiers belong to GitHub CI;
server tier runs are explicit diagnostics. `--target local` uses the same Python FIFO
admission owner with capacity two and executes directly on the host; it is the supported
host path and does not start Docker or a VM. No automatic fallback or retry is provided.

## Server preparation (owner only)

Install Docker Engine with effective CPU/memory cgroup controllers, Python 3, Git and rsync;
a host Node installation is unnecessary. Give the dedicated account access to Docker and
`/srv/harness-tests`. Its UID must match the image's non-root runner (pass it as `RUNNER_UID` when building; default 1001); the bind mount
and container run as that account. Deploy `tools/isolated-test-server.json` as
`/srv/harness-tests/config.json` before enabling dispatch. Every producer reads that server
file for admission, image and per-container limits. The local copy supplies the SSH alias,
account and location. Keep those routing fields aligned when the owner changes them.

Build the image on the amd64 server before admitting tests:

```sh
docker build --platform linux/amd64 --build-arg RUNNER_UID="$(id -u)" -t harness-ci:node24 tools/isolated-ci
```

The owner must enforce the facility cgroup ceiling before building; the build command
does not itself impose runtime container flags. See [Docker builder resource options](https://docs.docker.com/build/builders/drivers/docker-container/)
when configuring an owner-managed bounded builder.

This build context contains only the image definition. It contains no product source,
private ledger or credentials. Do not build concurrently with admitted tests. The image
reuses the preceding isolated-CI work: Ubuntu 24.04, Node 24.21.0, Git 2.55.0 and snapshot
system packages, with Chromium's `libglib2.0-0t64` included. It includes Java/PostgreSQL/Xvfb,
but equivalence to GitHub CI and the image build remain subject to actual server acceptance.
The dependency installer runs in a preparation container against each source snapshot.
Docker creates a new named volume as root, so the preparation container starts as root
only long enough to create the cache directory and assign its root to the image's `runner`
account; it then runs the installer as `runner`, whose UID matches the dedicated server
account. The server queue mounts the named `dependencyCacheVolume` from `config.json`
read-write for preparation, then mounts it read-only for the test container. The key includes the
lockfile, workspace manifests, Node/npm runtime, platform and effective npm configuration.
The dependency cache helper publishes a staging generation with an atomic rename while
holding its SQLite writer lock; concurrent misses serialize and never expose a partial
generation. A generation contains workspace `node_modules`, Electron and Playwright Chromium
downloads and is limited to 2 GiB as a whole. Each admitted run copies dependencies and runtime
downloads into its private workspace before releasing the lock, so replacing the retained
generation cannot interrupt active tests. The named volume is owner-managed and may be
pruned only when no queue ticket is admitted.

Configuration grants three slots, each 4 CPU and 8 GiB with no extra swap: 12 CPU / 24 GiB
of container limits. The owner must constrain the complete test facility to the approved
12 CPU / 28 GiB and measure its overhead. Container limits alone do not prove the host's
aggregate engine/SSH overhead stays below that total. No gate budgets or CI limits change.

## Ownership and cancellation

The existing Python admission owner registers a kernel-locked ticket under the shared
`queue` directory. The oldest three tickets are admitted; the others wait FIFO. Admission
happens before source transfer. Each ticket owns one `runs/<runId>` directory, one container
with exactly that name, and one user root inside the mount. Logs and test exit codes stream
back; optional coverage returns before releasing admission.

The caller keeps the SSH control pipe open. EOF, signals or caller death stop only that
run. A separate pipe-owned reaper kills the owned process group, removes the named Docker
container, deletes its run directory, and finally removes its ticket. Container creation
waits until the reaper owns its process group, covering interruption during creation.
Cleanup errors reach stderr and fail the run; the ticket is retained. The next admission
owner can clean a stale unlocked ticket under the same mutex; it must succeed before
releasing it. There is no global container prune or interruption of another producer.

## Outbound source boundary

Only git-index public files with their current contents are transferred. Stage new tests
before dispatch. Private roots `harness/`, `.harness-private/`, and root agent instructions
are rejected at the sending boundary, including the two exported Git generations. External
or private symlink targets are rejected. The original checkout's Git directory, credentials,
HOME, installed dependencies and untracked task artifacts are never copied. A new shallow
Git identity retains HEAD and HEAD^ for existing consumers; history-dependent full CI gates
are not supported by this file/tier dispatcher. HEAD identifies the committed base, while
uncommitted tracked changes are present in the actual snapshot.
