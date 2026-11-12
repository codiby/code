import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ReactNode } from 'react';

/** Alto de la GlassTabBar flotante más su separación inferior. */
const TAB_BAR_CLEARANCE = 120;

export interface ScreenLayoutProps {
  readonly title: string;
  readonly children: ReactNode;
}

export function ScreenLayout({ title, children }: ScreenLayoutProps) {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-white">
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 4,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        className="px-4"
      >
        <Text className="mb-3 h-12 text-[23px] font-bold leading-[48px] tracking-[-0.9px] text-slate-900">
          {title}
        </Text>
        {children}
      </ScrollView>
    </View>
  );
}
