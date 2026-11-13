import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { PermissionCard } from '../src/components/Chat/PermissionCard';
import {
  planPreview,
  planText,
  planTitle,
} from '../src/components/Chat/PlanSheet';

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: require('react-native').View,
  ScrollView: require('react-native').ScrollView,
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

const PLAN =
  '# Plan: `IFoodOrder`, el pedido se vuelve venta\n\n## Contexto\nHoy `Fulfillment` crea la venta.\n- Paso uno';

const request = (toolName: string, input: Record<string, unknown>) => ({
  requestId: 'r1',
  toolName,
  description: null,
  input,
});

const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByProps({ accessibilityLabel: label })[0]!;

test('reconoce el plan del ExitPlanMode nativo y del MCP', () => {
  expect(planText(request('ExitPlanMode', { plan: PLAN }))).toBe(PLAN);
  expect(
    planText(request('mcp__codiby-code__ExitPlanMode', { plan: PLAN })),
  ).toBe(PLAN);
  expect(planText(request('Bash', { plan: PLAN }))).toBeNull();
  expect(planText(request('ExitPlanMode', {}))).toBeNull();
});

test('título y vista previa salen del markdown', () => {
  expect(planTitle(PLAN)).toBe('IFoodOrder, el pedido se vuelve venta');
  expect(planTitle('sin encabezado')).toBe('Plan');
  expect(planPreview(PLAN)).toBe('Hoy Fulfillment crea la venta. Paso uno');
});

test('la tarjeta abre el sheet y aprobar desde ahí responde y lo cierra', async () => {
  const onRespond = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <PermissionCard
        request={request('ExitPlanMode', { plan: PLAN })}
        onRespond={onRespond}
      />,
    );
  });
  await act(async () => button(tree, 'Read the plan').props.onPress());
  await act(async () => button(tree, 'Approve plan').props.onPress());
  expect(onRespond).toHaveBeenCalledWith(true, false);
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Approve plan' })).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Approve & Bypass aprueba y pide el bypass, desde la tarjeta y desde el sheet', async () => {
  const onRespond = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <PermissionCard
        request={request('ExitPlanMode', { plan: PLAN })}
        onRespond={onRespond}
      />,
    );
  });
  await act(async () => button(tree, 'Approve & Bypass').props.onPress());
  expect(onRespond).toHaveBeenLastCalledWith(true, true);
  await act(async () => button(tree, 'Read the plan').props.onPress());
  await act(async () =>
    button(tree, 'Approve plan and bypass permissions').props.onPress(),
  );
  expect(onRespond).toHaveBeenLastCalledWith(true, true);
  await act(async () => tree.unmount());
});

test('un permiso que no es plan no ofrece bypass', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <PermissionCard
        request={request('Bash', { command: 'ls' })}
        onRespond={jest.fn()}
      />,
    );
  });
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Approve & Bypass' }),
  ).toHaveLength(0);
  await act(async () => tree.unmount());
});
