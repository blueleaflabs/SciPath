/**
 * THE DEMONSTRATION RECORDS, DATED ONCE (2.9, dev-149).
 *
 * `seed-publish` wrote `published_on: today`, so the two invented records on
 * the demonstration tenant re-dated themselves on every reseed and read
 * "published today" every day: a visitor who came back a week later saw the
 * same paper, a week newer. A record's date is the day it was published,
 * which for a fixture is the day the fixture says. Both dates sit in 2026
 * on purpose: the year is in every record's URL and file key, so keeping it
 * lets `demo:refresh` correct the live records in place rather than move
 * them.
 *
 * The same file names the four pictures shown above the abstract, so the
 * seed (a fresh database) and the refresh (a live one) agree on what the
 * record looks like. The pictures are illustrations drawn from the
 * fixture's own invented abstract — `scripts/fixtures/shots/make-shots.py`
 * draws them, and the PNGs are checked in beside it.
 *
 * Plain JavaScript for the same reason as `demo-accounts.mjs`: it has two
 * readers, the seeds under plain Node and the application under Vite.
 */

/**
 * The film on the demonstration project: a real Creative Commons short on
 * Vimeo, so the facade has something to play. Its still is fetched once
 * by the seed or the refresh and stored with the record.
 */
export const FIXTURE_VIDEO = 'https://vimeo.com/76979871';

/** By record kind: the paper, and the fair entry. */
export const FIXTURE_PUBLISHED_ON = {
  article: '2026-09-04',
  project: '2026-08-28',
};

/**
 * The four pictures, in position order. Alt text says what the picture
 * shows; the caption says what it means, and says it is drawn.
 */
export const FIXTURE_SHOTS = [
  {
    file: 'shot-1.png',
    alt: 'Cross-section of a rocky shore with three coloured bands, a logger in each, and snails on the rock',
    caption: 'The collection site in cross-section: three shore bands, a temperature logger in each. Illustration.',
  },
  {
    file: 'shot-2.png',
    alt: 'Line chart of daily maximum temperature over six weeks for the high, mid and low shore bands',
    caption: 'Six weeks of daily maxima before collection; the high shore crossed 25 °C most afternoons. Illustration.',
  },
  {
    file: 'shot-3.png',
    alt: 'Diagram of a water bath with snails on a tile, a heater and a probe, beside a chart of the temperature ramp',
    caption: 'The ramp: 0.3 °C a minute in a water bath, and the temperature at which each animal let go. Illustration.',
  },
  {
    file: 'shot-4.png',
    alt: 'Bar chart of survival at 32 degrees: 88 percent high shore, 62 mid shore, 41 low shore',
    caption: 'Survival at 32 °C after twenty-four hours, by shore band. Illustration.',
  },
];
