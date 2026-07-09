# Roadmap: Direction, Not Promises

This is a statement of *direction* and of *why* — not of *when* or of *how*. It
describes the themes we think are worth pursuing and the reasons they matter. It
does not commit to dates, mechanisms, or ordering, and the order below implies
no sequence. Any of it may change.

## Where things stand

The foundation is no longer just a flat three-primitive loop. The source CLI has
tasks, decisions, facts, task hierarchy, relation semantics, and a local daemon
path for single-machine multi-repo work. The exact release boundary changes as
evidence lands, so the status source of truth is
[Release Posture](../../release-posture.md). Everything below is direction; that
page is the authority for current labels.

## Directions worth pursuing

**Self-hosting the loop.** Turn the harness fully on itself, so that the system
manages its own development end to end. This matters because self-hosting is the
only honest proof of usefulness: if the tool cannot carry its own work, it has
no business carrying anyone else's. The next useful work is proving the shipped
and mechanism-complete command surfaces in ordinary workflows, not expanding the
kernel.

**A graphical, visual surface.** Lower the cost of getting started, and let
people who do not live on the command line still *see* the structure — the
decisions, the tasks, the hierarchy, and the relations laid out. This matters
because the command line is the real adoption bottleneck; a great deal of what
the system offers is invisible until you can look at it, and most people meet a
tool through its surface, not its internals. The release boundary is deliberately
conservative: a readable source GUI is not the same thing as a finished desktop
product.

**A local daemon that can grow without pretending to be remote-first.** Keep the
daemon useful for local write coordination and single-machine multi-repo work
before claiming team remote collaboration. This matters because the daemon is
where write ordering, projection, and GUI read paths meet; overclaiming the
transport shape would make the adoption story less trustworthy.

**Extending to new scenarios.** Bring domains beyond coding — research,
operations, and others — onto the same vertical model, without changing the
kernel. This matters because it is the test of the central bet: a kernel that
truly knows nothing about any domain should absorb a new one purely through a
vertical declaration. Each new scenario that fits is evidence the boundary is
real; the first one that does not is where we learn something.

## What we are deliberately not chasing

We are not widening the kernel to accommodate any of the above. The whole
premise is that new surfaces and new domains arrive in the layers *around* the
kernel — verticals, presets, tooling — while the primitives stay fixed. The
moment a direction seems to require a new primitive, that is a signal to
reexamine the direction, not the kernel.
