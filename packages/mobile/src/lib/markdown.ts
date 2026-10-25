/**
 * Puerto de las reglas de `packages/ui/src/components/Markdown.tsx` del
 * escritorio. Aquel emite strings de HTML; aquí hace falta un árbol, así que
 * el parseo se conserva y el renderizado cambia.
 *
 * Diferencia deliberada: la versión web encadena `.replace()` sobre HTML, lo
 * que le permite anidar sin esfuerzo. Aquí se tokeniza de verdad y se recurre,
 * porque una cadena de replaces no produce componentes anidables.
 */

export type InlineNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'code'; readonly value: string }
  | {
      readonly type: 'link';
      readonly url: string;
      readonly children: InlineNode[];
    }
  | { readonly type: 'session'; readonly label: string; readonly id: string }
  | { readonly type: 'snippet'; readonly label: string; readonly path: string }
  | { readonly type: 'image'; readonly alt: string; readonly url: string }
  | { readonly type: 'strong'; readonly children: InlineNode[] }
  | { readonly type: 'em'; readonly children: InlineNode[] }
  | { readonly type: 'strike'; readonly children: InlineNode[] };

export interface ListItem {
  readonly content: InlineNode[];
  /** Presente solo en listas de casillas. */
  readonly checked: boolean | null;
  /** Numeral en listas ordenadas. */
  readonly marker: string | null;
}

export type MarkdownBlock =
  | {
      readonly type: 'heading';
      readonly level: number;
      readonly content: InlineNode[];
    }
  | { readonly type: 'paragraph'; readonly content: InlineNode[] }
  | { readonly type: 'quote'; readonly content: InlineNode[] }
  | { readonly type: 'code'; readonly lang: string; readonly value: string }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly items: ListItem[];
    }
  | {
      readonly type: 'table';
      readonly headers: InlineNode[][];
      readonly rows: InlineNode[][][];
    }
  | { readonly type: 'rule' }
  | { readonly type: 'spacer' };

// Un solo barrido con alternativas: el orden importa, igual que el orden de
// los replaces del escritorio. La imagen va antes que el enlace porque `![` es
// un prefijo de `[`.
//
// Se guarda el patrón como texto, no como RegExp: `parseInline` es recursiva y
// una instancia compartida con flag `g` lleva `lastIndex` mutable. La llamada
// interna lo reinicia y el bucle externo reanuda desde el índice pisado — se
// queda encontrando el mismo match para siempre. Cada llamada crea la suya.
const INLINE_SOURCE = [
  '!\\[([^\\]]*)\\]\\(([^)]+)\\)', // 1 alt, 2 url
  '\\[([^\\]]+)\\]\\(codiby-session:([^)]+)\\)', // 3 label, 4 id
  '\\[([^\\]]+)\\]\\(codiby-snippet:([^)]+)\\)', // 5 label, 6 path
  '\\[([^\\]]+)\\]\\(([^)]+)\\)', // 7 label, 8 url
  '`([^`]+)`', // 9 code
  '\\*\\*\\*([\\s\\S]+?)\\*\\*\\*', // 10 bold+italic
  '\\*\\*([\\s\\S]+?)\\*\\*', // 11 bold
  '~~([\\s\\S]+?)~~', // 12 strike
  '\\*([\\s\\S]+?)\\*', // 13 italic
].join('|');

const URL_SOURCE = 'https?://[^\\s<>()"\']+';
const WORD = /\w/;

/** Enlaza URLs sueltas dentro de texto plano ya tokenizado. */
function autolink(value: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = new RegExp(URL_SOURCE, 'g');
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > last) {
      nodes.push({ type: 'text', value: value.slice(last, match.index) });
    }
    nodes.push({
      type: 'link',
      url: match[0],
      children: [{ type: 'text', value: match[0] }],
    });
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    nodes.push({ type: 'text', value: value.slice(last) });
  }
  return nodes;
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  let last = 0;
  let match: RegExpExecArray | null;

  const pushText = (value: string) => {
    if (value.length > 0) {
      nodes.push(...autolink(value));
    }
  };

  while ((match = pattern.exec(source)) !== null) {
    const [full] = match;

    // Itálica: el original usa lookbehind/lookahead para no partir
    // `snake_case*` ni multiplicaciones. Hermes lo soporta a medias, así que
    // se comprueban los bordes a mano.
    if (match[13] !== undefined) {
      const before = source[match.index - 1];
      const after = source[match.index + full.length];
      if (
        (before !== undefined && WORD.test(before)) ||
        (after !== undefined && WORD.test(after))
      ) {
        // Rebobinar es obligatorio: `exec` ya dejó `lastIndex` al final del
        // match rechazado, y ese tramo puede contener una itálica válida más
        // adelante. Sin esto, `snake_case*3 y *ok*` se come el `*ok*`.
        pattern.lastIndex = match.index + 1;
        continue;
      }
    }

    pushText(source.slice(last, match.index));

    if (match[1] !== undefined || match[2] !== undefined) {
      nodes.push({ type: 'image', alt: match[1] ?? '', url: match[2] ?? '' });
    } else if (match[3] !== undefined) {
      nodes.push({
        type: 'session',
        label: match[3],
        id: (match[4] ?? '').trim(),
      });
    } else if (match[5] !== undefined) {
      nodes.push({ type: 'snippet', label: match[5], path: match[6] ?? '' });
    } else if (match[7] !== undefined) {
      nodes.push({
        type: 'link',
        url: match[8] ?? '',
        children: parseInline(match[7]),
      });
    } else if (match[9] !== undefined) {
      // El código en línea no se re-parsea: dentro no hay formato.
      nodes.push({ type: 'code', value: match[9] });
    } else if (match[10] !== undefined) {
      nodes.push({
        type: 'strong',
        children: [{ type: 'em', children: parseInline(match[10]) }],
      });
    } else if (match[11] !== undefined) {
      nodes.push({ type: 'strong', children: parseInline(match[11]) });
    } else if (match[12] !== undefined) {
      nodes.push({ type: 'strike', children: parseInline(match[12]) });
    } else if (match[13] !== undefined) {
      nodes.push({ type: 'em', children: parseInline(match[13]) });
    }

    last = match.index + full.length;
  }

  pushText(source.slice(last));
  return nodes;
}

