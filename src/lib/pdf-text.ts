/**
 * TEXT OUT OF A PDF, FOR SEARCH ONLY.
 *
 * A record whose paper is a PDF has no body on its page, so nothing about its
 * argument is searchable and it is findable only by its title and abstract.
 * For an archive that will hold a back catalogue of PDFs, that is most of the
 * content missing from the index.
 *
 * This is a deliberately modest extractor. It walks the content streams,
 * inflates the ones that need it using DecompressionStream, which the runtime
 * already has, and pulls the strings out of the text-showing operators. No
 * dependency, because this runs in the same worker as everything else and a
 * PDF library is a large thing to carry for one feature.
 *
 * What it does not do: fonts with custom encodings, ligature mapping, column
 * ordering, or anything about layout. The output is rough, which is why it is
 * indexed and never rendered. A reader should see the PDF, not a flattened
 * approximation of it.
 */

/** PDF strings are Latin-1-ish with backslash escapes. */
function decodeLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      out += char;
      continue;
    }

    const next = raw[++i];
    if (next === undefined) break;

    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };

    if (simple[next] !== undefined) {
      out += simple[next];
    } else if (next >= '0' && next <= '7') {
      let octal = next;
      while (octal.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') octal += raw[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else if (next === '\n') {
      /* A line continuation inside a string. */
    } else {
      out += next;
    }
  }
  return out;
}

/** Hex strings, which is how anything non-ASCII usually arrives. */
function decodeHex(raw: string): string {
  const clean = raw.replace(/[^0-9a-fA-F]/g, '');
  let out = '';

  /* Four digits at a time is a UTF-16 code unit, two is a byte. Guessing
     between them is unavoidable without reading the font, and four is right
     far more often for the text that matters. */
  const wide = clean.length % 4 === 0 && /^(00|fe|ff)/i.test(clean);
  const step = wide ? 4 : 2;

  for (let i = 0; i + step <= clean.length; i += step) {
    const code = parseInt(clean.slice(i, i + step), 16);
    if (code > 8) out += String.fromCharCode(code);
  }
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      /* `.buffer` rather than the view.
      
         TypeScript 5.7 made `Uint8Array` generic over its buffer, and
         `BlobPart` accepts `ArrayBuffer` rather than `ArrayBufferLike` — so a
         view whose buffer might be shared no longer satisfies it. Passing the
         buffer is also what the runtime wanted: a view over a larger pool
         would have carried the bytes either side of it. */
      const stream = new Blob([bytes.buffer as ArrayBuffer])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* Try the other framing before giving up. */
    }
  }
  return null;
}

/** Latin-1, because a PDF's structure is bytes and not UTF-8. */
const latin1 = (bytes: Uint8Array) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
};

/** The strings inside BT/ET blocks, in the order they are drawn. */
export function textFromContentStream(content: string): string {
  const pieces: string[] = [];

  for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
    const body = block[1];

    for (const op of body.matchAll(
      /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\bT[Jj*]\b|\bTd\b|\bTD\b|\bT\*\b/g
    )) {
      const token = op[0];

      if (token.startsWith('(')) {
        pieces.push(decodeLiteral(token.slice(1, -1)));
      } else if (token.startsWith('<')) {
        pieces.push(decodeHex(token.slice(1, -1)));
      } else if (token === 'Td' || token === 'TD' || token === 'T*') {
        /* A new line was started. Without this every page runs together into
           one word at the join. */
        pieces.push('\n');
      }
    }
  }

  return pieces.join('');
}

/** Whitespace, hyphenation at line ends, and the debris of a bad extraction. */
export function tidy(text: string): string {
  return text
    .replace(/\r/g, '\n')
    /* A word broken across a line break, which is most of the nonsense words
       an unprocessed extraction produces. */
    .replace(/([a-z])-\n\s*([a-z])/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/ ?\n ?/g, ' ')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
}

export interface Extraction {
  text: string;
  /** How many streams yielded nothing, which is the signal that this failed. */
  skipped: number;
  streams: number;
}

/**
 * Best effort. Returns whatever it found, and how much it could not read, so
 * a caller can tell a thin result from a failed one.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<Extraction> {
  const raw = latin1(bytes);
  const pieces: string[] = [];
  let streams = 0;
  let skipped = 0;

  /* Objects with a stream. The dictionary tells us whether it is compressed
     and, just as usefully, whether it is an image we should not touch. */
  const pattern = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;

  for (const match of raw.matchAll(pattern)) {
    const [, dict, body] = match;

    if (/\/Subtype\s*\/Image|\/XObject|\/Font(?:File)?/.test(dict)) continue;

    streams += 1;
    let content = body;

    if (/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) {
      const compressed = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i += 1) compressed[i] = body.charCodeAt(i) & 0xff;

      const out = await inflate(compressed);
      if (!out) {
        skipped += 1;
        continue;
      }
      content = latin1(out);
    } else if (/\/Filter/.test(dict)) {
      /* Anything else, LZW or JBIG2 or a chain of them, is not worth the code. */
      skipped += 1;
      continue;
    }

    if (!content.includes('BT')) continue;

    const text = textFromContentStream(content);
    if (text.trim()) pieces.push(text);
  }

  return { text: tidy(pieces.join('\n')), streams, skipped };
}

/**
 * Enough to be worth indexing.
 *
 * A scanned PDF with no text layer produces a handful of stray characters,
 * and putting those in a search index is worse than putting nothing there:
 * it makes a record appear for queries it has no bearing on.
 */
export function worthIndexing(result: Extraction): boolean {
  const words = result.text.split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 50) return false;

  /* Real prose is mostly letters. A failed extraction is mostly not. */
  const letters = (result.text.match(/[a-zA-Z]/g) ?? []).length;
  return letters / Math.max(result.text.length, 1) > 0.6;
}
