import React from 'react';
import { Switch, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { PhoneAccessSection } from '../src/components/PhoneAccessSection';
import {
  isPhoneAgentAvailable,
  openAccessibilitySettings,
  parsePhoneAgentLog,
  phoneAgentLog,
  phoneAgentStatus,
  requestNotificationPermission,
  setPhoneAgentOptions,
  type PhoneAgentStatus,
} from '../src/lib/phoneAgent';

jest.mock('../src/lib/phoneAgent', () => ({
  ...jest.requireActual('../src/lib/phoneAgent'),
  isPhoneAgentAvailable: jest.fn(() => true),
  phoneAgentStatus: jest.fn(),
  phoneAgentLog: jest.fn(async () => []),
  setPhoneAgentOptions: jest.fn(async () => undefined),
  requestNotificationPermission: jest.fn(async () => true),
  openAccessibilitySettings: jest.fn(async () => undefined),
  openNotificationAccessSettings: jest.fn(async () => undefined),
  openAppDetails: jest.fn(async () => undefined),
  clearPhoneAgentLog: jest.fn(async () => undefined),
}));

const base: PhoneAgentStatus = {
  enabled: false,
  allowAct: true,
  allowNotifications: true,
  askEveryAction: false,
  accessibility: false,
  notificationAccess: false,
  postNotifications: false,
  linkedHosts: [],
  sdk: 36,
};

async function render(status: Partial<PhoneAgentStatus>) {
  (phoneAgentStatus as jest.Mock).mockResolvedValue({ ...base, ...status });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<PhoneAccessSection />);
  });
  return tree;
}

const texts = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(t => [t.props.children].flat().join(''));

beforeEach(() => jest.clearAllMocks());

test('nada que mostrar sin el módulo nativo (iOS)', async () => {
  (isPhoneAgentAvailable as jest.Mock).mockReturnValue(false);
  try {
    const tree = await render({});
    expect(tree.toJSON()).toBeNull();
    await act(async () => tree.unmount());
  } finally {
    (isPhoneAgentAvailable as jest.Mock).mockReturnValue(true);
  }
});

test('encenderlo guarda el interruptor y pide el permiso de notificaciones', async () => {
  const tree = await render({});
  const main = tree.root.findAllByType(Switch)[0]!;
  await act(async () => {
    await main.props.onValueChange(true);
  });
  expect(setPhoneAgentOptions).toHaveBeenCalledWith({ enabled: true });
  expect(requestNotificationPermission).toHaveBeenCalledWith(36);
  await act(async () => tree.unmount());
});

test('lo que falta en Android aparece como pasos con su botón', async () => {
  const tree = await render({ enabled: true, postNotifications: true });
  const all = texts(tree);
  expect(all).toContain('Waiting for the accessibility service');
  expect(all).toContain('Turn on');
  expect(all).toContain('Grant');
  expect(all).not.toContain('Allow');
  // Android 13+: la pista de «ajustes restringidos».
  expect(all.some(t => t.includes('Allow restricted settings'))).toBe(true);
  const turnOn = tree.root.find(n => n.props.accessibilityLabel === 'Turn on: Accessibility service' && !!n.props.onPress);
  await act(async () => turnOn.props.onPress());
  expect(openAccessibilitySettings).toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('con todo listo dice a qué hosts está enlazado y deja elegir qué se permite', async () => {
  const tree = await render({
    enabled: true,
    accessibility: true,
    notificationAccess: true,
    postNotifications: true,
    linkedHosts: ['mac', 'Ryzen9'],
  });
  expect(texts(tree)).toContain('Linked to mac, Ryzen9');
  const act$ = tree.root.find(n => n.type === Switch && n.props.accessibilityLabel === 'Tap, type and open apps');
  await act(async () => act$.props.onValueChange(false));
  expect(setPhoneAgentOptions).toHaveBeenCalledWith({ allowAct: false });
  await act(async () => tree.unmount());
});

test('el registro muestra lo último primero, con lo rechazado marcado', async () => {
  (phoneAgentLog as jest.Mock).mockResolvedValue(
    parsePhoneAgentLog(
      JSON.stringify([
        { t: 1, host: 'mac', session: 'Billing', command: 'act', summary: 'Tap “Chats” in WhatsApp', outcome: 'done' },
        { t: 2, host: 'mac', session: 'Billing', command: 'act', summary: 'tap Enviar', outcome: 'declined' },
      ]),
    ),
  );
  const tree = await render({ enabled: true, accessibility: true });
  const all = texts(tree);
  expect(all.indexOf('tap Enviar')).toBeLessThan(all.indexOf('Tap “Chats” in WhatsApp'));
  expect(all).toContain('declined');
  await act(async () => tree.unmount());
});

test('un registro dañado se lee como vacío', () => {
  expect(parsePhoneAgentLog('{nope')).toEqual([]);
  expect(parsePhoneAgentLog('{"t":1}')).toEqual([]);
});
