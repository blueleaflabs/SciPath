/**
 * RESOLVING A TEMPLATE, WITH NO I/O.
 *
 * Split out of `templates.ts` so the same resolution runs in three places:
 * the application, where the files arrive through Vite's `import.meta.glob`;
 * the seed scripts, which read them with `fs`; and the tests.
 *
 * Two copies of this logic is how a fair's calendar comes to mean one thing
 * in the database and another on the page, so there is one copy and the
 * callers supply the parsed documents.
 */

/* ── What the files contain ───────────────────────────────────────────────── */

export type Requirement = 'required' | 'optional' | 'conditional';
export type Owner = 'student' | 'sponsor' | 'staff' | 'program' | 'participant';

export interface Constraint {
  max?: number;
  min?: number;
  /** What is counted. "Six pages" means different things at different fairs. */
  counting?: string;
}

export interface Deliverable {
  id: string;
  name: string;
  kind: 'text' | 'file' | 'link' | 'form' | 'physical' | 'internal';
  owner?: Owner;
  requirement: Requirement;
  applies_when?: string;
  constraints?: Record<string, Constraint>;
  guidance?: string;
  shape?: string;
  /** A form that must be signed and dated before the work begins. */
  before_work?: boolean;
  signed_by?: string[];
  per?: 'project' | 'member' | 'participant';
  url?: string;
}

export interface ShapePart {
  id: string;
  name: string;
  min_words?: number;
  guidance?: string;
}

export interface Shape {
  id: string;
  name: string;
  layout?: string;
  guidance?: string;
  parts?: ShapePart[];
  /** For a shape that is questions rather than sections. */
  answers?: string[];
}

export interface Phase {
  id: string;
  name?: string;
  /** A teacher saying when the class does this. Not an estimate. */
  window?: { from: string; to: string };
}

export interface Step {
  id: string;
  name: string;
  phase: string;
  order: number;
  due?: { anchor?: string; days?: number; on?: string; window?: unknown };
  recommended?: { anchor: string; days?: number };
  requires?: string[];
  owner?: Owner;
  deliverables?: { ref?: string; id?: string }[];
  consequence?: string;
  applies_when?: string;
  repeats?: { every: string; until?: unknown };
  /**
   * Which layer contributed it: the research process, the institution, or
   * the school's own club. The interface needs it to say whose deadline this
   * is, and a student who cannot tell a club deadline from a fair rule
   * starts treating real deadlines as advisory.
   */
  source?: 'process' | 'program' | 'school';
  risk?: string;
  note?: string;
  internal?: boolean;
  review?: string;

  /**
   * When this step starts being worth mentioning, and when it starts being
   * worth mentioning first.
   *
   * **A window, not a schedule.** Nothing is queued, so there is nothing to
   * cancel when the form is signed: the step simply stops appearing (20.5).
   * `from` and `urgent` are whole days before the due date.
   *
   * Absent means the default for this step's `consequence`, which is
   * inherited down the same chain as everything else. The data already knows
   * how much a deadline matters, so a step that ends a season gets three
   * weeks without anybody deciding it again.
   *
   * `notify: none` in a template resolves to `null` here, and is refused by
   * a test for any step whose lateness blocks something.
   */
  notify?: { from?: number; urgent?: number; to?: string[] } | null;

  /** One line a template may add, exactly as `risk` does. */
  notify_note?: string;
}

export interface Program {
  id: string;
  family?: string;
  /** What the people in it call it. "IRPD", not the sentence it stands for. */
  short_name?: string;
  kind?: 'competition' | 'course' | 'publication' | 'process' | 'independent' | 'showcase';
  name: string;
  version?: number;
  extends?: string;
  process?: string;
  role?: 'cohort' | 'opportunity' | 'none';
  prepares_for?: string;
  /** An opportunity only this cohort's members may enter. */
  open_to_cohort?: string;
  uses?: { deliverables?: string[]; shapes?: string[] };
  anchors?: Record<string, string>;
  phases?: Phase[];

