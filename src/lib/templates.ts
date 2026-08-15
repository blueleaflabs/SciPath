/**
 * THE TEMPLATE REGISTRY, FOR THE APPLICATION.
 *
 * Bundles every program, deliverable, and shape with `import.meta.glob`, so
 * this works inside a Worker with no filesystem and no network, and a
 * malformed template fails the build rather than a page.
 *
 * The resolution itself is in `template-resolve.ts`, which has no I/O in it,
 * because the seed scripts and the tests have to resolve the same files the
 * same way. Two copies of that logic is how a fair's calendar comes to mean
 * one thing in the database and another on the page.
 */

import yaml from 'js-yaml';
import {
  resolveProgram as resolve,
  shapeFrom,
  type Library,
  type Program,
  type Shape,
  type Resolved,
} from './template-resolve';

export * from './template-resolve';

const parse = <T>(files: Record<string, string>): Map<string, T> => {
  const out = new Map<string, T>();
  for (const [path, text] of Object.entries(files)) {
    const doc = yaml.load(text) as any;
    if (!doc?.id) throw new Error(`${path} has no id`);
    out.set(doc.id, doc);
    /* Also keyed by filename, so a chain may name either. */
    const file = path.split('/').pop()!.replace(/\.yaml$/, '');
    if (file !== doc.id) out.set(file, doc);
  }
  return out;
};

/* The options have to be written out at each call: the glob is rewritten at
   build time, so a shared constant is an identifier the transform cannot
   read. */
export const programs = parse<Program>(
  import.meta.glob('/src/config/programs/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
);

export const shapes = parse<Shape>(
  import.meta.glob('/src/config/shapes/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
);

const deliverables = parse<any>(
  import.meta.glob('/src/config/deliverables/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
);

export const library: Library = { programs, deliverables, shapes };

/* Resolution is not cheap and a page may ask twice. */
const cache = new Map<string, Resolved>();

/**
 * A program, resolved for the process a project follows.
 *
 * Cached on both, because the same fair resolves differently for a
 * scientific project and an engineering one: the process is a fact about the
 * work rather than about the venue (22.4). Omitting it is what every caller
 * did before the process moved to the project, and the template's own
 * declaration is then the fallback.
 */
export function resolveProgram(id: string, process?: string | null): Resolved {
  const key = `${id}::${process ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const resolved = resolve(id, library, process ?? null);
  cache.set(key, resolved);
  return resolved;
}

export function shape(id: string | undefined): Shape | null {
  return shapeFrom(library, id);
}

/** Every program a school could run, for a picker or a seed. */
export function allPrograms(): Program[] {
  const seen = new Map<string, Program>();
  for (const program of programs.values()) seen.set(program.id, program);
  return [...seen.values()];
}
