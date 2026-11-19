/**
 * El bloque ```ui en la app nativa: explicaciones visuales dentro de la
 * respuesta del agente. Misma gramática que el escritorio (lib/uiBlock.ts);
 * aquí cambia el acomodo para una pantalla angosta: el flujo va en vertical y
 * el detalle del paso se abre debajo de él, las métricas van de dos en dos.
 *
 * `cx-html` corre en un WebView sin scroll propio que mide su alto y lo avisa,
 * con los colores del tema inyectados como variables CSS.
 */

import {
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useInk, useIsDark } from '../../theme';
import { DARK_PAGE } from '../../themeInk';
import { parseUiBlock, type UiNode, type UiTone } from '../../lib/uiBlock';
import { SendMessageContext } from './SendMessageContext';

type Renderers = {
  readonly renderMd: (text: string) => ReactNode;
  readonly renderInline: (text: string) => ReactNode;
};

const TONE_BG: Record<UiTone, string> = {
  accent: 'bg-violet-500',
  red: 'bg-rose-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  blue: 'bg-blue-500',
  muted: 'bg-slate-400',
};

function Label({ text }: { readonly text: string }) {
  if (text.length === 0) {
    return null;
  }
  return (
    <Text className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
      {text}
    </Text>
  );
}

const CALLOUT = {
  warn: {
    box: 'bg-amber-50 border-amber-500',
    icon: 'text-amber-600',
    glyph: '!',
  },
  info: {
    box: 'bg-blue-50 border-blue-500',
    icon: 'text-blue-600',
    glyph: 'i',
  },
  ok: {
    box: 'bg-emerald-50 border-emerald-500',
    icon: 'text-emerald-600',
    glyph: '✓',
  },
} as const;

function Callout({
  node,
  renderInline,
}: { readonly node: Extract<UiNode, { kind: 'callout' }> } & Pick<
  Renderers,
  'renderInline'
>) {
  const style = CALLOUT[node.tone];
  return (
    <View
      className={`flex-row gap-2 rounded-lg border-l-[3px] px-3 py-2 ${style.box}`}
    >
      <Text className={`font-bold ${style.icon}`}>{style.glyph}</Text>
      <Text className="min-w-0 shrink text-[13.5px] leading-5 text-slate-800">
        {renderInline(node.text)}
      </Text>
    </View>
  );
}