  /**
   * What this program has, as opposed to what a competition has.
   *
   * A class has no categories, no awards and nowhere to advance to; a grant
   * has money instead. Declared in the templates from the beginning and
   * never resolved, so every program's entry page showed a fair's result
   * form — a research class asking a student what they placed in their
   * category.
   */
  has?: Record<string, boolean>;
  steps?: Step[] | { add?: Step[]; override?: Partial<Step>[]; remove?: string[] };
  deliverables?: Deliverable[] | { add?: Deliverable[]; override?: Partial<Deliverable>[] };
  categories?: any;
  limits?: Record<string, any>;
  facts?: { id: string; question: string }[];
  roles?: { staff?: { singular: string; plural: string }; member?: { singular: string; plural: string } };
  publishes_to?: string;
  staff_from?: string[];
  accepts_from?: string[];

  /**
   * WHERE THIS TEMPLATE CAME FROM, AND WHETHER IT IS STILL TRUE.
   *
   * A template is somebody's reading of a rulebook on a particular day, and
   * a rulebook changes annually. Nothing here recorded who read it, what
   * they read, or when — so a file written for the 2026 rules and never
   * touched looked exactly like one checked last week, and the only way to
   * tell was to read the fair's site yourself.
   *
   * `verified_on` is the one that does work. Everything else is a reference;
   * that field is a clock. A year after it, the program's advisor is told,
   * because a stale template is a professional problem for whoever runs the
   * program and an unactionable worry for a student.
   *
   * A missing field is not a failure. A school's own class has no rulebook
   * and no rules year, and demanding one would produce a filled-in field
   * that means nothing.
   */
  provenance?: Provenance;

  [key: string]: any;
}

/**
 * Provenance, with its dates made into days.
 *
 * `verified_on: 2026-08-22` unquoted is parsed as a timestamp by every YAML
 * loader, so a field written to be compared and printed arrives as a `Date`
 * and renders as *Sat Aug 22 2026 00:00:00 GMT+0000*. Quoting it in the files
 * would work until the first person who forgets, and forgetting produces a
 * date that still looks like a date.
 *
 * `asDay` above already does this for anchors and was written for the same
 * reason. One copy: a second would be a second answer to *what is a day*.
 */
function cleanProvenance(raw: Provenance | undefined): Provenance | undefined {
  if (!raw) return undefined;

  return {
    ...raw,
    verified_on: asDay(raw.verified_on) ?? undefined,
    changes: (raw.changes ?? []).map((c) => ({ on: asDay(c.on) ?? '', what: c.what })),
  };
}

export interface Provenance {
  /** A person, named. "The club" cannot be asked what it read. */
  owner?: string;
  /** What they read. The document, not the fair's home page. */
  source_url?: string;
  /** The season the rules belong to, where the rules have seasons. */
  rules_year?: number;
  /** The day somebody last read the source and confirmed this against it. */
  verified_on?: string;
  /**
   * What changed for somebody working against this, most recent first.
   *
   * Not a commit log. Git already holds every edit, and a second copy of
   * that is a copy that goes stale; this is the short list of changes a
   * student or an advisor would want to have been told about.
   */
  changes?: { on: string; what: string }[];
}

/* ── Resolving one program through its chain ──────────────────────────────── */

export interface Resolved {
  /** Overrides a swapped process left with nothing to target. */
  inapplicableOverrides?: string[];
  /** The research process a project started here follows, or null. */
  processId?: string | null;
  id: string;
  name: string;
  /** What the people in it call it, where that is shorter than its name. */
  short_name?: string;

  /** This program's own reading of a rulebook, and when. */
  provenance?: Provenance;
  /**
   * Every layer's, nearest first.
   *
   * A regional fair that inherits ISEF's forms inherits ISEF's rulebook, and
   * somebody checking a form needs both readings: the fair's, and the one
   * behind it. Layers that record nothing are left out rather than shown as
   * blanks.
   */
  provenance_chain?: (Provenance & { id: string; name: string })[];

  family?: string;
  kind: string;
  version: number;
  anchors: Record<string, string>;
  phases: Phase[];
  has: Record<string, boolean>;
  steps: Step[];
  deliverables: Map<string, Deliverable>;
  facts: { id: string; question: string }[];
  limits: Record<string, any>;
  categories: { id: string; name: string }[];
  roles: { staff: { singular: string; plural: string }; member: { singular: string; plural: string } };

