/**
 * PLACEHOLDER IMAGES FOR THE FIXTURES.
 *
 * The showcase is the first thing on a published page and it is hard to judge
 * empty. These give it something to hold.
 *
 * Drawn rather than committed. A handful of photographs in the repository
 * would be binary blobs nobody can review in a diff, with a licence question
 * attached to each, to make a fixture look nice. These are SVG, generated
 * from a seed so the same project gets the same picture every reset, and they
 * are obviously placeholders rather than pretending to be photographs of work
 * that was never done.
 */

/** Deterministic, so a reset does not shuffle the fixtures. */
function rng(seed) {
  let state = 0;
  for (const char of seed) state = (state * 31 + char.charCodeAt(0)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const PALETTES = [
  ['#1b3a2f', '#2f6b52', '#7fae91', '#d8e5da'],
  ['#12303f', '#245a6e', '#6fa3ae', '#d3e3e6'],
  ['#3a2b1b', '#6d5433', '#b09267', '#e6dccb'],
  ['#2b2440', '#4b4173', '#8d84b3', '#ddd9ea'],
];

/**
 * A layered landscape: sky, hills, a horizon, some trees. Enough shape to
 * read as a picture at thumbnail size and no pretence of being one.
 */
export function placeholderSvg(seed, width = 1200, height = 900) {
  const random = rng(seed);
  const palette = PALETTES[Math.floor(random() * PALETTES.length)];
  const [dark, mid, light, sky] = palette;

  const parts = [];
  parts.push(
    `<rect width="${width}" height="${height}" fill="${sky}"/>`,
    `<circle cx="${Math.round(width * (0.2 + random() * 0.6))}" cy="${Math.round(
      height * 0.22
    )}" r="${Math.round(height * 0.09)}" fill="${light}" opacity="0.55"/>`
  );

  /* Three ridges, back to front, each lower and darker. */
  for (const [index, colour] of [light, mid, dark].entries()) {
    const base = height * (0.52 + index * 0.14);
    const points = [`0,${height}`];
    for (let x = 0; x <= width; x += width / 12) {
      const y = base + Math.sin((x / width) * Math.PI * (1 + index)) * height * 0.06 * random();
      points.push(`${Math.round(x)},${Math.round(y)}`);
    }
    points.push(`${width},${height}`);
    parts.push(`<polygon points="${points.join(' ')}" fill="${colour}" opacity="${0.8 + index * 0.07}"/>`);
  }

  /* A few conifers on the front ridge. */
  const trees = 3 + Math.floor(random() * 4);
  for (let i = 0; i < trees; i += 1) {
    const x = Math.round(width * (0.08 + random() * 0.84));
    const groundY = Math.round(height * 0.82);
    const treeHeight = Math.round(height * (0.1 + random() * 0.12));
    const half = Math.round(treeHeight * 0.3);
    parts.push(
      `<polygon points="${x},${groundY - treeHeight} ${x - half},${groundY} ${x + half},${groundY}" fill="${dark}"/>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"><title>Placeholder</title>${parts.join(
    ''
  )}</svg>`;
}

/** Caption and alt for each, so the fixtures satisfy the same rules as real ones. */
export const PLACEHOLDER_CAPTIONS = [
  {
    caption: 'The collection site at low tide, looking north along the shore.',
    alt: 'A layered landscape in greens with conifers along a ridge.',
  },
  {
    caption: 'The apparatus during a thermal ramp, with the loggers in place.',
    alt: 'A layered landscape in blues with a low sun behind hills.',
  },
  {
    caption: 'Sorting the collected animals by band before the trial.',
    alt: 'A layered landscape in browns with trees on the near ridge.',
  },
  {
    caption: 'The board as presented at the fair.',
    alt: 'A layered landscape in violets with a pale horizon.',
  },
];
