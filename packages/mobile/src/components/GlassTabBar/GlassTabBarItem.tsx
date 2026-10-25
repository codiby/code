import { Pressable, Text, View } from 'react-native';

import type { TabItem } from './types';

const ICON_SIZE = 20;
// Sobre vidrio oscuro el activo es el que va claro; el inactivo baja a gris
// medio en vez de a blanco translúcido, que sobre el desenfoque se ensucia.
const ACTIVE_COLOR = '#ffffff';
const INACTIVE_COLOR = '#8a94a6';

export interface GlassTabBarItemProps {
  readonly item: TabItem;
  readonly isActive: boolean;
  readonly onPress: () => void;
}

export function GlassTabBarItem({
  item,
  isActive,
  onPress,
}: GlassTabBarItemProps) {
  const { Icon, label } = item;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      className={`h-11 flex-row items-center justify-center rounded-full active:opacity-60 ${
        isActive ? 'gap-2 px-3.5' : 'w-11'
      }`}
    >
      {/* Pastilla del estado activo: otra capa de vidrio, más densa. */}
      {isActive ? (
        <View className="absolute inset-0 rounded-full border border-white/10 bg-white/[0.09]" />
      ) : null}
      <Icon size={ICON_SIZE} color={isActive ? ACTIVE_COLOR : INACTIVE_COLOR} />
      {isActive ? (
        <Text className="text-[11px] font-semibold text-white">{label}</Text>
      ) : null}
    </Pressable>
  );
}
