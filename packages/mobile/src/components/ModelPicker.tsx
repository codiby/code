import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PROVIDERS,
  fetchProviderModels,
  type ProviderModel,
  type ProviderName,
} from '../api/providers';
import { useInk } from '../theme';

export interface ModelPickerProps {
  readonly visible: boolean;
  readonly baseUrl: string;
  readonly token: string;
  readonly provider: string | null;
  /** Lo elegido en la sesión; `null` = el del proveedor. */
  readonly current: string | null;
  readonly onSelect: (model: string | null) => void;
  readonly onClose: () => void;
}

function asProvider(value: string | null): ProviderName {
  return (PROVIDERS as readonly string[]).includes(value ?? '')
    ? (value as ProviderName)
    : 'claude';
}

/**
 * Hoja para cambiar el modelo de una sesión ya abierta.
 *
 * La lista sale de `/providers/<p>/info`, la misma que usa el escritorio.
 * Claude trae su propia entrada `default`; se oculta porque «Default» de
 * arriba ya significa eso y dos filas iguales confunden.
 */
export function ModelPicker({
  visible,
  baseUrl,
  token,
  provider,
  current,
  onSelect,
  onClose,
}: ModelPickerProps) {
  const ink = useInk();
  const insets = useSafeAreaInsets();
  const [models, setModels] = useState<ProviderModel[] | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    setModels(null);
    fetchProviderModels(baseUrl, token, asProvider(provider))
      .then(found => {
        if (!cancelled) {
          setModels(found.filter(item => item.id !== 'default'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, baseUrl, token, provider]);

  const options: { id: string | null; label: string }[] = [
    { id: null, label: 'Default' },
    ...(models ?? []),
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/45">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close model picker"
          onPress={onClose}
          className="flex-1"
        />
        <View
          style={{ paddingBottom: insets.bottom + 12, maxHeight: '70%' }}
          className="rounded-t-3xl bg-white pt-2"
        >
          <View className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300" />
          <Text className="px-5 pb-2 text-base font-bold text-slate-900">
            Model
          </Text>
          {models === null ? (
            <View className="items-center py-8">
              <ActivityIndicator size="small" color={ink('#94a3b8')} />
            </View>
          ) : (
            <ScrollView>
              {options.map(option => {
                const isActive = option.id === current;
                return (
                  <Pressable
                    key={option.id ?? 'default'}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    onPress={() => onSelect(option.id)}
                    className="flex-row items-center px-5 py-3 active:bg-slate-50"
                  >
                    <Text
                      className={`flex-1 text-[14px] ${
                        isActive
                          ? 'font-semibold text-slate-900'
                          : 'text-slate-700'
                      }`}
                    >
                      {option.label}
                    </Text>
                    {isActive ? (
                      <Text className="text-[14px] text-slate-900">✓</Text>
                    ) : null}
                  </Pressable>
                );
              })}
              {models.length === 0 ? (
                <Text className="px-5 py-3 text-[12px] text-slate-400">
                  This machine did not report other models.
                </Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
