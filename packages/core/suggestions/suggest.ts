/**
 * Respuestas sugeridas para el cliente móvil.
 *
 * Tres chips que el usuario puede enviar de un toque al terminar un turno. Se
 * ejecuta como un `query()` de un solo disparo —sin herramientas y sin el
 * contexto de la sesión— por la misma razón que el juez de requisitos: lo que
 * se le pide es redactar tres frases, no razonar sobre el repositorio.
 *
 * Reemplazar `systemPrompt` es lo que hace esto viable. Con el prompt por
 * defecto de Claude Code, una llamada equivalente costaba 23 000 tokens de
 * entrada y 40 s; aquí la entrada es el mensaje y poco más.
 */

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_BIN } from '../config/config';
import { log } from '../lib/logger';

const TIMEOUT_MS = 25_000;

/** Ancho del chip. Más de esto obliga a desplazar para ver el tercero. */
const MAX_CHARS = 30;

/**
 * Tope duro antes de recortar. Más ancho que `MAX_CHARS` a propósito: el
 * objetivo que se le pide al modelo es 30, pero una de 34 sigue siendo útil y
 * cortarla ahí la volvería un muñón.
 */
const HARD_MAX = 38;

/** Recorte del mensaje que se manda: el final es donde está la conclusión. */
const MAX_INPUT_CHARS = 2_000;

