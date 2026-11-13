import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { SessionInfoScreen } from '../src/screens/SessionInfoScreen';
import type { SessionSummary } from '../src/api/types';

const mockSend = jest.fn(() => true);
jest.mock('../src/api/SocketProvider', () => ({
  useSockets: () => ({ send: mockSend }),
}));
jest.mock('../src/api/resources', () => ({
  fetchResources: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../src/api/preferences', () => ({
  fetchPreferences: jest.fn(() => Promise.resolve({ pinnedIds: [] })),
  savePinned: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/components/Gallery', () => ({ ImageLightbox: () => null }));
jest.mock('../src/components/ModelPicker', () => ({ ModelPicker: () => null }));
jest.mock('../src/lib/chatMedia', () => ({ sessionMedia: () => [] }));
jest.mock('../src/components/SessionList/RenameDialog', () => ({
  RenameDialog: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

const session: SessionSummary = {
  id: 's1',
  serverId: 'mac',
  key: 'mac:s1',
  name: 'Plati Pendiente Mezclar',
  cwd: '/home/jovaz/vtb',
  folder: 'vtb',
  updatedAt: 0,
  lastSentAt: 0,
  isOpen: true,
  isRunning: true,
  provider: 'claude',
  permissionMode: 'default',
};

const mode = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByProps({ accessibilityLabel: `Permission mode ${label}` })[0]!;

async function render() {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <SessionInfoScreen
        session={session}
        baseUrl="http://x"
        token="t"
        totalMessages={570}
        onClose={jest.fn()}
        onOpenGallery={jest.fn()}
        onOpenMockup={jest.fn()}
        onGone={jest.fn()}
      />,
    );
  });
  return tree;
}

afterEach(() => jest.clearAllMocks());

test('muestra el modo actual y cambiarlo manda set_permission_mode', async () => {
  const tree = await render();
  expect(mode(tree, 'Default').props.accessibilityState).toEqual({ selected: true });
  await act(async () => mode(tree, 'Plan').props.onPress());
  expect(mockSend).toHaveBeenCalledWith('mac', {
    type: 'set_permission_mode',
    sessionId: 's1',
    mode: 'plan',
  });
  expect(mode(tree, 'Plan').props.accessibilityState).toEqual({ selected: true });
  await act(async () => tree.unmount());
});

test('bypass pide confirmación antes de aplicarse', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const tree = await render();
  await act(async () => mode(tree, 'Bypass All').props.onPress());
  expect(mockSend).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0]![2]!;
  await act(async () => buttons.find(b => b.text === 'Bypass')!.onPress!());
  expect(mockSend).toHaveBeenCalledWith('mac', expect.objectContaining({ mode: 'bypassPermissions' }));
  await act(async () => tree.unmount());
});