  /**
   * Cohort, opportunity, or neither.
   *
   * Set by `resolveProgram` and absent from this interface, so `seed-programs`
   * read `resolved.role` off a value the checker said had no such property —
   * and the whole distinction between a class and a fair rests on it.
   */
  role: 'cohort' | 'opportunity' | 'none';

  /** An opportunity only this cohort's members may enter, where there is one. */
  openToCohort?: string | null;
  /** The fair a cohort prepares for, where it prepares for one. */
  preparesFor?: string | null;
  program: Program;
}

const DEFAULT_ROLES = {
  staff: { singular: 'Officer', plural: 'Officers' },
  member: { singular: 'Student', plural: 'Students' },
};

/** Parent first. `extends` walks up; `process` prepends the process file. */
function chainFor(
  id: string,
  programs: Map<string, Program>,
  processOverride?: string | null
): Program[] {
  const chain: Program[] = [];
  const seen = new Set<string>();

  let current = programs.get(id);
  if (!current) throw new Error(`no program "${id}"`);

  while (current) {
    if (seen.has(current.id)) throw new Error(`extends loops at "${current.id}"`);
    seen.add(current.id);
    chain.unshift(current);
    current = current.extends ? programs.get(current.extends) : undefined;
  }

  /* Which research process this program runs on. The root of the chain
     decides and a child inherits it, because the process describes the work
     rather than the institution: a school's own layer does not get to
     replace the science with something else.
   
     `own` means the program brings its own steps, which IRPD does. */
  /* The project's process wins where one is given.
  
     A program used to name the process, which meant the same work described
     itself differently depending on which fair it was entered in, and meant
     a project entered nowhere had no process at all. The process is a fact
     about the work (22.4), so the caller passes the project's and the
     template's own declaration is the fallback. */
  let wants = processOverride ?? chain.find((p) => p.process)?.process;

  /* A project whose process *is* this template. IRPD's framework is not a
     process file it inherits, it is the class's own steps, so a project
     started there carries `irpd-mvhs-2027` as its process and resolving it
     against itself must not prepend anything. Without this the lookup for
     `process-irpd-mvhs-2027` misses and falls through to the standard
     process, quietly giving a design student the scientific method. */
  if (wants === id) wants = 'own';

  if (wants && wants !== 'own') {
    const process = programs.get(`process-${wants}`) ?? programs.get('process-standard');
    if (process) chain.unshift(process);
  }

  return chain;
}

function patch<T extends { id: string }>(
  base: T[],
  value: any,
  /**
   * Where an override names something no parent defines, it is recorded and
   * skipped rather than thrown.
   *
   * It used to throw, which was right while a program named its own research
   * process: an override with no target meant a typo. Now the process comes
   * from the project (22.4), so the same template resolves against different
   * steps depending on the work — a fair that tightens "collect the data" is
   * tightening a step of the *scientific* process, and an engineering project
   * at that fair has no such step. Throwing would make a public deadlines
   * page fail because somebody might one day enter it with a different
   * process.
   *
   * **The strictness moved to a test rather than being dropped.** Resolved
   * with the process a template expects, `inapplicableOverrides` must be
   * empty, which still catches the typo it was written for.
   */
  skipped?: string[]
): T[] {
  if (!value) return base;
  if (Array.isArray(value)) return mergeById(base, value);

  let out = value.replace ? [...value.replace] : base;
  if (value.remove) {
    const gone = new Set(value.remove);
    out = out.filter((item: T) => !gone.has(item.id));
  }
  if (value.override) {
    for (const change of value.override) {
      const at = out.findIndex((item: T) => item.id === change.id);
      if (at < 0) {
        skipped?.push(change.id);
        continue;
      }
      out[at] = { ...out[at], ...change };
    }
  }
  if (value.add) out = mergeById(out, value.add);
  return out;
}

function mergeById<T extends { id: string }>(base: T[], additions: T[]): T[] {
  const out = [...base];
  for (const item of additions) {
    const at = out.findIndex((existing) => existing.id === item.id);
    if (at >= 0) out[at] = { ...out[at], ...item };
    else out.push(item);
  }
  return out;
}

