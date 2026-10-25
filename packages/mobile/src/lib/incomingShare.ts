import { NativeModules } from 'react-native';
import { requestJson } from '../api/client';
import { sendMessage } from '../api/messages';
import { parseSessionList } from '../api/sessions';
import type { MessageImage, SessionSummary } from '../api/types';
import type { ServerColor } from '../config/servers';

export interface ShareHost {
  readonly id: string;
  readonly name: string;
  readonly color?: ServerColor;
  readonly urls: string[];
  readonly token: string;
}
export interface IncomingShare {
  readonly config: string;
  readonly snapshot: string;
  readonly text: string;
  readonly images: MessageImage[];
}
export interface ShareChats {
  readonly hosts: ShareHost[];
  readonly sessions: SessionSummary[];
  readonly pinnedIds: string[];
  readonly previews: Record<string, string>;
}

export function parseShareChats(payload: IncomingShare): ShareChats {
  const config = JSON.parse(payload.config);
  if (config.version !== 1 || !Array.isArray(config.servers)) {
    throw new Error('Abre Codiby Code para sincronizar tus hosts.');
  }
  const hosts: ShareHost[] = config.servers.filter(
    (host: ShareHost) =>
      typeof host.id === 'string' &&
      typeof host.token === 'string' &&
      Array.isArray(host.urls) &&
      host.urls.length > 0,
  );
  const rows = JSON.parse(payload.snapshot) as Record<string, unknown>[];
  const sessions = hosts.flatMap(host =>
    parseSessionList(
      rows
        .filter(row => row.serverId === host.id)
        .map(row => ({ ...row, status: 'open' })),
      host.id,
    ),
  );
  const known = new Set(sessions.map(session => session.key));
  const pinnedIds = rows
    .filter(row => row.pinned === true)
    .sort((a, b) => Number(a.pinOrder ?? -1) - Number(b.pinOrder ?? -1))
    .map(row => `${row.serverId}:${row.id}`)
    .filter(key => known.has(key));
  const previews = Object.fromEntries(
    rows.map(row => [
      `${row.serverId}:${row.id}`,
      typeof row.preview === 'string' ? row.preview : '',
    ]),
  );
  return { hosts, sessions, pinnedIds, previews };
}

export function sortShareChats(
  sessions: SessionSummary[],
  pinnedIds: string[],
  query: string,
): SessionSummary[] {
  const fold = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const needle = fold(query.trim());
  return sessions
    .filter(
      session =>
        session.isOpen &&
        fold(`${session.name} ${session.folder}`).includes(needle),
    )
    .sort((a, b) => {
      const pins = pinnedIds.indexOf(b.key) - pinnedIds.indexOf(a.key);
      return pins || b.updatedAt - a.updatedAt;
    });
}

/** Solo las lecturas compiten. El POST se realiza una única vez. */
export async function fetchShareHost(
  host: ShareHost,
): Promise<{ sessions: SessionSummary[]; baseUrl: string }> {
  return Promise.any(
    host.urls.map(async baseUrl => ({
      baseUrl,
      sessions: await requestJson(
        baseUrl,
        '/sessions',
        body => parseSessionList(body, host.id),
        host.token,
        { timeoutMs: 6000 },
      ),
    })),
  );
}

export async function sendIncomingShare(
  host: ShareHost,
  session: SessionSummary,
  text: string,
  images: MessageImage[],
): Promise<void> {
  const live = await fetchShareHost(host);
  if (!live.sessions.some(item => item.id === session.id && item.isOpen)) {
    throw new Error('El chat ya no está activo. Actualiza la lista.');
  }
  try {
    await sendMessage(live.baseUrl, session.id, host.token, text, images);
  } catch {
    throw new Error(
      'No se confirmó el envío. Revisa el chat antes de reintentar para evitar duplicarlo.',
    );
  }
}

export const incomingShare = {
  read: (requestId: string): Promise<IncomingShare> =>
    NativeModules.ShareTargets.read(requestId),
  finish: (requestId: string, sent: boolean): Promise<void> =>
    NativeModules.ShareTargets.finish(requestId, sent),
};
