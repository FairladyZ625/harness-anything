# Cold-start known issues

Each active marker is one `<operation-id>.json` file using `coldstart-known-issue/v1`.
Markers require a machine-checkable issue, an owner, an expiry, and a two-factor
fingerprint containing both the action identity/argv prefix and the expected
error code/hint. Delete the file when the operation passes; the runner rejects
expired, invalid, drifted, and stale fixed-candidate markers.