const asDay = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

/** Everything the resolver needs, supplied by whoever loaded the files. */
export interface Library {
  programs: Map<string, Program>;
  deliverables: Map<string, { id: string; deliverables?: Deliverable[]; facts?: any[] }>;
  shapes: Map<string, Shape>;
}

export function resolveProgram(
  id: string,
  library: Library,
  /**
   * The research process to build the chain on, from `projects.process_id`.
   *
   * A template id (`process-science`) or a bare name (`science`), because
   * the column holds the former and the YAML holds the latter, and a caller
   * should not have to know which. Omitted, the template decides, which is
   * what every caller did before the process moved to the project.
   */
  process?: string | null
): Resolved {
  const { programs, deliverables: libraries } = library;
  const chain = chainFor(id, programs, process?.replace(/^process-/, '') ?? null);

  /* Overrides that do not apply, because the caller swapped the process out
     from under them. Kept rather than discarded so a test can see how much a
     template is coupled to one way of working. */
  const inapplicable: string[] = [];
  const last = chain[chain.length - 1];

  const phases = new Map<string, Phase>();
  const anchors: Record<string, string> = {};
  const facts: { id: string; question: string }[] = [];
  let steps: Step[] = [];
  /**
   * The floor every program stands on.
   *
   * In code rather than in a template, because it has to exist when no
   * template says anything. IRPD brings its own steps and chains through no
   * research process, so it inherited nothing, so every step resolved to no
   * window, so a student two weeks from a real deadline owed five things and
   * was told about none of them. A default that only applies to programs
   * shaped like the fair is not a default.
   *
   * Any layer may override it, in whole or by key. Keyed on `consequence`
   * because the data already knows how much a deadline matters: a step that
   * ends a season gets three weeks and an escalation without anybody
   * deciding it again (20.5).
   *
   * `blocking` is the fallback for a consequence with no entry of its own,
   * and it is loud on purpose: somebody adding `blocks_the_new_thing` should
   * get noise and a failing check, not silence.
   */
  let notifyDefault: Record<string, { from?: number; urgent?: number }> = {
    blocks_experimentation: { from: 21, urgent: 3 },
    blocks_submission: { from: 14, urgent: 3 },
    blocks_human_participants: { from: 14, urgent: 3 },
    blocks_publication: { from: 14, urgent: 3 },
    blocking: { from: 14, urgent: 3 },
    none: { from: 5, urgent: 1 },
  };
  let categories: any[] = [];
  let limits: Record<string, any> = {};

  /* Deliverables come from the libraries a program names, then from anything
     it declares itself. Libraries first so a program can override one. */
  const deliverables = new Map<string, Deliverable>();
  for (const layer of chain) {
    for (const name of layer.uses?.deliverables ?? []) {
      const library = libraries.get(name);
      if (!library) throw new Error(`${layer.id} uses "${name}", which is not a library`);
      for (const d of library.deliverables ?? []) deliverables.set(d.id, d);
      for (const f of library.facts ?? []) facts.push(f);
    }
  }

  /* What the program has. Merged down the chain like everything else, so a
     school can turn a capability off that the institution has: a club that
     does not do its own awards says so without forking the fair. */
  const has: Record<string, boolean> = {};

  for (const layer of chain) {
    Object.assign(has, layer.has ?? {});

    for (const p of layer.phases ?? []) phases.set(p.id, { ...phases.get(p.id), ...p });

    for (const [key, value] of Object.entries(layer.anchors ?? {})) {
      const day = asDay(value);
      if (day) anchors[key] = day;
    }

    for (const f of layer.facts ?? []) facts.push(f);

    const before = new Set(steps.map((s) => s.id));
    steps = patch(steps, layer.steps, inapplicable);
    /* Tag anything this layer introduced. An override does not change whose
       deadline it is, so only new ids are tagged. */
    const origin =
      layer.kind === 'process' ? 'process' : layer.level === 'school' ? 'school' : 'program';
    steps = steps.map((step) =>
      before.has(step.id) ? step : { ...step, source: step.source ?? origin }
    );
    categories = patch(categories, layer.categories);
    limits = { ...limits, ...(layer.limits ?? {}) };
    notifyDefault = { ...notifyDefault, ...((layer as any).notify_default ?? {}) };

    const own = layer.deliverables;
    const list = Array.isArray(own) ? own : [...(own?.add ?? []), ...(own?.override ?? [])];
    for (const d of list as Deliverable[]) {
      deliverables.set(d.id, { ...deliverables.get(d.id), ...d } as Deliverable);
    }
  }

  /**
   * Fill each step's reminder window from the default for its consequence.
   *
   * Thirty steps do not need thirty blocks, and the data already knows how
   * much a deadline matters: a step that ends a season inherits three weeks
   * and an escalation without anybody deciding it again (20.5).
   *
   * An explicit `notify` wins. `notify: none` resolves to null, which means
   * the step is never mentioned, and a test refuses that for anything whose
   * lateness blocks something.
   */
  steps = steps.map((step) => {
    if (step.notify === null) return step;
    if (step.notify) return step;

    const consequence = step.consequence ?? 'none';

    /* A consequence with no entry falls back to `blocking` rather than to
       `none`. A template author adding `blocks_the_new_thing` should get a
       loud default and a failing check, not silence: the quiet option is
       the one nobody would notice was wrong. */
    const fallback =
      notifyDefault[consequence] ??
      (consequence === 'none' ? notifyDefault.none : notifyDefault.blocking);

    return fallback ? { ...step, notify: { ...fallback } } : step;
  });

  const resolved: Resolved = {
    id: last.id,
    name: last.name,
    /* This layer's own, exactly like `name` above it and for the same
       reason. Walking the chain for one looked more forgiving and was
       wrong: a club that prepares for a fair inherited the fair's
       abbreviation and called itself by it. A program with no short name
       says its full name, which is always correct if sometimes long. */
    short_name: last.short_name,

    /* This layer's own, and the chain's behind it. A regional fair that
       inherits ISEF's forms inherits ISEF's rulebook, so its own reading is
       what shows and ISEF's is what stands behind it — two things somebody
       checking a form actually needs, and one of them would be lost by
       taking only the nearest.
    
       Nearest first, so `provenance[0]` is always this program's own. */
    provenance: cleanProvenance(last.provenance),
    provenance_chain: chain
      .map((layer) => ({ id: layer.id, name: layer.name, ...cleanProvenance(layer.provenance) }))
      .filter((p) => p.owner || p.source_url || p.verified_on)
      .reverse(),

    family: last.family,
    kind: last.kind ?? 'competition',

    /* Which research process a project started here follows. Consumed above
       to build the chain, and carried out because the program row records it
       so `app.process_for` can read it at creation (22.4).
    
       `own` resolves to this template's own id: IRPD's framework *is* the
       template, so a project started there follows that rather than a
       process file. */
    /** Overrides skipped because this project's process has no such step. */
    inapplicableOverrides: inapplicable,
    role: last.role ?? 'opportunity',
    openToCohort: last.open_to_cohort ?? null,
    preparesFor: last.prepares_for ?? null,

    processId:
      (() => {
        const wants = chain.find((p) => p.process)?.process;
        if (!wants) return null;
        return wants === 'own' ? last.id : `process-${wants}`;
      })(),

    version: last.version ?? 1,
    anchors,
    phases: [...phases.values()],
    has,
    steps: steps.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    deliverables,
    facts: dedupe(facts),
    limits,
    categories,
    roles: { ...DEFAULT_ROLES, ...(last.roles ?? {}) } as Resolved['roles'],
    program: last,
  };

  return resolved;
}

