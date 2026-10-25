/**
 * Secuencias de escape ANSI: CSI (colores, cursor) y OSC (títulos, enlaces).
 * El bridge reenvía la salida cruda de las herramientas, así que el contenido
 * llega con los códigos que la terminal interpretaría.
 */
// Los caracteres de control son justamente lo que hay que quitar aquí.
/* eslint-disable no-control-regex */
const CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
/* eslint-enable no-control-regex */

export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '');
}

export interface TruncatedText {
  readonly text: string;
  readonly isTruncated: boolean;
}

/** Recorta texto largo por líneas y por caracteres, para no colgar la lista. */
export function truncate(
  text: string,
  maxChars: number = 900,
  maxLines: number = 20,
): TruncatedText {
  const lines = text.split('\n');
  const byLines = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text;
  const result = byLines.length > maxChars ? byLines.slice(0, maxChars) : byLines;

  return {
    text: result.trimEnd(),
    isTruncated: result.length < text.length,
  };
}
