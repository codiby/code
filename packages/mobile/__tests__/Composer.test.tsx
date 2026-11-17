import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { launchImageLibrary } from 'react-native-image-picker';
import { Composer } from '../src/components/Chat/Composer';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByProps({ accessibilityLabel: label })[0]!;

afterEach(() => jest.clearAllMocks());

test('cancelar una cita conserva el texto del borrador', async () => {
  const onSend = jest.fn().mockResolvedValue(undefined);
  const onChangeReplies = jest.fn();
  const quote = { id: 'm1', role: 'assistant' as const, text: 'Mensaje original' };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Composer
        onSend={onSend}
        initialText="Mi respuesta"
        replies={[quote]}
        onChangeReplies={onChangeReplies}
      />,
    );
  });
  await act(async () => button(tree, 'Cancel reply').props.onPress());
  expect(onChangeReplies).toHaveBeenCalledTimes(1);
  expect(onChangeReplies.mock.calls[0][0]([quote])).toEqual([]);
  expect(button(tree, 'Message').props.value).toBe('Mi respuesta');
  await act(async () => tree.unmount());
});

test('una cita con nota se puede enviar sin texto', async () => {
  const onSend = jest.fn().mockResolvedValue(undefined);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Composer
        onSend={onSend}
        replies={[{ id: 'm1', role: 'assistant', text: 'Cita', note: 'Cámbialo' }]}
      />,
    );
  });
  expect(button(tree, 'Send').props.disabled).toBe(false);
  await act(async () => tree.unmount());
});

test('envía texto multilínea y adjuntos desde el mismo compositor', async () => {
  const onSend = jest.fn().mockResolvedValue(undefined);
  (launchImageLibrary as jest.Mock).mockResolvedValue({
    assets: [{ type: 'image/png', base64: 'image-data' }],
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<Composer onSend={onSend} />);
  });
  expect(button(tree, 'Send').props.disabled).toBe(true);
  await act(async () => {
    tree.root
      .findAllByProps({ accessibilityLabel: 'Message' })[0]!
      .props.onChangeText('Primera línea\nSegunda línea');
  });
  await act(async () => {
    button(tree, 'Attach image').props.onPress();
  });
  await act(async () => {
    button(tree, 'Send').props.onPress();
  });
  expect(onSend).toHaveBeenCalledWith('Primera línea\nSegunda línea', [
    { mediaType: 'image/png', data: 'image-data' },
  ]);
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Message' })[0]!.props.value,
  ).toBe('');
  await act(async () => {
    tree.unmount();
  });
});

test('un envío fallido restaura el borrador y no permite doble envío simultáneo', async () => {
  let reject!: (error: Error) => void;
  const onSend = jest.fn().mockImplementation(
    () =>
      new Promise<void>((_, r) => {
        reject = r;
      }),
  );
  const onTextChange = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Composer
        onSend={onSend}
        onTextChange={onTextChange}
        initialText="Mi petición"
      />,
    );
  });
  const send = button(tree, 'Send').props.onPress;
  await act(async () => {
    send();
    send();
  });
  expect(onSend).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject(new Error('Sin conexión'));
  });
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Message' })[0]!.props.value,
  ).toBe('Mi petición');
  expect(onTextChange).toHaveBeenLastCalledWith('Mi petición');
  expect(button(tree, 'Send').props.disabled).toBe(false);
  onSend.mockResolvedValueOnce(undefined);
  await act(async () => {
    button(tree, 'Send').props.onPress();
  });
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Message' })[0]!.props.value,
  ).toBe('');
  await act(async () => {
    tree.unmount();
  });
});