function dedupe<T extends { id: string }>(list: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of list) seen.set(item.id, item);
  return [...seen.values()];
}

/* ── Turning a resolved program into dates ────────────────────────────────── */

export interface StepDate {
  step: Step;
  /** Null where nobody has published it. Pending, never invented. */
  date: string | null;
  source: 'absolute' | 'relative' | 'window' | 'unknown';
  window?: { from: string; to: string };
}

export function datesFor(program: Resolved): StepDate[] {
  const windows = new Map(
    program.phases.filter((p) => p.window).map((p) => [p.id, p.window!])
  );

  return program.steps.map((step) => {
    const on = asDay(step.due?.on);
    if (on) return { step, date: on, source: 'absolute' as const };

    if (step.due?.anchor) {
      const anchor = program.anchors[step.due.anchor];
      if (!anchor) return { step, date: null, source: 'unknown' as const };

      const at = new Date(`${anchor}T00:00:00Z`);
      at.setUTCDate(at.getUTCDate() + (step.due.days ?? 0));
      return { step, date: at.toISOString().slice(0, 10), source: 'relative' as const };
    }

    /* No date of its own, but its phase says when. A window is an
       instruction rather than an estimate, so it resolves to the last day of
       the month the teacher named. */
    const window = windows.get(step.phase);
    if (window) {
      return {
        step,
        date: windowEnd({ ...program, steps: [] } as Resolved, window),
        source: 'window' as const,
        window,
      };
    }

    return { step, date: null, source: 'unknown' as const };
  });
}

