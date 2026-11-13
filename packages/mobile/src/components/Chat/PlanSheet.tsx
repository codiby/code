import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PermissionRequest } from '../../api/types';
import { shortToolName } from '../../lib/chatItems';
import { Markdown } from '../Markdown';

/** El plan que trae un `ExitPlanMode` (nativo o el del MCP de Codiby). */
export function planText(request: PermissionRequest): string | null {
  if (shortToolName(request.toolName) !== 'ExitPlanMode') {
    return null;
  }
  const plan = request.input.plan;
  return typeof plan === 'string' && plan.trim() !== '' ? plan : null;
}

/** Primer encabezado del plan, sin `#` ni backticks; si no hay, `Plan`. */
export function planTitle(plan: string): string {
  const heading = plan
    .split('\n')
    .map(line => line.trim())
    .find(line => /^#{1,6}\s+\S/.test(line));
  if (heading === undefined) {
    return 'Plan';
  }
  return heading
    .replace(/^#{1,6}\s+/, '')
    .replace(/^plan\s*:\s*/i, '')
    .replace(/`/g, '')
    .trim();
}

/** Lo que sigue al título, como texto plano, para la vista previa de la tarjeta. */
export function planPreview(plan: string): string {
  return plan
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => line.replace(/^[-*+]\s+|^\d+\.\s+/, '').replace(/[`*_]/g, ''))
    .join(' ');
}

/** Distancia (o velocidad) hacia abajo que cierra el sheet al soltarlo. */
const DISMISS_DY = 120;
const DISMISS_VY = 1.2;

export interface PlanSheetProps {
  readonly visible: boolean;
  readonly plan: string;
  readonly onClose: () => void;
  /** `bypass`: además de aprobar, pasar la sesión a `bypassPermissions`. */
  readonly onRespond: (allow: boolean, bypass?: boolean) => void;
  readonly isBusy?: boolean;
}

/**
 * El plan a pantalla completa, como bottom sheet: se arrastra desde la barra
 * de arriba para cerrarlo y trae Deny/Approve fijos abajo, para decidir sin
 * volver a la tarjeta.
 */
export function PlanSheet({
  visible,
  plan,
  onClose,
  onRespond,
  isBusy = false,
}: PlanSheetProps) {
  const insets = useSafeAreaInsets();
  const offset = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Cada apertura empieza en su sitio, no donde lo dejó el último arrastre.
  useEffect(() => {
    if (visible) {
      offset.setValue(0);
    }
  }, [visible, offset]);

  // Solo la cabecera arrastra: el cuerpo es un ScrollView y debe seguir
  // desplazándose sin pelearse con el gesto.
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, { dy, dx }) =>
          dy > 4 && dy > Math.abs(dx),
        onPanResponderMove: (_, { dy }) => offset.setValue(Math.max(0, dy)),
        onPanResponderRelease: (_, { dy, vy }) => {
          if (dy > DISMISS_DY || vy > DISMISS_VY) {
            closeRef.current();
            return;
          }
          Animated.spring(offset, {
            toValue: 0,
            useNativeDriver: true,
            speed: 28,
            bounciness: 0,
          }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(offset, {
            toValue: 0,
            useNativeDriver: true,
          }).start(),
      }),
    [offset],
  );

  const title = planTitle(plan);
  const respond = (allow: boolean, bypass = false) => {
    onRespond(allow, bypass);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Android Modal tiene su propia raíz nativa; las tablas del Markdown
          se desplazan con gesture-handler, así que necesitan una aquí. */}
      <GestureHandlerRootView style={styles.root}>
        <View
          style={[styles.root, { paddingTop: insets.top + 8 }]}
          className="bg-black/45"
        >
          <Animated.View
            style={[styles.root, { transform: [{ translateY: offset }] }]}
            className="overflow-hidden rounded-t-3xl bg-white"
          >
            <View {...responder.panHandlers} className="pt-2">
              <View className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300" />
              <View className="flex-row items-center border-b border-slate-200 px-5 pb-3">
                <View className="flex-1 pr-3">
                  <Text className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
                    Plan · needs approval
                  </Text>
                  <Text
                    numberOfLines={2}
                    className="mt-0.5 text-base font-bold leading-snug text-slate-900"
                  >
                    {title}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close plan"
                  onPress={onClose}
                  className="min-h-11 justify-center pl-3"
                >
                  <Text className="text-sm text-slate-500">Close</Text>
                </Pressable>
              </View>
            </View>

            <ScrollView
              style={styles.root}
              contentContainerClassName="px-5 pb-6 pt-2"
            >
              <Markdown text={plan} />
            </ScrollView>

            <View
              style={{ paddingBottom: insets.bottom + 10 }}
              className="border-t border-slate-200 bg-white px-4 pt-3"
            >
              <View className="flex-row items-center gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Deny plan"
                  onPress={() => respond(false)}
                  disabled={isBusy}
                  className="items-center rounded-xl px-3.5 py-2.5 active:bg-slate-100"
                >
                  <Text className="text-[13.5px] font-semibold text-slate-600">
                    Deny
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Approve plan and bypass permissions"
                  onPress={() => respond(true, true)}
                  disabled={isBusy}
                  className="flex-1 items-center rounded-xl border border-amber-400 px-3 py-2.5 active:opacity-70"
                >
                  <Text className="text-[13.5px] font-semibold text-amber-700">
                    Approve & Bypass
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Approve plan"
                  onPress={() => respond(true)}
                  disabled={isBusy}
                  className={`flex-1 items-center rounded-xl px-3 py-2.5 ${
                    isBusy ? 'bg-slate-400' : 'bg-slate-900 active:opacity-70'
                  }`}
                >
                  <Text className="text-[13.5px] font-semibold text-slate-50">
                    Approve
                  </Text>
                </Pressable>
              </View>
              <Text className="mt-1.5 text-center text-[10px] text-slate-400">
                Bypass stops asking for permission for the rest of the session ·
                denying interrupts the turn
              </Text>
            </View>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
