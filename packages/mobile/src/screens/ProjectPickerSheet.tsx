import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckIcon } from '../components/Chat';
import { GridIcon, PinIcon } from '../components/SessionList';
import { useInk } from '../theme';

/** Un grupo de primer nivel del escritorio, visto como proyecto. */
export interface ProjectOption {
  /** Clave de fusión del grupo (`groupTree`). */
  readonly key: string;
  readonly title: string;
  readonly color: string;
  /** Sesiones abiertas del proyecto, con sus subgrupos. */
  readonly count: number;
  readonly working: number;
  readonly waiting: number;
  /** Servidores que tienen sesiones en él, para la línea de abajo. */
  readonly servers: readonly string[];
  /** Nombres de los subgrupos con sesiones, en el orden de los chips. */
  readonly subgroups: readonly string[];
  readonly isPinned: boolean;
  /** Último mensaje tuyo en el proyecto: ordena «Recent». */
  readonly lastAt: number;
}

export interface ProjectPickerSheetProps {
  readonly visible: boolean;
  readonly projects: readonly ProjectOption[];
  /** `null` = «All projects». */
  readonly current: string | null;
  readonly totalOpen: number;
  readonly serverCount: number;
  readonly onSelect: (key: string | null) => void;
  readonly onClose: () => void;
}

const ACCENTS: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
  ü: 'u',
  ñ: 'n',
};

/** Minúsculas y sin acentos, a mano: Hermes no garantiza `normalize`. */
function fold(text: string): string {
  let out = '';
  for (const char of text.toLowerCase()) {
    out += ACCENTS[char] ?? char;
  }
  return out;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Elegir qué proyecto enseña el Home. Los proyectos son los grupos de primer
 * nivel del escritorio: arriba los anclados (los mismos `pinnedGroupIds`),
 * luego los que tienen sesiones por actividad, y al final los vacíos.
 */
export function ProjectPickerSheet({
  visible,
  projects,
  current,
  totalOpen,
  serverCount,
  onSelect,
  onClose,
}: ProjectPickerSheetProps) {
  const ink = useInk();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const close = () => {
    setQuery('');
    onClose();
  };

  const select = (key: string | null) => {
    setQuery('');
    onSelect(key);
  };

  const { pinned, recent, idle } = useMemo(() => {
    const needle = fold(query.trim());
    const matches = projects.filter(
      project => needle.length === 0 || fold(project.title).includes(needle),
    );
    return {
      pinned: matches.filter(project => project.isPinned),
      recent: matches
        .filter(project => !project.isPinned && project.count > 0)
        .sort((a, b) => b.lastAt - a.lastAt),
      idle: matches
        .filter(project => !project.isPinned && project.count === 0)
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }, [projects, query]);

  const renderRow = (project: ProjectOption) => {
    const isPicked = project.key === current;
    const detail =
      project.count === 0
        ? 'No open sessions'
        : project.subgroups.length > 0
          ? project.subgroups.slice(0, 3).join(' · ')
          : plural(project.count, 'session');
    return (
      <Pressable
        key={project.key}
        accessibilityRole="button"
        accessibilityLabel={`${project.title}, ${plural(project.count, 'open session')}`}
        accessibilityState={{ selected: isPicked }}
        onPress={() => select(project.key)}
        className={`flex-row items-center gap-[11px] px-4 py-2 ${
          isPicked ? 'bg-slate-100' : 'active:bg-slate-100'
        }`}
      >
        <View
          style={{ backgroundColor: `${project.color}26` }}
          className="h-10 w-10 items-center justify-center rounded-full"
        >
          <View
            style={{ backgroundColor: project.color }}
            className="h-3 w-3 rounded-full"
          />
        </View>
        <View className="flex-1">
          <Text
            numberOfLines={1}
            className={`text-[14.5px] font-medium tracking-[-0.3px] ${
              project.count === 0 ? 'text-slate-500' : 'text-slate-900'
            }`}
          >
            {project.title}
          </Text>
          <Text numberOfLines={1} className="mt-px text-[12px] text-slate-500">
            {project.servers.length > 0
              ? `${project.servers.join(', ')} · ${detail}`
              : detail}
          </Text>
        </View>
        {project.waiting > 0 ? (
          <View className="rounded-full bg-amber-100 px-[7px] py-px">
            <Text className="text-[10.5px] font-semibold text-amber-700">
              {`${project.waiting} waiting`}
            </Text>
          </View>
        ) : project.working > 0 ? (
          <View className="rounded-full bg-tint px-[7px] py-px">
            <Text className="text-[10.5px] font-semibold text-accent">
              {`${project.working} working`}
            </Text>
          </View>
        ) : null}
        {project.isPinned ? <PinIcon size={13} color={ink('#94a3b8')} /> : null}
        <View className="w-[18px] items-center">
          {isPicked ? <CheckIcon size={15} color={ink('#0b7d5c')} /> : null}
        </View>
      </Pressable>
    );
  };

  const section = (title: string, items: readonly ProjectOption[]) =>
    items.length === 0 ? null : (
      <View key={title}>
        <Text className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.5px] text-slate-400">
          {title}
        </Text>
        {items.map(renderRow)}
      </View>
    );

  const showAll = query.trim().length === 0;
  const isEmpty =
    pinned.length === 0 && recent.length === 0 && idle.length === 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={close}
        className="h-[18%] bg-black/40"
      />
      <View
        style={{ paddingBottom: insets.bottom + 8 }}
        className="flex-1 rounded-t-[26px] bg-white pt-2"
      >
        <View className="mx-auto mb-2 h-1 w-9 rounded-full bg-slate-200" />
        <Text className="px-4 pb-2 text-[17px] font-bold tracking-[-0.5px] text-slate-900">
          Projects
        </Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects…"
          placeholderTextColor={ink('#94a3b8')}
          autoCapitalize="none"
          autoCorrect={false}
          className="mx-4 mb-1.5 rounded-[20px] bg-slate-100 px-[14px] py-2 text-[13.5px] leading-5 text-slate-900"
        />

        <ScrollView keyboardShouldPersistTaps="handled">
          {showAll ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="All projects"
              accessibilityState={{ selected: current === null }}
              onPress={() => select(null)}
              className={`flex-row items-center gap-[11px] px-4 py-2 ${
                current === null ? 'bg-slate-100' : 'active:bg-slate-100'
              }`}
            >
              <View className="h-10 w-10 items-center justify-center rounded-full bg-slate-100">
                <GridIcon size={19} color={ink('#475569')} />
              </View>
              <View className="flex-1">
                <Text className="text-[14.5px] font-medium tracking-[-0.3px] text-slate-900">
                  All projects
                </Text>
                <Text className="mt-px text-[12px] text-slate-500">
                  {`${plural(totalOpen, 'open session')} on ${plural(serverCount, 'server')}`}
                </Text>
              </View>
              <View className="w-[18px] items-center">
                {current === null ? (
                  <CheckIcon size={15} color={ink('#0b7d5c')} />
                ) : null}
              </View>
            </Pressable>
          ) : null}

          {section('Pinned', pinned)}
          {section('Recent', recent)}
          {section('No open sessions', idle)}

          {isEmpty ? (
            <Text className="px-6 py-10 text-center text-sm text-slate-500">
              {`No project matches "${query.trim()}".`}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
