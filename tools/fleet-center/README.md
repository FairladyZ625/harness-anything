# Fleet center user-space deployment

`centerctl.sh` is the W5-R production-cutover rehearsal deployment for
`tencent-lighthouse-prod`. It installs the pinned Node 24 tarball under the
login user's home, clones/builds Harness Anything, attaches an inner-ledger
clone as `remote-center`, generates private TLS/roster material, and starts the
daemon-owned TLS center. It never uses sudo, Docker, system GitLab/nginx
configuration, or the host's default Harness daemon.

First start (the token is consumed from stdin and is not saved):

```bash
TOKEN_FILE=/path/to/gitlab-token
ssh tencent-lighthouse-prod \
  'HARNESS_CENTER_APP_REF=<public-commit> \
   HARNESS_CENTER_LEDGER_URL=http://127.0.0.1:8929/harness-center/rehearsal-20260823.git \
   HARNESS_CENTER_GIT_TOKEN_STDIN=1 \
   ~/harness-center/bin/centerctl.sh up' <"$TOKEN_FILE"
```

Subsequent lifecycle operations do not need the GitLab token:

```bash
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh status'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh down'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh up'
```

`down` only stops this deployment's isolated daemon. It intentionally retains
the repository, TLS material, roster, replica state, and the temporary
bootstrap ledger for audit/recovery. After a host reboot, log in and run `up`;
the daemon and Fleet listener are both process-owned and must be re-established.

The first `up` uses a temporary bootstrap ledger because the cloned production
ledger's local Unix-socket credential is bound to its original machine. The
script registers the wrapper root while the server bootstrap identity is valid,
switches the registration to `remote-center`, stops the daemon, preserves that
bootstrap ledger at `~/harness-center/bootstrap-harness`, and only then clones
the real inner ledger. It does not edit the cloned `people.yaml` or admit local
writes to the remote center.

If outbound GitHub access is unreliable, preseed `~/harness-center/app` with a
clean Git checkout containing `HARNESS_CENTER_APP_REF`. `up` only fetches when
that pinned ref is absent, so an audited Git bundle or rsync transfer works
without changing the deployment contract.
