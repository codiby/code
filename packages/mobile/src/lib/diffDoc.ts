/**
 * Gramática del bloque ```diffdoc.
 *
 * Puerto directo de `packages/ui/src/lib/diff-doc.ts` del escritorio. Aquel
 * módulo se escribió a propósito sin DOM, React ni resaltador, así que la
 * lógica se conserva íntegra y solo cambia el renderizado. Las únicas
 * diferencias son las aserciones de índice que exige el tsconfig de este
 * proyecto y `+= 1` en vez de `++`.
 *
 * Forma de un bloque:
 *
 *     file packages/core/session/watcher.ts
 *     @@ 28
 *     +const SKIP = new Set(['node_modules', '.git'])
 *
 *     > Un `Set` en vez de un glob: micromatch corría una vez por entrada.
 *     ~ 12
 *     @@ 44 46
 *      async function walk(dir: string) {
 *     -  for (const e of await readdir(dir)) {
 *     +  for (const e of await readdir(dir, { withFileTypes: true })) {
 */

/** Línea de código del diff. `mark` es el tramo cambiado dentro de la línea. */
export interface DiffDocCodeRow {
  kind: 'ctx' | 'add' | 'del';
  /** Número de línea (1-based) del lado previo; null en las añadidas. */
  oldNo: number | null;
  /** Número de línea (1-based) del lado posterior; null en las borradas. */
  newNo: number | null;
  code: string;
  mark?: { start: number; end: number };
}

/** Prosa compuesta *dentro* del diff, anclada a las líneas de arriba. */
export interface DiffDocNoteRow {
  kind: 'note';
  text: string;
}

/** Tramo de líneas sin cambios que el autor decidió no reproducir. */
export interface DiffDocGapRow {
  kind: 'gap';
  count: number;
}

export type DiffDocRow = DiffDocCodeRow | DiffDocNoteRow | DiffDocGapRow;

export interface DiffDocBlock {
  path: string;
  lang: string;
  rows: DiffDocRow[];
  added: number;
  removed: number;
  /** Se llena cuando la fuente está mal formada; el llamador cae a bloque plano. */
  error?: string;
}

const FILE_RE = /^file\s+(\S+)(?:\s+lang=([\w+#-]+))?\s*$/;
const HUNK_RE = /^@@\s*(\d+)(?:\s*[,\s]\s*(\d+))?\s*$/;

/**
 * El resalte dentro de la línea solo vale la pena cuando las dos líneas son
 * claramente la *misma* línea editada. Por debajo de estos caracteres en común,
 * o por encima de esta proporción cambiada, el par es una reescritura y teñir
 * un tramo dentro es ruido.
 */
const MARK_MIN_COMMON = 8;
const MARK_MAX_CHANGED_RATIO = 0.6;

function langFor(path: string, override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override.toLowerCase();
  }
  const ext = /\.([A-Za-z0-9+#]+)$/.exec(path);
  return ext ? ext[1]!.toLowerCase() : '';
}

/**
 * Marca el tramo cambiado dentro de un reemplazo 1:1, para que una edición de
 * un solo token (`recursive: true` → `false`) se lea de un vistazo.
 */
function markPair(del: DiffDocCodeRow, add: DiffDocCodeRow): void {
  const a = del.code;
  const b = add.code;
  const max = Math.min(a.length, b.length);

  let start = 0;
  while (start < max && a[start] === b[start]) {
    start += 1;
  }

  let tail = 0;
  while (
    tail < max - start &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  const changed = Math.max(aEnd - start, bEnd - start);
  if (changed <= 0) {
    return;
  }

  const longest = Math.max(a.length, b.length);
  if (longest - changed < MARK_MIN_COMMON) {
    return;
  }
  if (changed > longest * MARK_MAX_CHANGED_RATIO) {
    return;
  }

  del.mark = { start, end: aEnd };
  add.mark = { start, end: bEnd };
}

/**
 * Empareja cada borrado con la adición en el mismo desplazamiento de la corrida
 * siguiente, pero solo cuando ambas corridas miden lo mismo: es el caso en que
 * las líneas se alinean 1:1 y el resalte interno es fiable.
 */
function markRuns(rows: DiffDocRow[]): void {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.kind !== 'del') {
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d]!.kind === 'del') {
      d += 1;
    }
    let a = d;
    while (a < rows.length && rows[a]!.kind === 'add') {
      a += 1;
    }
    const dels = d - i;
    const adds = a - d;
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k += 1) {
        markPair(rows[i + k] as DiffDocCodeRow, rows[d + k] as DiffDocCodeRow);
      }
    }
    i = a - 1;
  }
}

/**
 * Parsea el cuerpo de un bloque ```diffdoc. Nunca lanza: lo que no entiende
 * vuelve como `error`, y el llamador pinta un bloque de código plano en vez de
 * enseñar una figura rota.
 */
export function parseDiffDoc(source: string): DiffDocBlock {
  const empty = (error: string): DiffDocBlock => ({
    path: '',
    lang: '',
    rows: [],
    added: 0,
    removed: 0,
    error,
  });

  const lines = source.replace(/\s+$/, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') {
    i += 1;
  }
  if (i >= lines.length) {
    return empty('bloque vacío');
  }

  const head = FILE_RE.exec(lines[i]!.trim());
  if (!head) {
    return empty('la primera línea debe ser `file <ruta>`');
  }
  const path = head[1]!;
  const lang = langFor(path, head[2]);
  i += 1;

  const rows: DiffDocRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;

  for (; i < lines.length; i += 1) {
    const raw = lines[i]!;

    const hunk = HUNK_RE.exec(raw.trim());
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = hunk[2] ? Number(hunk[2]) : oldNo;
      continue;
    }

    // Nota en prosa. Se queda donde se escribió, entre las líneas que explica.
    if (raw.startsWith('>')) {
      const text = raw.slice(1).trim();
      if (text.length > 0) {
        rows.push({ kind: 'note', text });
      }
      continue;
    }

    // Tramo elidido: avanza ambos contadores para que los números de abajo
    // sigan siendo ciertos.
    if (raw.startsWith('~')) {
      const count = Math.max(0, Number(raw.slice(1).trim()) || 0);
      rows.push({ kind: 'gap', count });
      oldNo += count;
      newNo += count;
      continue;
    }

    if (raw.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo, code: raw.slice(1) });
      newNo += 1;
      added += 1;
      continue;
    }

    if (raw.startsWith('-')) {
      rows.push({ kind: 'del', oldNo, newNo: null, code: raw.slice(1) });
      oldNo += 1;
      removed += 1;
      continue;
    }

    // Contexto. Es habitual que se pierda el espacio inicial de una línea en
    // blanco, así que una línea vacía cuenta como contexto y no se descarta.
    const code = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ kind: 'ctx', oldNo, newNo, code });
    oldNo += 1;
    newNo += 1;
  }

  if (!rows.some(row => row.kind === 'add' || row.kind === 'del')) {
    return empty('sin líneas + ni -');
  }

  markRuns(rows);
  return { path, lang, rows, added, removed };
}
