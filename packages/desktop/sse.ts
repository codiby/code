/** Server-sent events, as the bridge streams them (no Electron imports, so it is testable). */

/** Parse one server-sent-events chunk stream into `data:` payloads. */
export function takeEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  let cut: number;
  while ((cut = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (data) events.push(data);
  }
  return { events, rest };
}
