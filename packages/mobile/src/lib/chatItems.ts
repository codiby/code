import type { ChatMessage } from '../api/types';

export type GroupEntry =
  | { readonly kind: 'tool'; readonly call: ChatMessage; readonly output: ChatMessage | null }
  | { readonly kind: 'thinking'; readonly message: ChatMessage };

export type ChatItem =
  | {
      readonly kind: 'message';
      readonly key: string;
      readonly message: ChatMessage;
      /** Herramientas que provocó este mensaje, colgadas como pie. */
      group: GroupEntry[] | null;
    }
  /** Grupo sin mensaje del que colgar: arranca el hilo o sigue al usuario. */
  | { readonly kind: 'group'; readonly key: string; readonly entries: GroupEntry[] }
  /**
   * Un mockup escrito en el hilo. Va suelto y no dentro del grupo: lo que
   * produce no es un resultado que se lea, es una pantalla que se mira, y
   * plegado detrás de «6 herramientas» había que ir a buscarlo.
   */
  | {
      readonly kind: 'mockup';
      readonly key: string;
      readonly name: string;
      readonly call: ChatMessage;
    };

/**
 * Heurística para lo guardado antes de leer `isToolResult` (el campo no
 * existe): un mensaje del asistente sin herramienta ni razonamiento justo
 * detrás de una llamada es su salida. Con la marca presente no se adivina.
 */
function isLegacyToolOutput(message: ChatMessage | undefined): boolean {
  return (
    message !== undefined &&
    message.isToolResult === undefined &&
    message.role === 'assistant' &&
    message.toolName === null &&
    !message.isThinking
  );
}

/**
 * Empareja cada llamada de herramienta con su salida y agrupa lo que va
 * seguido, incluidos los bloques de razonamiento intercalados.
 *
 * El emparejado va por adyacencia porque `parentToolUseId` llega vacío — lo
 * comprobé sobre 200 mensajes reales: 0 de 69 llamadas lo traían.
 *
 * Un razonamiento suelto, sin herramientas alrededor, no se agrupa: se queda
 * como su propia fila, que es donde el resumen de una línea tiene sentido.
 */
export function buildChatItems(messages: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let group: GroupEntry[] = [];

  /**
   * Salidas por el id de su llamada. Cuando el agente lanza varias
   * herramientas a la vez llegan llamada, llamada, salida, salida: por
   * adyacencia solo la primera encontraba la suya y las demás se pintaban como
   * burbujas con el archivo entero dentro.
   */
  const outputs = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.isToolResult === true && message.toolUseId != null) {
      outputs.set(message.toolUseId, message);
    }
  }

  /**
   * Las herramientas cuelgan del mensaje que las provocó. Solo del asistente:
   * atarlas a una burbuja del usuario diría que las pidió él explícitamente.
   * Si no hay de quién colgar, el grupo va suelto.
   */
  const flush = () => {
    if (group.length === 0) {
      return;
    }
    const previous = items[items.length - 1];
    if (
      previous !== undefined &&
      previous.kind === 'message' &&
      previous.message.role === 'assistant' &&
      previous.group === null
    ) {
      previous.group = group;
    } else {
      const first = group[0]!;
      const key = first.kind === 'tool' ? first.call.id : first.message.id;
      items.push({ kind: 'group', key, entries: group });
    }
    group = [];
  };

  /** ¿Viene una herramienta después de esta tanda de razonamientos? */
  const toolFollows = (from: number): boolean => {
    for (let i = from; i < messages.length; i += 1) {
      const candidate = messages[i]!;
      if (candidate.toolName !== null) {
        return true;
      }
      if (!candidate.isThinking) {
        return false;
      }
    }
    return false;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    if (message.isThinking) {
      // Se une al grupo si ya hay uno abierto, o si lo que sigue son
      // herramientas: en ambos casos es parte de la misma tanda de trabajo.
      if (group.length > 0 || toolFollows(index + 1)) {
        group.push({ kind: 'thinking', message });
      } else {
        flush();
        items.push({ kind: 'message', key: message.id, message, group: null });
      }
      continue;
    }

    // Una salida nunca es una burbuja: o ya la recogió su llamada, o su
    // llamada quedó fuera de la página cargada y no hay dónde colgarla.
    if (message.isToolResult === true) {
      continue;
    }

    if (message.toolName === null) {
      flush();
      items.push({ kind: 'message', key: message.id, message, group: null });
      continue;
    }

    const byId = outputs.get(message.id);
    const next = messages[index + 1];
    // Sin marca (lo guardado antes de leerla), se empareja por adyacencia.
    const adjacent = byId === undefined && isLegacyToolOutput(next);
    const output = byId ?? (adjacent ? next! : null);
    const hasOutput = adjacent;

    // El mockup corta la tanda: lo anterior se cierra, él sale como fila
    // propia y lo que venga detrás abre un grupo nuevo. Su salida —«rendered
    // and saved»— se descarta: la tarjeta ya dice lo mismo y mejor.
    const mockup = mockupNameOf(message);
    if (mockup !== null) {
      flush();
      items.push({
        kind: 'mockup',
        key: message.id,
        name: mockup,
        call: message,
      });
      if (hasOutput) {
        index += 1;
      }
      continue;
    }

    group.push({ kind: 'tool', call: message, output });
    if (hasOutput) {
      index += 1;
    }
  }

  flush();
  return items;
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
const QUERY_KEYS = ['query', 'pattern'] as const;

