import { View } from 'react-native';

import { useIsDark } from '../../theme';
import { GlassTabBarItem } from './GlassTabBarItem';
import { AgentIcon, ChatIcon, HomeIcon, SettingsIcon } from './icons';
import type { GlassTabBarProps, TabItem } from './types';

export const DEFAULT_TAB_ITEMS: readonly TabItem[] = [
  { key: 'chat', label: 'Direct', Icon: ChatIcon },
  { key: 'home', label: 'Sessions', Icon: HomeIcon },
  { key: 'agent', label: 'Agent', Icon: AgentIcon },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon },
];

/** Anillo de 1 px más sombra suave: el borde del dock sin dibujar un borde. */
const LIGHT_SHADOW = {
  boxShadow:
    '0px 0px 0px 1px rgba(13, 15, 18, 0.1), 0px 12px 28px rgba(0, 0, 0, 0.16)',
} as const;
const DARK_SHADOW = {
  boxShadow:
    '0px 0px 0px 1px rgba(255, 255, 255, 0.1), 0px 14px 30px rgba(0, 0, 0, 0.6)',
} as const;

/**
 * Dock flotante centrado, como el de la app de chats: 5 px de relleno, radio
 * 26, fondo casi opaco. Sin brillos ni degradados: lo único con color es la
 * pestaña activa.
 */
export function GlassTabBar({
  activeKey,
  onChange,
  items = DEFAULT_TAB_ITEMS,
}: GlassTabBarProps) {
  const dark = useIsDark();
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 items-center pb-6"
    >
      <View
        accessibilityRole="tablist"
        style={dark ? DARK_SHADOW : LIGHT_SHADOW}
        className="flex-row items-center gap-0.5 rounded-[26px] bg-dock/90 p-[5px]"
      >
        {items.map(item => (
          <GlassTabBarItem
            key={item.key}
            item={item}
            isActive={item.key === activeKey}
            onPress={() => onChange(item.key)}
          />
        ))}
      </View>
    </View>
  );
}
