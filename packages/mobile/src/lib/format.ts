const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const;

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Sello de tiempo estilo lista de chats: hora si es hoy, "Ayer", el día de la
 * semana dentro de la última semana, y fecha corta más allá.
 */
export function formatChatTimestamp(
  timestamp: number,
  now: Date = new Date(),
): string {
  if (timestamp <= 0) {
    return '';
  }

  const date = new Date(timestamp);

  if (isSameDay(date, now)) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  const yesterday = new Date(now.getTime() - DAY_MS);
  if (isSameDay(date, yesterday)) {
    return 'Ayer';
  }

  if (now.getTime() - timestamp < 7 * DAY_MS) {
    return WEEKDAYS[date.getDay()] ?? '';
  }

  const year = String(date.getFullYear()).slice(-2);
  return `${date.getDate()}/${date.getMonth() + 1}/${year}`;
}

/**
 * Sello completo, para cuando se pide a propósito. Siempre lleva la hora — que
 * es justo lo que se estaba buscando al tocar — y añade la fecha solo si no
 * es de hoy.
 */
export function formatFullTimestamp(
  timestamp: number,
  now: Date = new Date(),
): string {
  if (timestamp <= 0) {
    return '';
  }

  const date = new Date(timestamp);
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

  if (isSameDay(date, now)) {
    return time;
  }

  const yesterday = new Date(now.getTime() - DAY_MS);
  if (isSameDay(date, yesterday)) {
    return `ayer ${time}`;
  }

  const year = String(date.getFullYear()).slice(-2);
  return `${date.getDate()}/${date.getMonth() + 1}/${year} ${time}`;
}

/** Iniciales para el avatar: hasta dos, a partir de las palabras del nombre. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

const AVATAR_COLORS = [
  '#0f766e',
  '#b45309',
  '#4338ca',
  '#be123c',
  '#15803d',
  '#7c3aed',
  '#0369a1',
  '#a21caf',
] as const;

/** Color estable por id: la misma sesión siempre sale del mismo color. */
export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 2147483647;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}
