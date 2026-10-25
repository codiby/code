import {
  fetchShareHost,
  parseShareChats,
  sendIncomingShare,
  sortShareChats,
  type IncomingShare,
  type ShareHost,
} from '../src/lib/incomingShare';
import { requestJson } from '../src/api/client';
import { sendMessage } from '../src/api/messages';

jest.mock('../src/api/client', () => ({ requestJson: jest.fn() }));
jest.mock('../src/api/messages', () => ({ sendMessage: jest.fn() }));

const host: ShareHost = {
  id: 'host',
  name: 'Mi host',
  color: 'violet',
  token: 'token',
  urls: ['http://lan', 'https://remote'],
};
const payload: IncomingShare = {
  config: JSON.stringify({
    version: 1,
    servers: [host, { ...host, id: 'other' }],
  }),
  snapshot: JSON.stringify([
    {
      id: 'same',
      serverId: 'host',
      name: 'Diseño',
      cwd: '/src/code',
      updated_at: 20,
      pinned: true,
      pinOrder: 0,
      preview: 'Último mensaje',
    },
    {
      id: 'same',
      serverId: 'other',
      name: 'Otra sesión',
      updated_at: 30,
      pinned: true,
      pinOrder: 1,
    },
    { id: 'gone', serverId: 'removed', name: 'Host eliminado' },
  ]),
  text: 'Imagen',
  images: [{ mediaType: 'image/jpeg', data: 'base64' }],
};

beforeEach(() => {
  jest.resetAllMocks();
});

test('reutiliza los datos del inicio con identidad por host, vistas previas y orden de anclados', () => {
  const chats = parseShareChats(payload);
  expect(chats.sessions).toHaveLength(2);
  expect(chats.previews['host:same']).toBe('Último mensaje');
  expect(chats.hosts[0].color).toBe('violet');
  expect(
    sortShareChats(chats.sessions, chats.pinnedIds, '').map(s => s.key),
  ).toEqual(['other:same', 'host:same']);
  expect(sortShareChats(chats.sessions, chats.pinnedIds, 'diseno')[0].key).toBe(
    'host:same',
  );
});

test('una LAN pendiente no impide mostrar los chats del respaldo', async () => {
  (requestJson as jest.Mock).mockImplementation((base, _path, parse) =>
    base === 'http://lan'
      ? new Promise(() => {})
      : Promise.resolve(
          parse([{ id: 'same', name: 'Diseño', status: 'open' }]),
        ),
  );
  const result = await fetchShareHost(host);
  expect(result.baseUrl).toBe('https://remote');
  expect(result.sessions[0].key).toBe('host:same');
  expect(sendMessage).not.toHaveBeenCalled();
});

test('envía una sola vez por la ruta validada y no reintenta un POST fallido', async () => {
  const chat = parseShareChats(payload).sessions[0];
  (requestJson as jest.Mock).mockImplementation((base, _path, parse) =>
    base === 'http://lan'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(
          parse([{ id: chat.id, name: chat.name, status: 'open' }]),
        ),
  );
  (sendMessage as jest.Mock).mockRejectedValue(new Error('503'));
  await expect(
    sendIncomingShare(host, chat, payload.text, payload.images),
  ).rejects.toThrow('No se confirmó');
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith(
    'https://remote',
    'same',
    'token',
    'Imagen',
    payload.images,
  );
});

test('no envía a un chat archivado después de guardar la lista', async () => {
  const chat = parseShareChats(payload).sessions[0];
  (requestJson as jest.Mock).mockImplementation((_base, _path, parse) =>
    Promise.resolve(
      parse([{ id: chat.id, name: chat.name, status: 'archived' }]),
    ),
  );
  await expect(
    sendIncomingShare(host, chat, payload.text, payload.images),
  ).rejects.toThrow('ya no está activo');
  expect(sendMessage).not.toHaveBeenCalled();
});
