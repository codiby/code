import { requestJson } from './client';

export const SUGGESTION_KINDS = ['continuar', 'cuestionar', 'redirigir'] as const;

export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export interface Suggestion {
  readonly kind: SuggestionKind;
  readonly text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Tres respuestas que se pueden enviar de un toque, generadas por el bridge a
 * partir del último mensaje del agente.
 *
 * Un fallo devuelve un arreglo vacío en vez de lanzar: la fila de chips es un
 * extra y no debe poder tumbar la pantalla del chat. El bridge ya responde 200
 * con `[]` cuando no puede generarlas, así que aquí solo queda cubrir la red.
 */
export async function fetchSuggestions(
  baseUrl: string,
  token: string,
  sessionId: string,
): Promise<Suggestion[]> {
  try {
    return await requestJson(
      baseUrl,
      `/sessions/${encodeURIComponent(sessionId)}/suggestions`,
      body => {
        const raw = asRecord(body);
        const list = raw?.suggestions;
        if (!Array.isArray(list)) {
          return [];
        }
        const out: Suggestion[] = [];
        for (const item of list) {
          const entry = asRecord(item);
          const kind = SUGGESTION_KINDS.find(k => k === entry?.kind);
          const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
          if (kind !== undefined && text.length > 0) {
            out.push({ kind, text });
          }
        }
        return out;
      },
      token,
    );
  } catch {
    return [];
  }
}
