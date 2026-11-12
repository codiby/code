import { Pressable, Text } from 'react-native';

import { useInk } from '../../theme';
import type { TabItem } from './types';

const ICON_SIZE = 20;

export interface GlassTabBarItemProps {
  readonly item: TabItem;
  readonly isActive: boolean;
  readonly onPress: () => void;
}

/**
 * Pestaña de 42 px: solo la activa enseña su nombre, sobre el verde tenue;
 * las demás se quedan en icono. Mismas medidas que el dock de la app de chats.
 */
export function GlassTabBarItem({
  item,
  isActive,
  onPress,
}: GlassTabBarItemProps) {
  const ink = useInk();
  const { Icon, label } = item;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      className={`h-[42px] min-w-[46px] flex-row items-center justify-center rounded-[21px] px-[13px] active:opacity-70 ${
        isActive ? 'bg-tint' : ''
      }`}
    >
      <Icon
        size={ICON_SIZE}
        color={isActive ? ink('#0b7d5c') : ink('#6a707a')}
      />
      {isActive ? (
        <Text className="pl-[7px] text-[12.5px] font-semibold tracking-[-0.2px] text-accent">
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
