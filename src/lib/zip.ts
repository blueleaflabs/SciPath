/**
 * A ZIP FILE, WRITTEN BY HAND.
 *
 * The publish bundle is a handful of text files and a few images, and it has
 * to arrive as one download rather than as a list of things to save
 * individually. That needs a zip, and reaching for a library to do it would
 * put a dependency in the one path that must keep working when nobody has
 * looked at this code in a year.
 *
 * Stored, not deflated. The format allows it, every unzipper accepts it, and
 * the alternative is implementing DEFLATE. A publish bundle is a few hundred
 * kilobytes of text and images that are already compressed.
 */

const encoder = new TextEncoder();

/** CRC-32, which the format requires per entry. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string;
  body: Uint8Array | string;
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const body =
      typeof entry.body === 'string' ? encoder.encode(entry.body) : entry.body;
    const sum = crc32(body);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20); // version needed
    u16(lv, 6, 0); // flags
    u16(lv, 8, 0); // stored
    u16(lv, 10, 0); // time
    u16(lv, 12, 0); // date
    u32(lv, 14, sum);
    u32(lv, 18, body.length);
    u32(lv, 22, body.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    local.set(name, 30);

    chunks.push(local, body);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    u32(dv, 0, 0x02014b50);
    u16(dv, 4, 20); // version made by
    u16(dv, 6, 20); // version needed
    u16(dv, 8, 0);
    u16(dv, 10, 0);
    u16(dv, 12, 0);
    u16(dv, 14, 0);
    u32(dv, 16, sum);
    u32(dv, 20, body.length);
    u32(dv, 24, body.length);
    u16(dv, 28, name.length);
    u16(dv, 30, 0);
    u16(dv, 32, 0);
    u16(dv, 34, 0);
    u16(dv, 36, 0);
    u32(dv, 38, 0);
    u32(dv, 42, offset);
    dir.set(name, 46);
    central.push(dir);

    offset += local.length + body.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, offset);
  u16(ev, 20, 0);

  const total =
    chunks.reduce((n, c) => n + c.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);

  let at = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}
