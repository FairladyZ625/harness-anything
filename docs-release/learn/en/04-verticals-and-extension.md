# The Extension Model: Verticals, Checkers, Milestones, Dossiers

The [three-primitive kernel](01-three-primitive-kernel.md) knows nothing about
your domain. It has decisions, tasks, facts, and the relations between them —
and that is deliberately all. Everything that makes the system useful for
*coding*, or *research*, or *operations*, lives one layer up, in a **vertical**.
This page explains how that layer works, and how you would build your own.

## The kernel stays domain-free; verticals carry the business

A vertical is a **scenario contract**. The `software/coding` vertical, for
instance, declares the entity kinds a coding project cares about, the document
scaffolds they materialize into, the checker rules that guard them, and the
whitelist of relation types that are allowed to connect them. A vertical is a
declarative artifact — a `vertical.json` plus its schema — not compiled code.
The engine is a declaration parser: you describe the shape of your domain, and
it materializes the entities, wires the relations, and enforces the rules.

The payoff of this boundary is blunt: you can add a hundred domain concepts and
the kernel does not change by a single line. A milestone is a coding idea; a
research project might have *phases* instead. The kernel never learns either
word.

## Convention over declaration

The naive way to extend a system is to make you declare everything. That path
ends in a configuration swamp: every new entity repeats the same boilerplate.
The opposite extreme — infer everything, declare nothing — ends in a magic
maze where the system guesses wrong and you cannot tell why.

The stable point is a two-layer split, decided field by field with one
question: **can the engine infer this from files that already exist?**

- **Yes → convention.** Directory structure, file existence, naming slots,
  schema validity, whether the two ends of a relation actually fit — the engine
  scans for these and fails closed if the structure is illegal. You write
  nothing.
- **No → minimal declaration.** Some things are pure intent that no filesystem
  can reveal: whether an entity is *load-bearing* (does violating it turn a gate
  red?), which checker profile applies, version compatibility ranges, how to
  degrade when a locale is missing. These you must declare — but only these, and
  only in a few lines.

Structure is detected; intent is declared. That is the whole rule.

## Three kinds of entity, generalized three ways

Verticals do not extend every entity the same way. There are three shapes:

- **Lifecycle entities** (task, decision) get the full treatment: an entity
  kind, a document-package scaffold, a state-machine binding, a load-bearing
  flag, and a checker profile. These materialize into complete document
  packages whose front-matter is authoritative.
- **Schema entities** (fact) get *only* a field schema — a coding finding
  declares `severity`/`evidence`, a research observation declares
  `source`/`confidence`. A fact deliberately gets **no** document template: it is
  an observation recorded in passing while doing a task, so the vertical
  constrains its fields, not its shape.
- **Composite entities** (milestone) get **no new storage at all**. A milestone
  is not a new folder — it is one boundary decision plus N acceptance decisions
  plus a grouping of tasks plus the relations that organize them. Its structure
  is detected; its composition semantics are declared.

## Checkers, milestones, and dossiers

A **checker** is a set of load-bearing invariant rules a vertical declares. You
invoke a profile of them (`ha check --profile ...`), and they run
[fail-closed](03-gates-and-fail-closed.md): if a load-bearing invariant is
violated, the write is refused rather than waved through.

A **milestone**, as above, is a composite — an assembly of existing primitives,
not a fourth primitive. It needs no new store because relations already let you
group and organize the entities you have.

A **dossier** is what a milestone produces when it closes: a record of *what was
built*. At a milestone's exit, a checker the vertical installed fails closed
unless the dossier exists, which is what forces it into being. The dossier
(a forward record of construction) coexists with the panorama (a backward
narrative retrospective); the two triangulate the same milestone from opposite
directions.

## Building your own

Because the engine is a parser and the split keeps declaration small, a user
can author a new vertical entirely from outside the codebase: write JSON against
the vertical and preset contracts, and the engine materializes it. The
convention layer makes it *safe* — get the structure wrong and it will not
"stack," so you get an error instead of silent corruption — while the intent
layer keeps the burden to a handful of lines. That a stranger can stand up a
minimal working vertical without touching kernel code is not a side effect. It
is the point.
