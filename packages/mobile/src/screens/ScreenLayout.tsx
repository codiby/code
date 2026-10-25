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
    <View className="flex-1 bg-slate-100">
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 18,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        className="px-[18px]"
      >
        <Text className="mb-4 text-[23px] font-bold tracking-tight text-slate-900">
          {title}
        </Text>
        {children}
      </ScrollView>
    </View>
  );
}
