/**
 * PROGRAM TEMPLATES.
 *
 * A fair is a file. ISEF defines what every affiliated fair shares, a regional
 * fair extends it with local dates and paperwork, and a school extends that
 * with its own earlier deadlines. Three levels, and each may add, override by
 * id, or remove by id.
 *
 * Two things this deliberately does not do.
 *
 * **It does not compute a calendar.** A fair picks its date because of a venue
 * booking and a Saturday, and nothing derives that. Somebody reads the dates
 * off the fair's page once a year and types them in. What relative dates buy
 * is that the rest of the season moves when the fair does, which happens more
 * often than anybody admits.
 *
 * **It does not treat every requirement as a deadline.** A form that blocks
 * experimentation is a gate: work done before it is approved is disqualified
 * and cannot be redone in the time left. Missing a deadline is recoverable;
 * passing that gate late is not, and the two should not look the same.
 */

export type Gate = 'experimentation' | 'registration' | 'competition';

export interface FormSpec {
  id: string;
  name: string;
  signed_by: string[];
  blocks: Gate;
  when?: string;
  note?: string;
  minor_only?: boolean;
}

export interface MilestoneSpec {
  id: string;
  name: string;
  gate?: Gate;
  /** A real date, read off the fair's page. */
  on?: string;
  /** Or an offset from one of the anchors. Both are accepted anywhere. */
  relative?: { anchor: string; days: number };
  /** A club's own deadline rather than the fair's. */
  internal?: boolean;
  note?: string;
}

export interface CategorySpec {
  id: string;
  name: string;
}

export interface Template {
  id: string;
  /** Groups editions of one activity. A string, never an object: a family
   *  with staff would be the seasons model returning through the side door. */
  family?: string;
  kind?: 'competition' | 'course' | 'publication' | 'independent';
  extends?: string;
  name: string;
  authority?: string;
  level?: string;
  season?: number;
  anchors: Record<string, string>;
  anchorSpecs: { id: string; label: string; required?: boolean }[];
  categories: CategorySpec[];
  forms: FormSpec[];
  milestones: MilestoneSpec[];
  limits: Record<string, any>;
  advancesTo: { program: string; label: string; note?: string }[];
}

/**
 * A date as a plain ISO day.
 *
 * YAML parses an unquoted 2027-03-10 into a Date, and a Date carries a time
 * and a zone that nobody wrote and nobody wants: a fair happens on a day. The
 * files should not have to be full of quotation marks to say so, so this
 * accepts either and returns the day.
 */
function isoDay(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** add / override / remove, or a plain list meaning add. */
type Patch<T> = T[] | { add?: T[]; override?: Partial<T>[]; remove?: string[] };

function applyPatch<T extends { id: string }>(base: T[], patch: Patch<T> | undefined): T[] {
  if (!patch) return base;
  if (Array.isArray(patch)) return merge(base, patch);

  let out = base;
  if (patch.remove) {
    const gone = new Set(patch.remove);
    out = out.filter((item) => !gone.has(item.id));
  }
  if (patch.override) {
    out = out.map((item) => {
      const change = patch.override!.find((o) => o.id === item.id);
      return change ? { ...item, ...change } : item;
    });
    /* An override for something the parent does not have is a typo, and a
       silent no-op is how a school ends up with a deadline nobody sees. */
    for (const change of patch.override) {
      if (!out.some((item) => item.id === change.id)) {
        throw new Error(`override targets "${change.id}", which no parent defines`);
      }
    }
  }
  if (patch.add) out = merge(out, patch.add);
  return out;
}

function merge<T extends { id: string }>(base: T[], additions: T[]): T[] {
  const out = [...base];
  for (const item of additions) {
    const at = out.findIndex((existing) => existing.id === item.id);
    if (at >= 0) out[at] = { ...out[at], ...item };
    else out.push(item);
  }
  return out;
}

/**
 * Fold a chain of raw files, parent first, into one template.
 *
 * The caller supplies the chain because reading files is the caller's job:
 * this runs in a worker as readily as in a script.
 */
export function resolveTemplate(chain: any[]): Template {
  if (chain.length === 0) throw new Error('no template');

  let out: Template = {
    id: chain[0].id,
    name: chain[0].name,
    anchors: {},
    anchorSpecs: [],
    categories: [],
    forms: [],
    milestones: [],
    limits: {},
    advancesTo: [],
  };

  for (const layer of chain) {
    out = {
      ...out,
      id: layer.id ?? out.id,
      /* A child inherits the family unless it declares its own, which is what
         lets a school's own file sit inside the fair's lineage. */
      family: layer.family ?? out.family,
      kind: layer.kind ?? out.kind,
      extends: layer.extends ?? out.extends,
      name: layer.name ?? out.name,
      authority: layer.authority ?? out.authority,
      level: layer.level ?? out.level,
      season: layer.season ?? out.season,
      anchorSpecs: Array.isArray(layer.anchors)
        ? merge(out.anchorSpecs, layer.anchors)
        : out.anchorSpecs,
      /* A child supplies anchors as a map of real dates; the parent declares
         them as a list of what a season needs. Same key, two shapes, because
         they are two different statements. */
      anchors:
        layer.anchors && !Array.isArray(layer.anchors)
          ? {
              ...out.anchors,
              ...Object.fromEntries(
                Object.entries(layer.anchors)
                  .map(([key, value]) => [key, isoDay(value)])
                  .filter(([, value]) => value)
              ),
            }
          : out.anchors,
      categories: applyPatch(out.categories, layer.categories),
      forms: applyPatch(out.forms, layer.forms),
      milestones: applyPatch(out.milestones, layer.milestones),
      limits: { ...out.limits, ...(layer.limits ?? {}) },
      advancesTo: layer.advances_to ?? out.advancesTo,
    };
  }

  return out;
}

export interface ResolvedDate {
  id: string;
  name: string;
  /** Null where the fair has not published it. Pending, not invented. */
  date: string | null;
  /** Where the date came from, which a student should be able to see. */
  source: 'absolute' | 'relative' | 'unknown';
  anchor?: string;
  gate?: Gate;
  internal?: boolean;
  note?: string;
}

/**
 * Turn the milestones into dates.
 *
 * A missing anchor produces a null date rather than an error or a guess. A
 * season half entered is the normal state in October, and a student planning
 * against an invented date is worse than one who can see that the fair has
 * not said yet.
 */
export function resolveDates(template: Template): ResolvedDate[] {
  return template.milestones.map((m) => {
    const written = isoDay(m.on);
    if (written) {
      return { id: m.id, name: m.name, date: written, source: 'absolute', gate: m.gate, internal: m.internal, note: m.note };
    }

    if (m.relative) {
      const anchor = template.anchors[m.relative.anchor];
      if (!anchor) {
        return {
          id: m.id,
          name: m.name,
          date: null,
          source: 'unknown',
          anchor: m.relative.anchor,
          gate: m.gate,
          internal: m.internal,
          note: m.note,
        };
      }

      const at = new Date(`${anchor}T00:00:00Z`);
      at.setUTCDate(at.getUTCDate() + m.relative.days);

      return {
        id: m.id,
        name: m.name,
        date: at.toISOString().slice(0, 10),
        source: 'relative',
        anchor: m.relative.anchor,
        gate: m.gate,
        internal: m.internal,
        note: m.note,
      };
    }

    return { id: m.id, name: m.name, date: null, source: 'unknown', gate: m.gate, internal: m.internal, note: m.note };
  });
}

/** Forms that must be approved before the work itself may begin. */
export function gatingForms(template: Template): FormSpec[] {
  return template.forms.filter((f) => f.blocks === 'experimentation');
}
