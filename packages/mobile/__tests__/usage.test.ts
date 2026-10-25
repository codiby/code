import {
  fetchUsage,
  usageHeadline,
  type UsageSnapshot,
} from '../src/api/usage';

const snapshot: UsageSnapshot = {
  fetchedAt: '2026-10-23T20:00:00Z',
  providers: [
    {
      provider: 'codex',
      status: 'ok',
      windows: [
        { id: 'weekly', kind: 'weekly', percent: 92, severity: 'critical' },
      ],
    },
  ],
};

afterEach(() => jest.restoreAllMocks());

test('consulta autenticada y actualización forzada con el contrato del servidor', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => snapshot,
  } as Response);
  expect(await fetchUsage('http://studio:3111', ' token ', true)).toEqual(
    snapshot,
  );
  expect(fetch).toHaveBeenCalledWith(
    'http://studio:3111/providers/usage?refresh=1',
    expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer token' },
    }),
  );
});

test('el resumen ignora proveedores desconectados o con error', () => {
  expect(
    usageHeadline([
      {
        ...snapshot,
        providers: [
          ...snapshot.providers,
          {
            ...snapshot.providers[0]!,
            status: 'logged_out',
            windows: [
              {
                id: 'old',
                kind: 'session',
                percent: 100,
                severity: 'critical',
              },
            ],
          },
          {
            ...snapshot.providers[0]!,
            status: 'error',
            windows: [
              {
                id: 'error',
                kind: 'session',
                percent: 99,
                severity: 'critical',
              },
            ],
          },
        ],
      },
    ])?.percent,
  ).toBe(92);
  expect(usageHeadline([])).toBeNull();
});

test('rechaza respuestas sin porcentajes numéricos', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      ...snapshot,
      providers: [
        {
          ...snapshot.providers[0],
          windows: [
            { id: 'bad', kind: 'session', percent: null, severity: 'normal' },
          ],
        },
      ],
    }),
  } as Response);
  await expect(fetchUsage('http://studio:3111', '')).rejects.toThrow();
});
