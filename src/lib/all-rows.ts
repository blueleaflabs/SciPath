/**
 * EVERY ROW, NOT THE FIRST THOUSAND.
 *
 * PostgREST answers a select with at most `max_rows` (1000 here, and the
 * same on the hosted project) and says nothing about the rest. That is the
 * right default for a page and the wrong one for a roll-up: a class of
 * thirty-eight projects with thirty-two obligations each is 1,216 rows,
 * and a Workbench reading the first thousand told a teacher eighteen
 * projects were behind on a day when every one of them was. The projects
 * past the cut had no obligations at all as far as the page could see, so
 * they were shown in order.
 *
 * `build` returns a fresh query each time, because a builder is consumed
 * by awaiting it. The ordering is whatever the caller asked for plus the
 * primary key, so the pages tile without a row falling between them.
 */
export async function allRows<T = any>(
  build: () => any,
  pageSize = 1000
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: out, error };
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return { data: out, error: null };
}
