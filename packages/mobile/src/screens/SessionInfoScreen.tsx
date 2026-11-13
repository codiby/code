import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchPreferences, savePinned } from '../api/preferences';
import { fetchResources, type SessionResource } from '../api/resources';
import { useSockets } from '../api/SocketProvider';
import { deleteSession, renameSession, setSessionStatus } from '../api/sessions';
import type { SessionSummary } from '../api/types';
import { ImageLightbox } from '../components/Gallery';
import { ModelPicker } from '../components/ModelPicker';
import {
  ArchiveIcon,
  CloseIcon,
  PinIcon,
  RenameDialog,
  RenameIcon,
  TrashIcon,
} from '../components/SessionList';
import { sessionMedia } from '../lib/chatMedia';
import { avatarColorFor, formatFullTimestamp, initialsOf } from '../lib/format';
import { useInk } from '../theme';

export interface SessionInfoScreenProps {
  readonly session: SessionSummary;
  readonly baseUrl: string;
  readonly token: string;
  /** Del `session_state`; `null` mientras no haya llegado. */
  readonly totalMessages: number | null;
  readonly onClose: () => void;
  readonly onOpenGallery: (kind: 'image' | 'mockup') => void;
  readonly onOpenMockup: (name: string) => void;
  /** La sesión dejó de existir: hay que salir del todo. */
  readonly onGone: () => void;
}

const STRIP_COUNT = 8;

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

const MODE_ORDER: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

/** Mismos modos y nombres que el selector del escritorio. */
const MODES: Record<
  PermissionMode,
  {
    readonly label: string;
    readonly short: string;
    readonly description: string;
    readonly activeBg: string;
    readonly activeText: string;
    readonly tone: ChipTone;
    readonly chipText: string;
  }
> = {
  default: {
    label: 'Default',
    short: 'Ask',
    description: 'Asks before running commands or editing files.',
    activeBg: 'border-slate-300 bg-white',
    activeText: 'text-slate-900',
    tone: 'neutral',
    chipText: 'text-slate-600',
  },
  acceptEdits: {
    label: 'Accept Edits',
    short: 'Edits',
    description: 'Edits files without asking; still asks before commands.',
    activeBg: 'border-slate-300 bg-white',
    activeText: 'text-emerald-700',
    tone: 'emerald',
    chipText: 'text-emerald-700',
  },
  plan: {
    label: 'Plan',
    short: 'Plan',
    description: 'Read-only: explores and proposes a plan before changing anything.',
    activeBg: 'border-slate-300 bg-white',
    activeText: 'text-violet-700',
    tone: 'violet',
    chipText: 'text-violet-700',
  },
  bypassPermissions: {
    label: 'Bypass All',
    short: 'Bypass',
    description: 'Runs every command and edit without asking. Use with care.',
    activeBg: 'border-amber-500 bg-amber-500',
    activeText: 'text-white',
    tone: 'amber',
    chipText: 'text-amber-700',
  },
};

function toPermissionMode(value: string | null | undefined): PermissionMode {
  return MODE_ORDER.find(option => option === value) ?? 'default';
}

type ChipTone = 'neutral' | 'emerald' | 'violet' | 'amber';

const CHIP_BG: Record<ChipTone, string> = {
  neutral: 'bg-slate-100',
  emerald: 'bg-emerald-500/15',
  violet: 'bg-violet-500/15',
  amber: 'bg-amber-500/15',
};

