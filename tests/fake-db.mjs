/**
 * A supabase-js client over arrays, for scripts that write the class's
 * calendar (dev-160). Enough of the query builder for what those scripts
 * do — select / eq / not / is / in / update / insert / select-after-insert
 * / single / order — and nothing else; an unknown call throws so a test
 * cannot pass on a method the fake silently ignored. One embed is
 * understood: `organizations:org_id(slug)`, resolved from the
 * `organizations` table.
 */
let seq = 0;
export const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function fakeDb(tables) {
  const T = tables;
  const from = (name) => {
    if (!T[name]) T[name] = [];
    const filters = [];
    let op = 'select';
    let payload = null;
    let embed = null;
    let wantSingle = false;
    const q = {
      select(cols = '*') {
        const m = /(\w+):(\w+)\((\w+)\)/.exec(cols);
        if (m) embed = { as: m[1], fk: m[2], table: m[1], col: m[3] };
        if (op === 'insert') op = 'insert-select';
        return q;
      },
      eq(k, v) { filters.push((r) => r[k] === v); return q; },
      is(k, v) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
      not(k, oper, v) { if (oper !== 'is' || v !== null) throw new Error(`fake not(${oper})`); filters.push((r) => r[k] != null); return q; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
      order() { return q; },
      update(p) { op = 'update'; payload = p; return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      single() { wantSingle = true; return q; },
      then(resolve, reject) {
        try {
          const rows = T[name].filter((r) => filters.every((f) => f(r)));
          let data = null;
          if (op === 'select') {
            data = rows.map((r) => {
              const out = { ...r };
              if (embed) { const o = (T[embed.table] ?? []).find((x) => x.id === r[embed.fk]); out[embed.as] = o ? { [embed.col]: o[embed.col] } : null; }
              return out;
            });
          } else if (op === 'update') {
            for (const r of rows) Object.assign(r, payload);
            data = rows;
          } else if (op === 'insert' || op === 'insert-select') {
            const list = Array.isArray(payload) ? payload : [payload];
            const made = list.map((p) => ({ id: id(), ...p }));
            T[name].push(...made);
            data = op === 'insert-select' ? made.map((r) => ({ id: r.id })) : null;
          }
          if (wantSingle) data = data?.[0] ?? null;
          resolve({ data, error: null });
        } catch (e) { resolve({ data: null, error: { message: e.message } }); }
      },
    };
    return q;
  };
  return { from, tables: T };
}
