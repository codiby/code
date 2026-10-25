import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  type ProviderUsage,
  type UsageWindow,
  usageHeadline,
} from '../api/usage';
import { useUsage } from '../api/useUsage';
import { useServers } from '../config/ServerConfigContext';

const COLORS = { normal: '#7c3aed', warning: '#d97706', critical: '#dc2626' };

export function UsageIndicator({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { entries, refresh } = useUsage(open);
  const { servers } = useServers();
  const insets = useSafeAreaInsets();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setInterval(() => tick(value => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  const results = Object.values(entries);
  const headline = usageHeadline(
    results.flatMap(r => (r.snapshot ? [r.snapshot] : [])),
  );
  const loading = results.some(r => r.loading);
  const hasError = results.some(
    r => r.error || r.snapshot?.providers.some(p => p.status === 'error'),
  );
  const color = headline ? COLORS[headline.severity] : '#64748b';

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Uso del plan${
          headline ? `, ${headline.percent}% utilizado` : ''
        }${hasError ? ', datos incompletos' : ''}`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={`min-h-11 flex-row items-center gap-1.5 rounded-xl px-2 ${
          disabled ? 'opacity-40' : 'active:bg-slate-100'
        }`}
      >
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Path
            d="M4.9 19a9 9 0 1 1 14.2 0H4.9ZM12 13l4-4"
            stroke={color}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
        <Text style={{ color }} className="text-[11px] font-semibold">
          Uso{headline ? ` ${headline.percent}%` : ''}
          {hasError ? ' !' : ''}
        </Text>
        {loading && !headline ? (
          <ActivityIndicator size="small" color={color} />
        ) : null}
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 justify-end bg-slate-900/45">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cerrar uso del plan"
            onPress={() => setOpen(false)}
            className="flex-1"
          />
          <View
            style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
            className="rounded-t-3xl bg-white pt-2"
          >
            <View className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300" />
            <View className="flex-row items-center px-5 pb-3">
              <View className="flex-1">
                <Text className="text-base font-bold text-slate-900">
                  Uso del plan
                </Text>
                <Text className="mt-0.5 text-xs text-slate-500">
                  Límites por servidor y proveedor
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Actualizar uso"
                accessibilityState={{ disabled: loading }}
                disabled={loading}
                onPress={refresh}
                className="min-h-11 justify-center px-3 active:opacity-60"
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#7c3aed" />
                ) : (
                  <Text className="text-xs font-semibold text-violet-700">
                    Actualizar
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cerrar detalle de uso"
                onPress={() => setOpen(false)}
                className="min-h-11 justify-center pl-2"
              >
                <Text className="text-sm text-slate-500">Cerrar</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerClassName="px-5 pb-3">
              {servers.map(server => {
                const result = entries[server.id];
                const providers =
                  result?.snapshot?.providers.filter(
                    p => p.status !== 'logged_out',
                  ) ?? [];
                return (
                  <View
                    key={server.id}
                    className="border-t border-slate-100 py-4"
                  >
                    <Text className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
                      {server.name || 'Sin nombre'}
                    </Text>
                    {result?.error ? (
                      <Text
                        accessibilityRole="alert"
                        className="mb-3 text-xs text-amber-700"
                      >
                        {result.error}
                        {result.snapshot
                          ? ' · Se muestran los últimos datos disponibles.'
                          : ''}
                      </Text>
                    ) : null}
                    {!result || (result.loading && !result.snapshot) ? (
                      <Text className="text-xs text-slate-500">
                        Cargando uso…
                      </Text>
                    ) : null}
                    {result?.snapshot && providers.length === 0 ? (
                      <Text className="text-xs text-slate-500">
                        No hay proveedores con sesión iniciada.
                      </Text>
                    ) : null}
                    {providers.map(provider => (
                      <ProviderDetails
                        key={provider.provider}
                        usage={provider}
                      />
                    ))}
                    {result?.snapshot ? (
                      <Text className="mt-2 text-[10px] text-slate-400">
                        Actualizado:{' '}
                        {new Date(result.snapshot.fetchedAt).toLocaleString(
                          'es-MX',
                        )}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function ProviderDetails({ usage }: { usage: ProviderUsage }) {
  return (
    <View className="mb-3 rounded-2xl bg-slate-50 p-3">
      <View className="mb-2 flex-row flex-wrap items-center gap-2">
        <Text className="text-sm font-bold text-slate-900">
          {usage.provider === 'claude' ? 'Claude' : 'Codex'}
        </Text>
        {usage.account?.plan ? (
          <Text className="rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800">
            {usage.account.plan}
          </Text>
        ) : null}
      </View>
      {usage.account?.email ? (
        <Text className="mb-3 text-xs text-slate-500">
          {usage.account.email}
        </Text>
      ) : null}
      {usage.status === 'error' ? (
        <Text className="text-xs text-amber-700">
          {usage.error || 'No se pudo leer el uso'}
        </Text>
      ) : usage.windows.length === 0 ? (
        <Text className="text-xs text-slate-500">Sin límites disponibles</Text>
      ) : (
        usage.windows.map(window => <Meter key={window.id} window={window} />)
      )}
      {usage.breakdown?.map(row => (
        <View key={row.key} className="mt-1 flex-row justify-between gap-2">
          <Text className="text-xs text-slate-500">{row.label}</Text>
          <Text className="text-xs text-slate-600">{row.percent}%</Text>
        </View>
      ))}
      {usage.credits ? (
        <Text className="mt-3 text-xs text-slate-500">
          {usage.credits.label}
          {formatCredits(usage.credits)}
        </Text>
      ) : null}
    </View>
  );
}

function Meter({ window: w }: { window: UsageWindow }) {
  const label =
    w.kind === 'session'
      ? 'Sesión'
      : w.kind === 'weekly'
      ? 'Semanal'
      : w.label || 'Límite';
  const detail =
    w.scope ||
    (w.windowMinutes
      ? formatDuration(w.windowMinutes)
      : w.kind === 'weekly'
      ? 'todos los modelos'
      : null);
  return (
    <View className="mb-3">
      <View className="mb-1 flex-row items-center gap-2">
        <Text className="flex-1 text-xs text-slate-600">
          {label}
          {detail ? ` · ${detail}` : ''}
        </Text>
        <Text
          style={{ color: COLORS[w.severity] }}
          className="text-xs font-bold"
        >
          {w.percent}%
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: Math.max(0, Math.min(100, w.percent)),
          text: `${w.percent}% utilizado`,
        }}
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
      >
        <View
          style={{
            width: `${Math.max(0, Math.min(100, w.percent))}%`,
            backgroundColor: COLORS[w.severity],
          }}
          className="h-full rounded-full"
        />
      </View>
      <Text className="mt-1 text-[10px] text-slate-500">
        {w.percent >= 100 ? 'Límite alcanzado · ' : ''}
        {formatReset(w.resetsAt)}
        {w.isActive ? ' · activo ahora' : ''}
      </Text>
    </View>
  );
}

function formatDuration(minutes: number) {
  if (minutes % 10080 === 0) {
    return `${minutes / 10080} sem`;
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440} d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} h`;
  }
  return `${minutes} min`;
}

function formatReset(iso?: string | null) {
  if (!iso) {
    return 'Sin reinicio';
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return 'Sin reinicio';
  }
  const minutes = Math.ceil((date.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) {
    return 'Reiniciando…';
  }
  const remaining =
    minutes >= 1440
      ? `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`
      : minutes >= 60
      ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
      : `${minutes} min`;
  return `Se reinicia en ${remaining} · ${date.toLocaleString('es-MX', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatCredits(credits: NonNullable<ProviderUsage['credits']>) {
  const money = (minor: number) =>
    (minor / 100).toLocaleString('es-MX', {
      style: 'currency',
      currency: credits.currency || 'USD',
    });
  if (credits.usedMinor != null && credits.limitMinor != null) {
    return ` · ${money(credits.usedMinor)} / ${money(credits.limitMinor)}`;
  }
  if (credits.limitMinor != null) {
    return ` · ${money(credits.limitMinor)}`;
  }
  if (credits.usedMinor != null) {
    return ` · ${money(credits.usedMinor)}`;
  }
  return '';
}

const styles = StyleSheet.create({ sheet: { maxHeight: '80%' } });
