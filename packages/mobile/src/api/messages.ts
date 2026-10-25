import { ServerError, requestJson } from './client';
import type { ChatMessage, MessageImage, MessagePage } from './types';
import { stripAnsi } from '../lib/ansi';
import { readReply } from '../lib/messageReply';

/** El bridge pagina hacia atrás; sin `before_seq` asume 0 y devuelve vacío. */
export const LATEST_SEQ = Number.MAX_SAFE_INTEGER;

/** Lo que cabe en un par de pantallas; más se pide al subir. */
const DEFAULT_LIMIT = 30;

const ROLES = new Set(['user', 'assistant', 'system']);

/**
 * Los mensajes que llegan por WebSocket no siempre traen `seq` — se difunden
 * en el momento de crearse, antes de que la persistencia les asigne uno. Como
 * la lista conserva el orden de llegada y nunca se re-ordena, un 0 aquí es
 * inocuo: solo `loadOlder` usa seq, y lee el del primer mensaje paginado.
 */
export function parseLiveMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return toChatMessage({ seq: 0, ...raw });
}

/** Tope de lo que se guarda en memoria. Pintar más no aporta nada. */
const MAX_STORED_CHARS = 8_000;

/**
 * Una tirada así de larga sin espacios no es prosa: es base64, un hash o un
 * volcado binario. Da igual cuánto se recorte — Android no tiene dónde partir
 * la línea e intenta maquetarla entera, lo que dispara la memoria.
 */
const UNBREAKABLE_RUN = 400;

function longestRunWithoutSpace(text: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i]!)) {
      current = 0;
    } else {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    }
  }
  return longest;
}

/**
 * Normaliza el contenido antes de guardarlo. Los blobs se sustituyen por una
 * etiqueta: si nunca se van a leer, no hay razón para arrastrarlos en el
 * estado ni para dárselos al motor de texto.
 */
function normalizeContent(raw: string): string {
  const kb = Math.round(raw.length / 1024);

  if (longestRunWithoutSpace(raw.slice(0, 4000)) > UNBREAKABLE_RUN) {
    const isImage =
      raw.includes('"type":"image"') || raw.includes('data:image');
    return isImage ? `[imagen · ${kb} KB]` : `[datos · ${kb} KB]`;
  }

  const clean = stripAnsi(raw);
  // The citation must not consume the user's existing 8,000-character allowance.
  const body = readReply(clean);
  const limit = MAX_STORED_CHARS + clean.length - body.text.length;
  return clean.length > limit
    ? `${clean.slice(0, limit)}\n\n… (+${kb} KB recortados)`
    : clean;
}

/** Un base64 mayor que esto se descarta: no cabe mostrarlo con sentido. */
const MAX_IMAGE_CHARS = 3_000_000;
const MAX_IMAGES = 4;

function toImage(value: unknown): MessageImage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const mediaType = raw.media_type ?? raw.mediaType;
  const data = raw.data;
  if (
    typeof mediaType !== 'string' ||
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length > MAX_IMAGE_CHARS
  ) {
    return null;
  }
  return { mediaType, data };
}

interface ExtractedContent {
  readonly text: string;
  readonly images: MessageImage[];
}

/**
 * Algunos resultados de herramienta llegan como un array de bloques al estilo
 * de la API de Anthropic. Separarlos aquí sirve para dos cosas: saca el base64
 * del texto, y deja de mostrar el JSON crudo cuando los bloques son de texto.
 */
function extractBlocks(content: string): ExtractedContent {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('[')) {
    return { text: content, images: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: content, images: [] };
  }
  if (!Array.isArray(parsed)) {
    return { text: content, images: [] };
  }

  const texts: string[] = [];
  const images: MessageImage[] = [];

  for (const block of parsed) {
    if (typeof block !== 'object' || block === null) {
      return { text: content, images: [] };
    }
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      texts.push(record.text);
    } else if (record.type === 'image') {
      const image = toImage(record.source);
      if (image !== null) {
        images.push(image);
      }
    } else {
      // Un bloque que no se reconoce: mejor devolver el original que perderlo.
      return { text: content, images: [] };
    }
  }

  return { text: texts.join('\n'), images: images.slice(0, MAX_IMAGES) };
}

function toChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.seq !== 'number') {
    return null;
  }

  const role =
    typeof raw.role === 'string' && ROLES.has(raw.role) ? raw.role : 'system';

  const extracted = extractBlocks(
    typeof raw.content === 'string' ? raw.content : '',
  );
  // Las del campo `images` van primero: son adjuntos explícitos del usuario.
  const attached = Array.isArray(raw.images)
    ? raw.images
        .map(toImage)
        .filter((image): image is MessageImage => image !== null)
    : [];

  return {
    id: raw.id,
    role: role as ChatMessage['role'],
    content: normalizeContent(extracted.text),
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
    seq: raw.seq,
    toolName: typeof raw.toolName === 'string' ? raw.toolName : null,
    toolInput:
      typeof raw.toolInput === 'object' && raw.toolInput !== null
        ? (raw.toolInput as Record<string, unknown>)
        : null,
    images: [...attached, ...extracted.images].slice(0, MAX_IMAGES),
    isThinking: raw.isThinking === true,
    thinkingRedacted: raw.thinkingRedacted === true,
    isToolResult: raw.isToolResult === true,
    toolUseId: typeof raw.toolUseId === 'string' ? raw.toolUseId : null,
  };
}

/**
 * Encola un mensaje del usuario en la sesión. El bridge responde en cuanto lo
 * acepta; la respuesta del agente llega después, en una lectura posterior.
 */
export function sendMessage(
  baseUrl: string,
  sessionId: string,
  token: string,
  text: string,
  images: MessageImage[] = [],
): Promise<void> {
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
    () => undefined,
    token,
    {
      method: 'POST',
      // Con 8 s, una red lenta daba el envío por fallido aunque sí llegaba, y
      // el mensaje se podía volver a mandar duplicado.
      timeoutMs: 30_000,
      body: {
        text,
        // El bridge espera `media_type`, no `mediaType`.
        images: images.map(image => ({
          media_type: image.mediaType,
          data: image.data,
        })),
      },
    },
  );
}

/**
 * Devuelve una ventana de mensajes anteriores a `beforeSeq`, ordenados de más
 * viejo a más nuevo.
 */
export function fetchMessages(
  baseUrl: string,
  sessionId: string,
  token: string,
  beforeSeq: number = LATEST_SEQ,
  limit: number = DEFAULT_LIMIT,
): Promise<MessagePage> {
  const path = `/sessions/${encodeURIComponent(
    sessionId,
  )}/messages?before_seq=${beforeSeq}&limit=${limit}`;

  return requestJson(
    baseUrl,
    path,
    body => {
      if (typeof body !== 'object' || body === null) {
        throw new ServerError('Respuesta inesperada en /messages');
      }
      const raw = body as Record<string, unknown>;
      if (!Array.isArray(raw.messages)) {
        throw new ServerError('Respuesta inesperada en /messages');
      }
      const messages = raw.messages
        .map(toChatMessage)
        .filter((message): message is ChatMessage => message !== null)
        .sort((a, b) => a.seq - b.seq);

      return { messages, hasMore: raw.hasMore === true };
    },
    token,
  );
}

export interface NewerPage extends MessagePage {
  /**
   * `true` si llegaron más de los que caben y lo nuevo no se puede pegar a lo
   * que había: hay que reemplazar. `null` si el bridge no entiende `after_seq`
   * y devolvió la última página de siempre.
   */
  readonly gap: boolean | null;
}

/**
 * Tope de lo que se pide al ponerse al día. Pequeño a propósito: los mensajes
 * con salidas de herramientas pesan mucho —200 de una sesión real eran 3,8 MB,
 * 30 son 24 KB— y por el Funnel eso eran segundos de «sincronizando…». Si
 * llegaron más, el bridge avisa del hueco y se reemplaza por los 30 últimos;
 * lo anterior se pide al subir, como siempre.
 */
const CATCH_UP_LIMIT = 30;

/**
 * Solo lo que llegó después de `afterSeq`. Es lo que se pide al abrir un chat
 * que ya está guardado en el teléfono: en el caso normal son cero o unos pocos
 * mensajes, no la página entera de antes.
 */
export function fetchNewerMessages(
  baseUrl: string,
  sessionId: string,
  token: string,
  afterSeq: number,
): Promise<NewerPage> {
  const path = `/sessions/${encodeURIComponent(
    sessionId,
  )}/messages?before_seq=${LATEST_SEQ}&after_seq=${afterSeq}&limit=${CATCH_UP_LIMIT}`;

  return requestJson(
    baseUrl,
    path,
    body => {
      if (typeof body !== 'object' || body === null) {
        throw new ServerError('Respuesta inesperada en /messages');
      }
      const raw = body as Record<string, unknown>;
      if (!Array.isArray(raw.messages)) {
        throw new ServerError('Respuesta inesperada en /messages');
      }
      const messages = raw.messages
        .map(toChatMessage)
        .filter((message): message is ChatMessage => message !== null)
        .sort((a, b) => a.seq - b.seq);

      return {
        messages,
        hasMore: raw.hasMore === true,
        gap: typeof raw.gap === 'boolean' ? raw.gap : null,
      };
    },
    token,
  );
}
