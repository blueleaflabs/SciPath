# Program templates

Every file here is a list of **steps**. That is the only building block.

A step has an id, a name, a `phase`, and an `order`. Everything else is
optional.

| Field | Means |
|---|---|
| `due` | An absolute date, an offset from an anchor, or a month window. Absent means nobody has said. |
| `requires` | Steps that should come first. **Soft**: it orders the display and warns the template author, and never stops a student. |
| `owner` | student, sponsor, staff, or program. |
| `deliverables` | What is handed over. May be empty; an event is a step with nothing due. |
| `consequence` | What happens if it is late. The only thing separating research from compliance. |
| `applies_when` | Facts about the project that make it apply at all. |
| `repeats` | For a step that happens more than once. |
| `risk` | What usually goes wrong, and what to do about it. |
| `internal` | A club's own deadline rather than the institution's. |

A **phase** is a named bucket of steps with an optional window.

**A phase window is an instruction, not an estimate.** "Empathy, September to
October" is a teacher saying this is when the class does this. It carries the
same authority as a deadline and is not derived from anything.

## Deliverables and shapes

A **deliverable** is the unit of completion, and it lives in
`src/config/deliverables/` so several programs can reference one by id. That
is how a single research plan satisfies IRPD's October step and SCVSEFA's
November one.

| Field | Means |
|---|---|
| `requirement` | `required`, `optional`, or `conditional`. Optional means its absence is not a fault. |
| `constraints` | Words, pages, dimensions — with `counting`, because "six pages" means different things at different fairs. |
| `guidance` | The sentence a club officer knows and a first-year student does not. |
| `shape` | Which document shape it takes. |
| `before_work` | For a form that must be signed and dated before experimentation. |
| `signed_by`, `per` | Who signs, and whether one is needed per project or per person. |

A **shape** is what a document looks like: its parts, in order, with a prompt
for each. In `src/config/shapes/`, because a quad chart is required by several
fairs and defining it four times produces four slightly different quad charts.

## What this software does and does not do

**We do not hold the artifact.** A deliverable is a link to wherever the
student keeps it. Links rot when somebody graduates and empties their Drive,
and that is accepted: work meant to outlast a student is work they push
through to publication, where it is copied into the record store.

**We check nothing, and we say everything.** The limit appears loudly at the
moment somebody is working on it, because most fairs refuse an abstract over
the limit and nobody reads the rules page twice.

**We are not a layout engine.** A shape names the parts and prompts each one.
The student writes it in Docs or Canva or on a board.

## What is deliberately absent

**Effort estimates and everything built on them.** No start dates, no float,
no critical path. An industry has spent decades on this and projects are
still routinely late; the version that fits here — software inventing a
schedule and measuring a student against it — is worse than useless.

**Enforcement of ordering.** The validator warns an author when a step is
dated before something it requires; it never stops a student working out of
order. High school runs on cramming, and software that refuses to record what
happened gets lied to.

The one exception is `before_work` and `blocks_experimentation`, where the
consequence comes from outside us and is not ours to relax.

## Versioning

Every program carries a `version`. Bump it when anything a student works
against changes. A participation records the version it began under, so a
mid-season edit never puts somebody retroactively in breach of a rule that
did not exist when they started.

## The files

| File | What it is |
|---|---|
| `process-standard.yaml` | The default research process. A starting point, not a spine. |
| `isef.yaml` | Categories, rules, and the steps every affiliated fair inherits. |
| `scvsefa-2027.yaml` | The Synopsys Championship, extending ISEF. |
| `mvhs-scvsefa-2027.yaml` | Monta Vista's club season, extending the fair. |
| `irpd-mvhs-2027.yaml` | The IRPD course, replacing the process outright. |
| `journal-mvrj-2027.yaml` | The school journal. A publication has no steps at all. |