/** Texto plano de un tramo inline, para medir cuánto ocupa una celda. */
export function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map(node => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.value;
        case 'session':
        case 'snippet':
          return node.label;
        case 'image':
          return node.alt;
        default:
          return inlineText(node.children);
      }
    })
    .join('');
}

const WIDE_COLUMNS = 4;
const WIDE_CELL_CHARS = 40;

/**
 * ¿La tabla necesita más ancho del que da una burbuja?
 *
 * Es un barrido de líneas, no un parseo: solo cuenta separadores y mide
 * celdas. Se llama por cada mensaje al pintarlo, así que no vale la pena
 * construir el árbol entero para responder un booleano.
 */
export function hasWideTable(source: string): boolean {
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      continue;
    }
    const cells = parseRow(trimmed);
    if (cells.length >= WIDE_COLUMNS) {
      return true;
    }
    if (cells.some(cell => cell.length > WIDE_CELL_CHARS)) {
      return true;
    }
  }
  return false;
}

const HEADING = /^(#{1,6})\s+(.+)/;
const RULE = /^[-*_]{3,}\s*$/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)/;
const UNORDERED = /^\s*[-*+]\s+(.*)/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)/;
const ALIGN_ROW = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|$/;

function parseRow(row: string): string[] {
  return row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim());
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split('\n');
  const blocks: MarkdownBlock[] = [];

  let codeLines: string[] | null = null;
  let codeLang = '';
  let tableRows: string[] = [];
  let listItems: ListItem[] = [];
  let listOrdered = false;

  const closeList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: 'list', ordered: listOrdered, items: listItems });
      listItems = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length >= 2) {
      closeList();
      blocks.push({
        type: 'table',
        headers: parseRow(tableRows[0]!).map(parseInline),
        // La fila 1 es la de alineación y se descarta.
        rows: tableRows.slice(2).map(row => parseRow(row).map(parseInline)),
      });
    }
    tableRows = [];
  };

  const pushItem = (item: ListItem, ordered: boolean) => {
    if (listItems.length > 0 && listOrdered !== ordered) {
      closeList();
    }
    listOrdered = ordered;
    listItems.push(item);
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (codeLines !== null) {
        blocks.push({
          type: 'code',
          lang: codeLang,
          value: codeLines.join('\n'),
        });
        codeLines = null;
        codeLang = '';
        continue;
      }
      flushTable();
      closeList();
      codeLines = [];
      codeLang = line
        .trimStart()
        .replace(/^`+/, '')
        .trim()
        .split(/\s+/)[0]!
        .toLowerCase();
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (tableRows.length === 1 && ALIGN_ROW.test(trimmed)) {
        tableRows.push(line);
        continue;
      }
      tableRows.push(line);
      continue;
    }
    if (tableRows.length > 0) {
      flushTable();
    }

    if (trimmed === '') {
      closeList();
      blocks.push({ type: 'spacer' });
      continue;
    }

    if (RULE.test(trimmed)) {
      closeList();
      blocks.push({ type: 'rule' });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      closeList();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        content: parseInline(heading[2]!),
      });
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      closeList();
      blocks.push({
        type: 'quote',
        content: parseInline(line.replace(/^\s*>\s?/, '')),
      });
      continue;
    }

    const checkbox = line.match(CHECKBOX);
    if (checkbox) {
      pushItem(
        {
          content: parseInline(checkbox[2]!),
          checked: checkbox[1]!.toLowerCase() === 'x',
          marker: null,
        },
        false,
      );
      continue;
    }

    const unordered = line.match(UNORDERED);
    if (unordered) {
      pushItem(
        { content: parseInline(unordered[1]!), checked: null, marker: null },
        false,
      );
      continue;
    }

    const ordered = line.match(ORDERED);
    if (ordered) {
      pushItem(
        {
          content: parseInline(ordered[2]!),
          checked: null,
          marker: ordered[1]!,
        },
        true,
      );
      continue;
    }

    closeList();
    blocks.push({ type: 'paragraph', content: parseInline(line) });
  }

  if (codeLines !== null) {
    blocks.push({ type: 'code', lang: codeLang, value: codeLines.join('\n') });
  }
  flushTable();
  closeList();

  return blocks;
}