/**
 * The last day of a phase window, as a real date.
 *
 * A window is a teacher saying when the class does this, and it carries a
 * teacher's authority (6.8). Turning "September to October" into the last day
 * of October is reading what they said, not inventing a deadline — which is
 * the line that matters, because a step with a window and no concrete date
 * was being dropped entirely and a course lost six of its eight milestones.
 *
 * The year comes from the program's own start. Months at or after the month
 * the course begins are in that year; anything earlier has rolled over into
 * the next one, which is what a school year does.
 */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function windowEnd(program: Resolved, window: { from: string; to: string }): string | null {
  const start =
    program.anchors.course_start ??
    program.anchors.applications_open ??
    Object.values(program.anchors)[0];

  if (!start) return null;

  const startYear = Number(start.slice(0, 4));
  const startMonth = Number(start.slice(5, 7)) - 1;

  const month = MONTHS.indexOf(window.to.toLowerCase());
  if (month < 0) return null;

  const year = month >= startMonth ? startYear : startYear + 1;

  /* Day 0 of the next month is the last day of this one, and it handles
     February without anybody having to think about it. */
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.toISOString().slice(0, 10);
}

/* ── Questions the application asks ───────────────────────────────────────── */

/** Steps whose lateness has a real consequence, in date order. */
export function hardSteps(program: Resolved): Step[] {
  return program.steps.filter((s) => s.consequence && s.consequence !== 'none');
}

/** Deliverables a project needs, given what it has said about itself. */
export function deliverablesFor(
  program: Resolved,
  step: Step,
  facts: Record<string, boolean> = {}
): Deliverable[] {
  const out: Deliverable[] = [];
  for (const entry of step.deliverables ?? []) {
    const id = entry.ref ?? entry.id;
    if (!id) continue;
    const deliverable = { ...program.deliverables.get(id), ...entry } as Deliverable;
    if (!deliverable.name) continue;
    if (deliverable.applies_when && !evaluate(deliverable.applies_when, facts)) continue;
    out.push(deliverable);
  }
  return out;
}

/** Does this step apply to a project at all. */
export function stepApplies(step: Step, facts: Record<string, boolean> = {}): boolean {
  return step.applies_when ? evaluate(step.applies_when, facts) : true;
}

/**
 * `humans or vertebrates`, `not needs_src_approval`.
 *
 * Deliberately small: or, and, not, and names. Anything more expressive is a
 * language, and a language in a config file is something nobody can read six
 * months later.
 */
export function evaluate(expression: string, facts: Record<string, boolean>): boolean {
  const tokens = expression.trim().split(/\s+/);
  let result: boolean | null = null;
  let operator: 'or' | 'and' = 'or';
  let negate = false;

  for (const token of tokens) {
    if (token === 'or' || token === 'and') {
      operator = token;
      continue;
    }
    if (token === 'not') {
      negate = true;
      continue;
    }

    let value = Boolean(facts[token]);
    if (negate) {
      value = !value;
      negate = false;
    }

    if (result === null) result = value;
    else result = operator === 'and' ? result && value : result || value;
  }

  return result ?? true;
}

export function shapeFrom(library: Library, id: string | undefined): Shape | null {
  return id ? library.shapes.get(id) ?? null : null;
}