function stringField(input: Record<string, unknown> | null, key: string): string | null {
  if (input === null) {
    return null;
  }
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function basename(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Las herramientas MCP llegan como `mcp__<servidor>__<accion>`, sin
 * `description` ni comando. Sin limpiarlas, ese identificador crudo es lo
 * único que se ve en la fila.
 */
export function shortToolName(name: string): string {
  const action = name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  return action.replace(/_/g, ' ');
}

export interface ToolSummary {
  readonly title: string;
  readonly detail: string | null;
}

/**
 * Nombre del mockup si la llamada lo escribió. El bridge lo guarda como
 * recurso de la sesión, así que basta el nombre para poder abrirlo después.
 */
export function mockupNameOf(call: ChatMessage): string | null {
  if (call.toolName === null || !call.toolName.endsWith('mockup_write')) {
    return null;
  }
  return stringField(call.toolInput, 'name');
}

export function summarizeTool(call: ChatMessage): ToolSummary {
  const input = call.toolInput;
  const name = shortToolName(call.toolName ?? 'Herramienta');

  const description = stringField(input, 'description');
  const command = stringField(input, 'command');

  if (command !== null) {
    return { title: description ?? name, detail: command };
  }

  for (const key of PATH_KEYS) {
    const path = stringField(input, key);
    if (path !== null) {
      return { title: description ?? basename(path), detail: path };
    }
  }

  for (const key of QUERY_KEYS) {
    const query = stringField(input, key);
    if (query !== null) {
      return { title: description ?? name, detail: query };
    }
  }

  return { title: description ?? name, detail: null };
}

export type ResultTone = 'ok' | 'bad' | 'muted';

export interface ToolResult {
  readonly label: string;
  readonly tone: ResultTone;
}

const FAILED = /Tests?:\s+(?:\d+\s+\w+,\s+)*?(\d+)\s+failed/i;
const PASSED = /(\d+)\s+passed/i;

function countLines(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/**
 * Solo se emite un veredicto cuando el patrón es inequívoco. Para un comando
 * cualquiera se cae al conteo de líneas: es honesto y siempre calculable.
 */
export function summarizeResult(
  call: ChatMessage,
  output: ChatMessage | null,
): ToolResult | null {
  const oldString = stringField(call.toolInput, 'old_string');
  const newString = stringField(call.toolInput, 'new_string');
  if (oldString !== null || newString !== null) {
    const removed = oldString === null ? 0 : countLines(oldString);
    const added = newString === null ? 0 : countLines(newString);
    return { label: `+${added} −${removed}`, tone: 'ok' };
  }

  if (output === null) {
    return null;
  }

  const failed = output.content.match(FAILED);
  if (failed !== null && Number(failed[1]) > 0) {
    return { label: `${failed[1]} ✕`, tone: 'bad' };
  }

  const passed = output.content.match(PASSED);
  if (passed !== null && failed === null) {
    return { label: `${passed[1]} ✓`, tone: 'ok' };
  }

  const lines = countLines(output.content);
  return lines === 0 ? null : { label: String(lines), tone: 'muted' };
}

/** Etiqueta con la que se identifica al razonamiento dentro del resumen. */
export const THINKING_LABEL = 'pensó';

export interface GroupSummary {
  /** `Bash ×2 · Edit · pensó`, en orden de aparición. */
  readonly label: string;
  /** Nombres distintos, para los puntos de color. */
  readonly kinds: string[];
  readonly elapsed: string | null;
  readonly failures: number;
}

/**
 * Resumen en una línea. Decir *qué* se usó, y no solo cuántas veces, es lo que
 * permite saltarse el bloque sin abrirlo.
 */
export function summarizeGroup(entries: GroupEntry[]): GroupSummary {
  const order: string[] = [];
  const counts = new Map<string, number>();
  let failures = 0;

  for (const entry of entries) {
    const name =
      entry.kind === 'thinking'
        ? THINKING_LABEL
        : shortToolName(entry.call.toolName ?? 'Herramienta');

    if (!counts.has(name)) {
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);

    if (
      entry.kind === 'tool' &&
      summarizeResult(entry.call, entry.output)?.tone === 'bad'
    ) {
      failures += 1;
    }
  }

  const label = order
    .map(name => {
      const times = counts.get(name) ?? 1;
      return times > 1 ? `${name} ×${times}` : name;
    })
    .join(' · ');

  const times = entries.map(entry =>
    entry.kind === 'thinking' ? entry.message.timestamp : entry.call.timestamp,
  );
  const first = times[0] ?? 0;
  const lastEntry = entries[entries.length - 1];
  const last =
    lastEntry === undefined
      ? 0
      : lastEntry.kind === 'thinking'
        ? lastEntry.message.timestamp
        : (lastEntry.output?.timestamp ?? lastEntry.call.timestamp);

  const seconds = Math.round((last - first) / 1000);
  const elapsed =
    first > 0 && seconds > 0
      ? seconds < 60
        ? `${seconds} s`
        : `${Math.round(seconds / 60)} min`
      : null;

  return { label, kinds: order, elapsed, failures };
}