function Chip({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: ChipTone;
}) {
  return (
    <View
      className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${CHIP_BG[tone]}`}
    >
      {children}
    </View>
  );
}

/** Grupo con esquinas redondeadas, separado del borde, como los ajustes del sistema. */
function Section({
  title,
  trailing,
  onPressHeader,
  children,
}: {
  readonly title?: string;
  readonly trailing?: string;
  readonly onPressHeader?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View className="mx-4 mb-5">
      {title !== undefined ? (
        <Pressable
          accessibilityRole={onPressHeader ? 'button' : undefined}
          disabled={onPressHeader === undefined}
          onPress={onPressHeader}
          className="flex-row items-center px-1 pb-1.5 active:opacity-60"
        >
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {title}
          </Text>
          {trailing !== undefined ? (
            <Text className="ml-auto text-[12px] font-medium text-slate-400">
              {`${trailing} ›`}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      <View className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
        {children}
      </View>
    </View>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
  destructive = false,
  first = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly first?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3 ${
        first ? '' : 'border-t border-slate-200'
      } ${destructive ? 'active:bg-rose-50' : 'active:bg-slate-100'}`}
    >
      {icon}
      <Text
        className={`text-[14px] ${destructive ? 'text-rose-700' : 'text-slate-700'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Quita la extensión: el mockup se abre por nombre, no por archivo. */
function mockupName(resource: SessionResource): string {
  return resource.name.replace(/\.html$/i, '');
}

export function SessionInfoScreen({
  session,
  baseUrl,
  token,
  totalMessages,
  onClose,
  onOpenGallery,
  onOpenMockup,
  onGone,
}: SessionInfoScreenProps) {
  const ink = useInk();
  const insets = useSafeAreaInsets();

  const [resources, setResources] = useState<SessionResource[] | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [name, setName] = useState(session.name);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(session.model ?? null);
  const [isPickingModel, setIsPickingModel] = useState(false);
  const sockets = useSockets();

  useEffect(() => {
    let cancelled = false;
    fetchResources(baseUrl, token, session.id)
      .then(list => !cancelled && setResources(list))
      .catch(() => !cancelled && setResources([]));
    fetchPreferences(baseUrl, token)
      .then(prefs => !cancelled && setPinnedIds(prefs.pinnedIds))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token, session.id]);

  const images = useMemo(
    () => sessionMedia(baseUrl, token, session.key, resources ?? []),
    [baseUrl, token, session.key, resources],
  );
  const mockups = (resources ?? []).filter(item => item.name.endsWith('.html'));
  const isPinned = pinnedIds.includes(session.id);

  const togglePin = useCallback(() => {
    const next = isPinned
      ? pinnedIds.filter(id => id !== session.id)
      : [session.id, ...pinnedIds];
    setPinnedIds(next);
    savePinned(baseUrl, token, next).catch(() => undefined);
  }, [isPinned, pinnedIds, baseUrl, token, session.id]);

  const toggleArchive = useCallback(() => {
    setIsWorking(true);
    setSessionStatus(baseUrl, token, session.id, session.isOpen ? 'archived' : 'open')
      .then(onClose)
      .catch(() => undefined)
      .finally(() => setIsWorking(false));
  }, [baseUrl, token, session.id, session.isOpen, onClose]);

  const confirmDelete = useCallback(() => {
    Alert.alert(
      'Delete session',
      'It is removed from the bridge. The history on disk is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setIsWorking(true);
            deleteSession(baseUrl, token, session.id)
              .then(onGone)
              .catch(() => undefined)
              .finally(() => setIsWorking(false));
          },
        },
      ],
    );
  }, [baseUrl, token, session.id, onGone]);

  /**
   * El mismo `set_model` que manda el escritorio: el bridge lo guarda, se lo
   * pasa al proveedor si está corriendo y deja una nota en el chat.
   */
  const selectModel = useCallback(
    (next: string | null) => {
      setIsPickingModel(false);
      const sent = sockets.send(session.serverId, {
        type: 'set_model',
        sessionId: session.id,
        model: next ?? '',
      });
      if (sent) {
        setModel(next);
      } else {
        Alert.alert('Model not changed', 'The connection to the server is down.');
      }
    },
    [sockets, session.serverId, session.id],
  );

  const [mode, setMode] = useState<PermissionMode>(
    toPermissionMode(session.permissionMode),
  );
  // La lista se refresca por el socket; un cambio hecho en otro lado (el
  // escritorio, «Approve & Bypass») debe verse aquí.
  useEffect(() => {
    setMode(toPermissionMode(session.permissionMode));
  }, [session.permissionMode]);

  /** El mismo `set_permission_mode` del escritorio: el bridge lo guarda y lo aplica en vivo. */
  const applyMode = useCallback(
    (next: PermissionMode) => {
      const sent = sockets.send(session.serverId, {
        type: 'set_permission_mode',
        sessionId: session.id,
        mode: next,
      });
      if (sent) {
        setMode(next);
      } else {
        Alert.alert('Mode not changed', 'The connection to the server is down.');
      }
    },
    [sockets, session.serverId, session.id],
  );

  const selectMode = useCallback(
    (next: PermissionMode) => {
      if (next === mode) {
        return;
      }
      if (next !== 'bypassPermissions') {
        applyMode(next);
        return;
      }
      // Igual que el aviso del escritorio: bypass aprueba todo sin preguntar.
      Alert.alert(
        'Bypass permissions?',
        'The agent will run every command and edit without asking, for the rest of this session.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Bypass', style: 'destructive', onPress: () => applyMode(next) },
        ],
      );
    },
    [mode, applyMode],
  );

  const modelLabel =
    model ?? (session.defaultModel ? `Default (${session.defaultModel})` : 'Default');

  const applyRename = useCallback(
    (next: string) => {
      setIsWorking(true);
      renameSession(baseUrl, token, session.id, next)
        .then(() => setName(next))
        .catch(() => undefined)
        .finally(() => {
          setIsWorking(false);
          setIsRenaming(false);
        });
    },
    [baseUrl, token, session.id],
  );

  return (
    <View className="absolute inset-0 bg-white">
      <View
        style={{ paddingTop: insets.top + 8 }}
        className="flex-row items-center gap-2 bg-white px-2 pb-2"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
        >
          <CloseIcon size={20} color={ink('#0f172a')} />
        </Pressable>
        <Text className="flex-1 text-base font-semibold text-slate-900">
          Session info
        </Text>
        {isWorking ? <ActivityIndicator size="small" color={ink('#64748b')} /> : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View className="items-center px-6 pb-5 pt-3">
          <View
            style={{ backgroundColor: avatarColorFor(session.id) }}
            className="h-[72px] w-[72px] items-center justify-center rounded-full"
          >
            <Text className="text-2xl font-bold text-white">
              {initialsOf(name)}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rename session"
            onPress={() => setIsRenaming(true)}
            className="mt-3 flex-row items-center gap-1.5 active:opacity-60"
          >
            <Text className="text-center text-[19px] font-bold text-slate-900">
              {name}
            </Text>
            <RenameIcon size={13} color={ink('#94a3b8')} />
          </Pressable>

          <Text
            numberOfLines={1}
            className="mt-1 font-mono text-[11px] text-slate-400"
          >
            {session.cwd}
          </Text>

          <View className="mt-3 flex-row flex-wrap justify-center gap-1.5">
            <Chip>
              <View
                className={`h-1.5 w-1.5 rounded-full ${
                  session.isRunning ? 'bg-emerald-500' : 'bg-slate-400'
                }`}
              />
              <Text className="text-[11px] font-semibold text-slate-600">
                {!session.isOpen ? 'archived' : session.isRunning ? 'running' : 'idle'}
              </Text>
            </Chip>
            {session.provider !== null ? (
              <Chip>
                <Text className="text-[11px] font-semibold text-slate-600">
                  {session.provider}
                </Text>
              </Chip>
            ) : null}
            <Chip tone={MODES[mode].tone}>
              <Text className={`text-[11px] font-semibold ${MODES[mode].chipText}`}>
                {MODES[mode].label}
              </Text>
            </Chip>
          </View>
        </View>

        <Section title="Agent">
          <View className="px-4 pb-3.5 pt-3">
            <Text className="text-[12px] font-medium text-slate-500">
              Permission mode
            </Text>
            <View className="mt-2 flex-row gap-1 rounded-xl bg-slate-100 p-1">
              {MODE_ORDER.map(option => {
                const isActive = option === mode;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isActive }}
                    accessibilityLabel={`Permission mode ${MODES[option].label}`}
                    onPress={() => selectMode(option)}
                    className={`flex-1 items-center rounded-lg border py-2 ${
                      isActive ? MODES[option].activeBg : 'border-transparent active:opacity-60'
                    }`}
                  >
                    <Text
                      numberOfLines={1}
                      className={`text-[12px] font-semibold ${
                        isActive ? MODES[option].activeText : 'text-slate-500'
                      }`}
                    >
                      {MODES[option].short}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text className="mt-2 text-[11.5px] leading-[16px] text-slate-400">
              {MODES[mode].description}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change model"
            onPress={() => setIsPickingModel(true)}
            className="flex-row items-center border-t border-slate-200 px-4 py-3 active:bg-slate-100"
          >
            <Text className="text-[13.5px] text-slate-700">Model</Text>
            <Text
              numberOfLines={1}
              className="ml-3 flex-1 text-right text-[13.5px] font-medium text-slate-900"
            >
              {modelLabel}
            </Text>
            <Text className="ml-2 text-[15px] text-slate-400">›</Text>
          </Pressable>
        </Section>

        {resources === null ? (
          <View className="items-center py-6">
            <ActivityIndicator size="small" color={ink('#94a3b8')} />
          </View>
        ) : (
          <Section
            title="Media"
            trailing={`${images.length + mockups.length}`}
            onPressHeader={() => onOpenGallery('image')}
          >
            {images.length === 0 && mockups.length === 0 ? (
              <Text className="px-4 py-3.5 text-[12.5px] text-slate-400">
                No images or mockups yet
              </Text>
            ) : null}
            {images.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-1.5 p-3"
              >
                {images.slice(0, STRIP_COUNT).map((item, index) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={item.name}
                    // Tocar una miniatura abre esa imagen, no la rejilla:
                    // la rejilla se llega por el contador de la cabecera.
                    onPress={() => setZoomedIndex(index)}
                    className="active:opacity-80"
                  >
                    <Image
                      source={{ uri: item.uri }}
                      className="h-[68px] w-[68px] rounded-xl bg-slate-100"
                    />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {mockups.map(item => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${mockupName(item)}`}
                onPress={() => onOpenMockup(mockupName(item))}
                className="flex-row items-center gap-3 border-t border-slate-200 px-4 py-2.5 active:bg-slate-100"
              >
                <View className="h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
                  <Text className="text-[13px] text-white">◨</Text>
                </View>
                <View className="flex-1">
                  <Text
                    numberOfLines={1}
                    className="text-[13px] font-semibold text-slate-900"
                  >
                    {mockupName(item)}
                  </Text>
                  <Text className="text-[11px] text-slate-400">
                    {`Mockup · ${sizeLabel(item.size)}`}
                  </Text>
                </View>
                <Text className="text-[15px] text-slate-400">›</Text>
              </Pressable>
            ))}
          </Section>
        )}

        <Section title="Details">
          {[
            ['Folder', session.cwd],
            ['Provider', session.provider ?? '—'],
            ['Updated', formatFullTimestamp(session.updatedAt)],
            // `totalMessages` viene del `session_state` del chat: pedirlo solo
            // para esta ficha significaría abrir otro socket.
            ['Messages', totalMessages === null ? '—' : String(totalMessages)],
          ].map(([key, value], index) => (
            <View
              key={key}
              className={`flex-row items-center px-4 py-3 ${
                index === 0 ? '' : 'border-t border-slate-200'
              }`}
            >
              <Text className="text-[13.5px] text-slate-700">{key}</Text>
              <Text
                numberOfLines={1}
                ellipsizeMode="head"
                className={`ml-4 flex-1 text-right text-slate-500 ${
                  key === 'Folder' ? 'font-mono text-[11.5px]' : 'text-[13.5px]'
                }`}
              >
                {value}
              </Text>
            </View>
          ))}
        </Section>

        <Section>
          <ActionRow
            icon={<PinIcon size={18} color={isPinned ? ink('#0f172a') : ink('#475569')} />}
            label={isPinned ? 'Unpin from top' : 'Pin to top'}
            onPress={togglePin}
            first
          />
          <ActionRow
            icon={<ArchiveIcon size={18} color={ink('#475569')} />}
            label={session.isOpen ? 'Archive' : 'Unarchive'}
            onPress={toggleArchive}
          />
        </Section>

        <Section>
          <ActionRow
            icon={<TrashIcon size={18} color={ink('#be123c')} />}
            label="Delete session"
            onPress={confirmDelete}
            destructive
            first
          />
        </Section>
      </ScrollView>

      {zoomedIndex !== null ? (
        <ImageLightbox
          items={images}
          initialIndex={zoomedIndex}
          onClose={() => setZoomedIndex(null)}
        />
      ) : null}

      <ModelPicker
        visible={isPickingModel}
        baseUrl={baseUrl}
        token={token}
        provider={session.provider}
        current={model}
        onSelect={selectModel}
        onClose={() => setIsPickingModel(false)}
      />

      <RenameDialog
        visible={isRenaming}
        initialName={name}
        isWorking={isWorking}
        onCancel={() => setIsRenaming(false)}
        onSubmit={applyRename}
      />
    </View>
  );
}