function Flow({
  node,
  renderInline,
}: { readonly node: Extract<UiNode, { kind: 'flow' }> } & Pick<
  Renderers,
  'renderInline'
>) {
  const [cur, setCur] = useState(() =>
    Math.max(
      0,
      node.steps.findIndex(s => s.hot),
    ),
  );
  return (
    <View>
      <Label text={node.label} />
      {node.steps.map((step, index) => {
        const isOn = index === cur;
        return (
          <View key={index}>
            {index > 0 ? (
              <Text className="py-0.5 pl-4 text-[11px] text-slate-300">↓</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: isOn }}
              onPress={() => setCur(index)}
              className={`rounded-lg border px-3 py-2 ${
                isOn
                  ? 'border-violet-500 bg-violet-50'
                  : 'border-slate-200 bg-slate-50'
              }`}
            >
              <View className="flex-row items-center gap-1.5">
                {step.hot ? (
                  <View className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                ) : null}
                <Text className="text-[13px] font-semibold text-slate-800">
                  {step.title}
                </Text>
                {step.sub.length > 0 ? (
                  <Text
                    numberOfLines={1}
                    className="min-w-0 shrink font-mono text-[10.5px] text-slate-400"
                  >
                    {step.sub}
                  </Text>
                ) : null}
              </View>
              {isOn && step.text.length > 0 ? (
                <Text className="mt-1 text-[12.5px] leading-[18px] text-slate-600">
                  {renderInline(step.text)}
                </Text>
              ) : null}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function Bars({ node }: { readonly node: Extract<UiNode, { kind: 'bars' }> }) {
  const [view, setView] = useState(0);
  const max = Math.max(1, ...node.bars.flatMap(b => b.values));
  const scale = node.unit === '%' ? Math.max(100, max) : max;
  return (
    <View>
      <Label text={node.label} />
      {node.views.length > 1 ? (
        <View className="mb-2.5 flex-row self-start rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {node.views.map((name, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityState={{ selected: index === view }}
              onPress={() => setView(index)}
              className={`rounded-md px-3 py-1 ${
                index === view ? 'bg-white' : ''
              }`}
            >
              <Text
                className={`text-[12px] ${
                  index === view
                    ? 'font-semibold text-slate-800'
                    : 'text-slate-500'
                }`}
              >
                {name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {node.bars.map((bar, index) => {
        const value = bar.values[view] ?? 0;
        return (
          <View key={index} className="mb-2">
            <View className="mb-1 flex-row justify-between">
              <Text className="text-[12px] text-slate-600">{bar.label}</Text>
              <Text className="font-mono text-[11px] text-slate-500">{`${value}${node.unit}`}</Text>
            </View>
            <View className="h-2 overflow-hidden rounded bg-slate-100">
              <View
                className={`h-full rounded ${TONE_BG[bar.tone]}`}
                style={{ width: `${Math.min(100, (value / scale) * 100)}%` }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Stats({
  node,
}: {
  readonly node: Extract<UiNode, { kind: 'stats' }>;
}) {
  return (
    <View>
      <Label text={node.label} />
      <View className="flex-row flex-wrap gap-2">
        {node.stats.map((stat, index) => (
          <View
            key={index}
            className="min-w-[46%] flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
          >
            <Text className="text-[17px] font-semibold text-slate-900">
              {stat.value}
            </Text>
            {stat.delta.length > 0 ? (
              <Text
                className={`text-[11.5px] font-semibold ${
                  stat.trend === 'good'
                    ? 'text-emerald-600'
                    : stat.trend === 'bad'
                    ? 'text-rose-600'
                    : 'text-slate-500'
                }`}
              >
                {stat.delta}
              </Text>
            ) : null}
            <Text className="text-[11px] text-slate-500">{stat.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const STATUS: Record<string, string> = {
  M: 'text-amber-600 bg-amber-50',
  A: 'text-emerald-600 bg-emerald-50',
  D: 'text-rose-600 bg-rose-50',
};

function Files({
  node,
}: {
  readonly node: Extract<UiNode, { kind: 'files' }>;
}) {
  return (
    <View>
      <Label text={node.label} />
      <View className="rounded-lg border border-slate-200 bg-slate-50 py-1">
        {node.files.map((file, index) => (
          <View key={index} className="flex-row items-start gap-2 px-3 py-1">
            <View className="min-w-0 flex-1">
              <Text className="font-mono text-[11.5px] text-slate-800">
                {file.path}
              </Text>
              {file.note.length > 0 ? (
                <Text className="text-[11.5px] text-slate-500">
                  {file.note}
                </Text>
              ) : null}
            </View>
            {file.status.length > 0 ? (
              <Text
                className={`rounded px-1.5 font-mono text-[10px] ${
                  STATUS[file.status] ?? 'bg-slate-100 text-slate-500'
                }`}
              >
                {file.status}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function Choice({
  node,
  storageKey,
  renderInline,
}: {
  readonly node: Extract<UiNode, { kind: 'choice' }>;
  readonly storageKey: string;
} & Pick<Renderers, 'renderInline'>) {
  const send = useContext(SendMessageContext);
  const [picked, setPicked] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    storage().getItem(storageKey)
      .then(value => {
        if (alive && value !== null) {
          setSent(value);
          setPicked(value);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [storageKey]);

  const submit = () => {
    if (picked === null || sent !== null || send === null) {
      return;
    }
    setSent(picked);
    storage().setItem(storageKey, picked).catch(() => undefined);
    send(node.label.length > 0 ? `${node.label}: ${picked}` : picked);
  };

  const canSend = picked !== null && sent === null && send !== null;
  return (
    <View>
      <Label text={node.label} />
      <View className="gap-2">
        {node.choices.map((choice, index) => {
          const isOn = picked === choice.title;
          return (
            <Pressable
              key={index}
              accessibilityRole="radio"
              accessibilityState={{ checked: isOn, disabled: sent !== null }}
              disabled={sent !== null}
              onPress={() => setPicked(choice.title)}
              className={`rounded-lg border px-3 py-2.5 ${
                isOn
                  ? 'border-violet-500 bg-violet-50'
                  : 'border-slate-200 bg-slate-50'
              } ${sent !== null && !isOn ? 'opacity-40' : ''}`}
            >
              <View className="flex-row flex-wrap items-center gap-1.5">
                <Text className="text-[13.5px] font-semibold text-slate-800">
                  {choice.title}
                </Text>
                {choice.recommended ? (
                  <Text className="rounded bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-600">
                    Recommended
                  </Text>
                ) : null}
              </View>
              {choice.text.length > 0 ? (
                <Text className="mt-0.5 text-[12.5px] leading-[18px] text-slate-500">
                  {renderInline(choice.text)}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send choice"
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={submit}
        className={`mt-2.5 self-end rounded-lg bg-violet-600 px-4 py-2 ${
          canSend ? '' : 'opacity-30'
        }`}
      >
        <Text className="text-[13px] font-semibold text-white">
          {sent !== null
            ? 'Sent'
            : picked !== null
            ? `Send: ${picked}`
            : 'Send'}
        </Text>
      </Pressable>
    </View>
  );
}

/** Los tokens que documenta el prompt, con los valores del tema actual. */
function useThemeCss(): string {
  const ink = useInk();
  const dark = useIsDark();
  const vars: Record<string, string> = {
    '--bg': dark ? DARK_PAGE : '#ffffff',
    '--surface': ink('#f8fafc'),
    '--surface-2': ink('#f1f5f9'),
    '--surface-3': ink('#e2e8f0'),
    '--border': ink('#e2e8f0'),
    '--border-2': ink('#cbd5e1'),
    '--text': ink('#1e293b'),
    '--text-2': ink('#475569'),
    '--muted': ink('#94a3b8'),
    '--accent': dark ? '#a78bfa' : '#7c3aed',
    '--red': dark ? '#f87171' : '#dc2626',
    '--amber': dark ? '#fbbf24' : '#d97706',
    '--green': dark ? '#4ade80' : '#059669',
    '--blue': dark ? '#60a5fa' : '#2563eb',
    '--font': '-apple-system, system-ui, Roboto, sans-serif',
    '--mono': 'ui-monospace, Menlo, monospace',
  };
  const body = Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `:root{${body};color-scheme:${dark ? 'dark' : 'light'}}`;
}

/*
 * AsyncStorage y el WebView se cargan al usarse, no al importar: Markdown está
 * en casi todas las pantallas y sus tests no tienen por qué simular módulos
 * nativos que solo pide un bloque ```ui.
 */
type Storage = typeof import('@react-native-async-storage/async-storage').default;
const storage = (): Storage => {
  const mod = require('@react-native-async-storage/async-storage');
  return (mod.default ?? mod) as Storage;
};
const loadWebView = (): typeof import('react-native-webview').WebView =>
  require('react-native-webview').WebView;

const MAX_HTML_HEIGHT = 1600;

/** Mide el documento y le avisa a RN cada vez que cambia de alto. */
const MEASURE = `(function(){
  var post=function(){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(String(Math.ceil(document.documentElement.getBoundingClientRect().height)))};
  if(window.ResizeObserver){new ResizeObserver(post).observe(document.documentElement)}
  window.addEventListener('load',post);setTimeout(post,300);post();
})();true;`;

function HtmlFrame({ html }: { readonly html: string }) {
  const WebView = useMemo(loadWebView, []);
  const css = useThemeCss();
  const [height, setHeight] = useState(80);
  const source = useMemo(
    () => ({
      html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>${css}
html,body{margin:0;background:transparent;color:var(--text);font:13px/1.55 var(--font);overflow:hidden}
code{font-family:var(--mono)}</style></head><body>${html}</body></html>`,
    }),
    [css, html],
  );
  return (
    <WebView
      source={source}
      originWhitelist={['*']}
      javaScriptEnabled
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      injectedJavaScript={MEASURE}
      onMessage={event => {
        const next = Number(event.nativeEvent.data);
        if (Number.isFinite(next) && next > 0) {
          setHeight(Math.min(MAX_HTML_HEIGHT, next));
        }
      }}
      // `className` no aplica al WebView (ver MockupViewer).
      style={[styles.web, { height }]}
    />
  );
}

/** Clave estable del bloque sin id de mensaje: un hash del propio texto. */
/* eslint-disable no-bitwise -- djb2 */
function hashSource(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
/* eslint-enable no-bitwise */

export const UiBlockView = memo(function UiBlockBody({
  source,
  renderMd,
  renderInline,
}: { readonly source: string } & Renderers) {
  const nodes = useMemo(() => parseUiBlock(source), [source]);
  const key = useMemo(() => hashSource(source), [source]);
  if (nodes.length === 0) {
    return (
      <Text className="font-mono text-[11px] text-slate-500">{source}</Text>
    );
  }
  return (
    <View className="my-1 gap-4">
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'md':
            return <View key={index}>{renderMd(node.text)}</View>;
          case 'callout':
            return (
              <Callout key={index} node={node} renderInline={renderInline} />
            );
          case 'flow':
            return <Flow key={index} node={node} renderInline={renderInline} />;
          case 'bars':
            return <Bars key={index} node={node} />;
          case 'stats':
            return <Stats key={index} node={node} />;
          case 'files':
            return <Files key={index} node={node} />;
          case 'choice':
            return (
              <Choice
                key={index}
                node={node}
                storageKey={`codiby-ui-choice:${key}:${index}`}
                renderInline={renderInline}
              />
            );
          case 'html':
            return <HtmlFrame key={index} html={node.html} />;
          default:
            return null;
        }
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  web: { backgroundColor: 'transparent' },
});
