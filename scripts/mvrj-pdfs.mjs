/**
 * MATCHING A RECOVERED PAPER TO ITS RECORD.
 *
 * Its own module because two things need it and they must not disagree:
 * `seed-journal.mjs` attaches the files, and `tests/journal.mjs` proves the
 * matching against the filenames that actually arrived. A resolver tested
 * only through the seed is a resolver tested only where a database is, which
 * is nowhere in the ordinary suite.
 */

/**
 * WHICH FILE BELONGS TO WHICH RECORD.
 *
 * Three spellings, tried in order, and no fuzzy matching anywhere. A
 * near-match that guesses is how the wrong paper ends up at somebody's name.
 *
 *   1. `{slug}.pdf`, for anybody who renamed the files to their addresses.
 *   2. `source_pdf` exactly, which is the filename on the current site and is
 *      recorded for all twenty nine.
 *   3. `source_pdf` with a `(n)` before the extension, because a browser
 *      downloading the same name twice writes `… (1).pdf` and one of these
 *      arrived that way.
 *
 * Two files matching one record is refused rather than resolved: it means two
 * downloads of something and only a person knows which.
 */
export function pdfFor(row, available) {
  const stem = row.source_pdf.replace(/\.pdf$/i, '');
  const wanted = [
    `${row.slug}.pdf`,
    row.source_pdf,
  ];

  const exact = wanted.filter((name) => available.has(name));
  if (exact.length > 0) return exact[0];

  /* `Drought Transformer - Aaryan Doshi (1).pdf` for a row naming
     `Drought Transformer - Aaryan Doshi.pdf`. */
  const suffixed = [...available].filter((name) =>
    new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)\\.pdf$`, 'i').test(name)
  );

  if (suffixed.length > 1) {
    throw new Error(
      `${row.slug}: ${suffixed.length} files could be its paper (${suffixed.join(', ')}). ` +
        'Leave one, or rename it to ' + `${row.slug}.pdf.`
    );
  }

  return suffixed[0] ?? null;
}