/** Corta en el último espacio para no partir una palabra a la mitad. */
function clip(text: string): string {
  const cut = text.slice(0, HARD_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > HARD_MAX - 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const SUGGESTION_KINDS = ['continuar', 'cuestionar', 'redirigir'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export type Suggestion = { kind: SuggestionKind; text: string };

const SYSTEM_PROMPT = [
  'Eres el USUARIO de una sesión de programación con un agente, no el agente.',
  '',
  'Te doy el último mensaje del agente. Escribe TRES respuestas que el usuario',
  'podría enviar con un solo toque. Una de cada tipo, siempre en este orden:',
  '',
  '1. continuar — Acepta lo hecho y empuja al siguiente paso concreto.',
  '   Nunca "ok", "gracias" ni "perfecto": nombra la acción que sigue.',
  '2. cuestionar — Pon en duda una afirmación o decisión específica del mensaje.',
  '   Si el agente no afirmó nada discutible, pregunta por lo que NO dijo.',
  '3. redirigir — Cambia el rumbo sin tirar el trabajo: acota el alcance, quita',
  '   una parte o sustituye el enfoque. No es rechazar; es corregir.',
  '',
  'VOZ',
  'Escribe como escribe el usuario, no como escribiría un asistente:',
  '- español, minúsculas, sin signos de apertura, sin cortesías',
  '- imperativo y directo: "quita el anillo", no "¿podrías quitar el anillo?"',
  `- máximo ${MAX_CHARS} caracteres. Es un chip, no una frase. Apunta a menos de 22.`,
  '',
  'ANCLAJE',
  'Cada respuesta debe agarrarse de algo LITERAL del mensaje: un nombre de',
  'archivo, una decisión, un número, un pendiente que el agente mencionó.',
  'Si las tres funcionarían igual pegadas en cualquier otra conversación,',
  'están mal.',
  '',
  'PROHIBIDO',
  '- Pedir algo que el agente ya hizo en ese mismo mensaje.',
  '- Repetir la misma idea en dos de las tres.',
  '- Preguntas de cortesía ("¿algo más?") o de relleno ("¿está listo?").',
  '- Inventar archivos, comandos o hechos que no aparecen en el mensaje.',
  '',
  'SALIDA',
  'Solo JSON, sin texto alrededor:',
  '[{"tipo":"continuar","texto":"..."},',
  ' {"tipo":"cuestionar","texto":"..."},',
  ' {"tipo":"redirigir","texto":"..."}]',
  '',
  'EJEMPLO',
  'Mensaje del agente:',
  '"Listo. Dejé el cutoff fijo en constants.ts en vez de calcularlo por tenant:',
  'el cálculo dependía de billingDay, un campo que no existe en staging.',
  'Las 14 pruebas pasan."',
  '',
  'Respuesta:',
  '[{"tipo":"continuar","texto":"sigue con el deploy"},',
  ' {"tipo":"cuestionar","texto":"y en prod sí existe?"},',
  ' {"tipo":"redirigir","texto":"mejor no lo fijes"}]',
  '',
  `Fíjate en el largo: 19, 20 y 17 caracteres. Ese es el tamaño correcto.`,
  `Antes de responder, cuenta los caracteres de cada texto. Si alguno pasa de`,
  `${MAX_CHARS}, reescríbelo más corto. Una sugerencia larga no cabe y se descarta.`,
].join('\n');

/**
 * Saca el arreglo de la respuesta tolerando cercas de código y prosa suelta,
 * igual que el juez: el modelo a veces envuelve el JSON aunque se le pida que
 * no lo haga, y eso no debería costar la sugerencia entera.
 */
function parseSuggestions(text: string): Suggestion[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Suggestion[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as { tipo?: unknown; texto?: unknown };
    const kind = SUGGESTION_KINDS.find((k) => k === raw.tipo);
    const text = typeof raw.texto === 'string' ? raw.texto.trim() : '';
    if (kind && text.length > 0) {
      // Se degrada en vez de descartar. Descartar las que se pasaban dejaba la
      // fila vacía en dos de cada tres mensajes: el modelo escribía sugerencias
      // buenas de 60 caracteres y el usuario no veía ninguna.
      out.push({ kind, text: text.length > HARD_MAX ? clip(text) : text });
    }
  }
  // Una sola por tipo, en el orden fijo que espera la interfaz.
  return SUGGESTION_KINDS.map((kind) => out.find((s) => s.kind === kind)).filter(
    (s): s is Suggestion => s !== undefined,
  );
}

/**
 * Devuelve hasta tres sugerencias. Un fallo —timeout, JSON roto, subproceso
 * caído— devuelve un arreglo vacío: la fila de chips simplemente no aparece,
 * que es mejor que romper la pantalla del chat.
 */
export async function suggestReplies(opts: {
  lastMessage: string;
  cwd: string;
  model?: string;
}): Promise<Suggestion[]> {
  const trimmed = opts.lastMessage.trim();
  if (trimmed.length === 0) return [];

  // Se manda la cola y no la cabeza: si el mensaje es largo, lo que hay que
  // responder está al final.
  const excerpt =
    trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text' as const, text: `MENSAJE DEL AGENTE:\n${excerpt}` }] as any,
    },
    parent_tool_use_id: null,
    session_id: undefined,
  };

  // Un iterable de un solo mensaje: el SDK cierra la entrada cuando el
  // generador termina, y eso es lo que lo hace de un disparo.
  async function* once() {
    yield message;
  }

  const runtime = query({
    prompt: once(),
    options: {
      cwd: opts.cwd,
      model: opts.model ?? 'haiku',
      maxTurns: 1,
      allowedTools: [],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      systemPrompt: SYSTEM_PROMPT,
      // Las tres juntas son lo que hace barata la llamada. Medido en este
      // repositorio: 16 664 tokens de entrada sin ellas, 14 657 con ellas —
      // 7 servidores MCP y 107 herramientas bajan a 0 y 30. Las 30 que quedan
      // son las de Claude Code y el SDK no deja quitarlas.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      // Sin esto la llamada tardaba 30 s: el modelo gastaba 2 600 tokens
      // razonando para producir tres frases de veinte caracteres. Redactar
      // chips no es una tarea que se beneficie de pensar.
      thinking: { type: 'disabled' },
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    },
  });

  const timeout = new Promise<Suggestion[]>((resolve) => {
    setTimeout(() => resolve([]), TIMEOUT_MS);
  });

  const answered = (async (): Promise<Suggestion[]> => {
    let text = '';
    try {
      for await (const msg of runtime) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message.content as any[]) ?? []) {
            if (block?.type === 'text') text += block.text;
          }
        } else if (msg.type === 'result') {
          const result = (msg as { result?: string }).result;
          if (result) text = result;
        }
      }
    } catch (error) {
      log(`[suggestions] ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    return parseSuggestions(text);
  })();

  const suggestions = await Promise.race([answered, timeout]);
  try {
    await runtime.interrupt?.();
  } catch {}
  return suggestions;
}
