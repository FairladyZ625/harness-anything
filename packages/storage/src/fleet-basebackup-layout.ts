/**
 * The member namespace inside a `fleet-basebackup/v2` archive.
 *
 * A base backup is not a repository copy: the center serializes its ledger and projection into a
 * transport archive that any edge expands under a generation directory the edge owns. Those
 * directories carry no `harness.yaml`, so they have no `layout.localRoot` to derive from — and
 * resolving a layout there would walk up into whatever repository happens to contain the view.
 *
 * The member names are therefore part of the wire format, fixed at `fleet-basebackup/v2`. Changing
 * them would make an upgraded center's archives unreadable to an edge that still speaks v2 (and the
 * reverse), so a different namespace requires a new archive schema, not an edit here. This constant
 * is the one place that namespace is written: the producer, the installer's member filter and the
 * staged-path checks all read it, so they cannot drift apart.
 */
export const BASE_BACKUP_ARCHIVE_ROOT = ".harness";
