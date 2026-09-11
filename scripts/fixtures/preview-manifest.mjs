/* A throwaway manifest for looking at the showcase front without a database
   (dev-149). Writes eight invented records for `demo` into the local bucket
   and one picture; run `npm run dev` and open demo.localhost:4321/showcase/.
   Not part of any command; delete-safe. */
import fs from 'node:fs';
import { openBucket } from '../notebook-bucket.mjs';
import { writeManifest, manifestKey } from '../../src/lib/records-store.ts';

const store = await openBucket({ url: 'http://127.0.0.1:54321' });
const bucket = store.bucket;

const png = fs.readFileSync('scripts/fixtures/shots/shot-1.png');
await bucket.put('records/demo/projects/2026/thermal/shot-1.png', new Uint8Array(png).buffer, { httpMetadata: { contentType: 'image/png' } });

const base = (i, over) => ({
  recordId: `DEMO-202${i % 3 + 4}-000${i}`, recordKind: 'article', slug: `paper-${i}`, year: 2024 + (i % 3),
  title: ['Nitrogen fixation in urban soils', 'A low-cost turbidity sensor for creek monitoring', 'Does prior heat exposure change the upper thermal limit of Nucella?', 'Mapping heat islands across Cupertino with bicycle-mounted loggers', 'Acoustic monitoring of bat activity near LED streetlights', 'Photovoltaic soiling on tilted panels through a dry summer', 'Microplastic counts in Stevens Creek after storms', 'Reaction-time drift under classroom CO₂ levels'][i - 1],
  authors: [{ displayName: ['Ana Reyes', 'Wei Zhang', 'Parnavi Patel', 'Omar Haddad', 'Lena Fischer', 'Ravi Menon', 'Sofia Rossi', 'Kenji Mori'][i - 1], authorSlug: null }],
  abstract: 'An abstract of reasonable length that says what was asked, what was done, and what was found, so that a reader is reading science within three seconds of arriving on the page.',
  keywords: [], discipline: ['earth-climate', 'engineering-robotics', 'biology-biomedicine', 'earth-climate', 'biology-biomedicine', 'physics', 'chemistry-materials', 'neuroscience'][i - 1],
  publishedOn: `202${i % 3 + 4}-0${(i % 9) + 1}-10`, datePrecision: 'day', source: 'migrated', reviewed: true, bodyFormat: 'full-text',
  methods: [], dataSources: [], outputs: [], entries: [], figures: [], shots: [], references: [], dataLinks: [], license: 'CC BY 4.0', status: 'published',
  ...over,
});

const records = [
  base(1, { entries: [{ program: 'Synopsys Championship', season: '2025', placement: 'First Award', awards: ['Ricoh Sustainable Development Award'], advancedTo: null }] }),
  base(2, { entries: [{ program: 'Synopsys Championship', season: '2024', placement: 'Second Award', awards: [], advancedTo: 'CSEF' }] }),
  base(3, { recordKind: 'project', slug: 'thermal', year: 2026, recordId: 'DEMO-2026-0003', source: 'workbench', publishedOn: '2026-08-28',
    shots: [{ src: '/records/projects/2026/thermal/shot-1.png', caption: 'The site', alt: 'shore' }],
    entries: [{ program: 'Synopsys Championship', season: '2027', placement: 'Second Award', awards: [], advancedTo: null }] }),
  base(4), base(5), base(6), base(7), base(8, { reviewed: false }),
];

await writeManifest(bucket, { org: 'demo', updatedAt: new Date().toISOString(), records });
console.log(`wrote ${records.length} records to ${manifestKey('demo')}`);
await store.dispose();
