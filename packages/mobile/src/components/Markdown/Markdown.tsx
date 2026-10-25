import Clipboard from '@react-native-clipboard/clipboard';
import { Fragment, memo, useContext, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import type { InlineNode, MarkdownBlock } from '../../lib/markdown';
import { inlineText, parseMarkdown } from '../../lib/markdown';
import { CheckIcon, CopyIcon } from '../Chat/icons';
import { DiffDocView } from './DiffDocView';
import { TableScrollBoundary } from './TableScrollBoundary';
import { HorizontalScrollGestureContext } from '../ScrollGestureContext';

export interface MarkdownProps {
  readonly text: string;
}

/** Igual que el escritorio: los bloques largos se recortan. */
const MAX_CODE_LINES = 30;

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[17px] font-bold leading-tight text-slate-900 mt-3 mb-1.5',
  2: 'text-[15px] font-semibold leading-tight text-slate-900 mt-2.5 mb-1',
  3: 'text-[14px] font-semibold leading-snug text-slate-800 mt-2 mb-1',
  4: 'text-[13px] font-semibold leading-snug text-slate-700 mt-1.5 mb-0.5',
  5: 'text-[12px] font-semibold uppercase tracking-wide text-slate-500 mt-1.5 mb-0.5',
  6: 'text-[11px] font-medium uppercase tracking-wide text-slate-400 mt-1 mb-0.5',
};

function openUrl(url: string) {
  Linking.openURL(url).catch(() => {
    // Un esquema que el sistema no sabe abrir no debe tumbar la burbuja.
  });
}

/** El escritorio deja el check del código en línea 1,2 s, menos que el bloque. */
const INLINE_COPIED_MS = 1_200;

/**
 * Código en línea, copiable al tocarlo.
 *
 * En el escritorio hay un botón diminuto que asoma en la esquina al pasar el
 * ratón. Aquí no hay hover, y un botón de 17 px flotando sobre cada `código`
 * sería ruido imposible de atinar — así que el que se toca es el propio
 * fragmento, y la confirmación es que se pone verde.
 */
function InlineCode({ value }: { readonly value: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const copy = () => {
    Clipboard.setString(value);
    setIsCopied(true);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setIsCopied(false), INLINE_COPIED_MS);
  };

  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={`Copiar ${value}`}
      onPress={copy}
      suppressHighlighting
      className={`rounded px-1 font-mono text-[11px] ${
        isCopied ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-indigo-700'
      }`}
    >
      {value}
    </Text>
  );
}

function Inline({ nodes }: { readonly nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.type}-${index}`;
        switch (node.type) {
          case 'text':
            return <Fragment key={key}>{node.value}</Fragment>;
          case 'code':
            return <InlineCode key={key} value={node.value} />;
          case 'strong':
            return (
              <Text key={key} className="font-semibold text-slate-900">
                <Inline nodes={node.children} />
              </Text>
            );
          case 'em':
            return (
              <Text key={key} className="italic">
                <Inline nodes={node.children} />
              </Text>
            );
          case 'strike':
            return (
              <Text key={key} className="text-slate-400 line-through">
                <Inline nodes={node.children} />
              </Text>
            );
          case 'link':
            return (
              <Text
                key={key}
                className="text-blue-600 underline"
                onPress={() => openUrl(node.url)}
              >
                <Inline nodes={node.children} />
              </Text>
            );
          case 'session':
            return (
              <Text
                key={key}
                className="rounded bg-indigo-50 px-1 text-[12px] font-medium text-indigo-700"
              >
                {`\u{1F4AC} ${node.label}`}
              </Text>
            );
          case 'snippet':
            return (
              <Text
                key={key}
                className="rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-600"
              >
                {`\u{1F4C4} ${node.label}`}
              </Text>
            );
          case 'image':
            return (
              <Text key={key} className="text-[12px] italic text-slate-400">
                {`\u{1F5BC} ${node.alt || 'imagen'}`}
              </Text>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** Cuánto dura el «Copiado», igual que en el escritorio. */
const COPIED_MS = 1_500;

function CodeBlock({ lang, value }: { readonly lang: string; readonly value: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sin esto, copiar y salir del chat antes de los 1,5 s deja un setState
  // apuntando a un componente ya desmontado.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const lines = value.split('\n');
  const clipped = lines.length > MAX_CODE_LINES && !isExpanded;
  const shown = clipped ? lines.slice(0, MAX_CODE_LINES).join('\n') : value;

  const copy = () => {
    // Se copia el bloque entero, no lo que se ve: recortarlo a 30 líneas
    // daría un fragmento truncado sin avisar.
    Clipboard.setString(value);
    setIsCopied(true);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setIsCopied(false), COPIED_MS);
  };

  return (
    <View className="my-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      {/* La barra existe siempre, aunque no haya lenguaje: en el escritorio el
          botón aparece al pasar el ratón y aquí no hay hover, así que necesita
          un sitio fijo donde vivir sin taparle la primera línea al código. */}
      <View className="flex-row items-center justify-between border-b border-slate-800 bg-slate-800/60 py-1 pl-2.5 pr-1">
        <Text className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {lang.length > 0 ? lang : 'código'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copiar código"
          onPress={copy}
          // El área táctil se agranda sin agrandar el dibujo: el botón mide
          // menos que los 44 px que pide una diana cómoda.
          hitSlop={10}
          className="flex-row items-center gap-1 rounded px-1.5 py-1 active:bg-slate-700"
        >
          {isCopied ? (
            <CheckIcon size={11} color="#4ade80" />
          ) : (
            <CopyIcon size={11} color="#94a3b8" />
          )}
          <Text
            className={`text-[10px] ${
              isCopied ? 'text-green-400' : 'text-slate-400'
            }`}
          >
            {isCopied ? 'Copiado' : 'Copiar'}
          </Text>
        </Pressable>
      </View>

      <Text className="px-2.5 py-2 font-mono text-[11px] leading-[17px] text-slate-200">
        {shown}
      </Text>

      {clipped ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setIsExpanded(true)}
          className="border-t border-slate-800 px-2.5 py-1.5 active:bg-slate-800"
        >
          <Text className="text-[10px] text-slate-400">
            {`▾ Ver ${lines.length - MAX_CODE_LINES} líneas más`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Ancho aproximado de un carácter a 11 px, para dimensionar columnas. */
const CHAR_WIDTH = 6.4;
const MIN_COLUMN = 62;
const MAX_COLUMN = 240;

/**
 * Las columnas se dimensionan por su contenido, no a partes iguales: repartir
 * el ancho por igual le daba 60 px a una columna de títulos y partía las
 * palabras carácter a carácter. Si la suma no cabe, se desplaza de lado.
 */
function Table({ block }: { readonly block: Extract<MarkdownBlock, { type: 'table' }> }) {
  const claimHorizontalTouch = useContext(HorizontalScrollGestureContext);

  const widths = block.headers.map((header, column) => {
    const longest = Math.max(
      inlineText(header).length,
      ...block.rows.map(row => inlineText(row[column] ?? []).length),
    );
    return Math.min(Math.max(longest * CHAR_WIDTH + 18, MIN_COLUMN), MAX_COLUMN);
  });

  return (
    <TableScrollBoundary>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        // El bloqueo direccional es exclusivo de iOS.
        directionalLockEnabled
        onTouchStartCapture={claimHorizontalTouch}
        className="my-1.5 grow-0"
      >
        <View className="overflow-hidden rounded-lg border border-slate-200">
          <View className="flex-row bg-slate-50">
            {block.headers.map((cell, index) => (
              <Text
                key={index}
                style={{ width: widths[index] }}
                className="border-b border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500"
              >
                <Inline nodes={cell} />
              </Text>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View key={rowIndex} className="flex-row">
              {row.map((cell, cellIndex) => (
                <Text
                  key={cellIndex}
                  style={{ width: widths[cellIndex] }}
                  className="border-b border-slate-100 px-2 py-1 text-[11px] text-slate-700"
                >
                  <Inline nodes={cell} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </TableScrollBoundary>
  );
}

function Block({ block }: { readonly block: MarkdownBlock }) {
  switch (block.type) {
    case 'spacer':
      return <View className="h-2" />;
    case 'rule':
      return <View className="my-2 h-px bg-slate-200" />;
    case 'heading':
      return (
        <Text className={HEADING_CLASS[block.level] ?? HEADING_CLASS[3]!}>
          <Inline nodes={block.content} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text className="text-[13px] leading-5 text-slate-800">
          <Inline nodes={block.content} />
        </Text>
      );
    case 'quote':
      return (
        <View className="my-1 border-l-2 border-slate-300 pl-2.5">
          <Text className="text-[13px] italic leading-5 text-slate-500">
            <Inline nodes={block.content} />
          </Text>
        </View>
      );
    case 'code':
      // `diffdoc` no es un lenguaje: es una figura que se compone aparte.
      return block.lang === 'diffdoc' ? (
        <DiffDocView source={block.value} />
      ) : (
        <CodeBlock lang={block.lang} value={block.value} />
      );
    case 'list':
      return (
        <View className="my-1">
          {block.items.map((item, index) => (
            <View key={index} className="flex-row items-start gap-1.5">
              <Text className="mt-px w-4 text-right text-[13px] leading-5 text-slate-400">
                {item.checked !== null
                  ? item.checked
                    ? '☑'
                    : '☐'
                  : block.ordered
                    ? `${item.marker}.`
                    : '•'}
              </Text>
              {/* `shrink`, no `flex-1`: la burbuja toma su ancho del contenido,
                  y con base 0 el texto no aportaba ancho y Android medía su
                  alto con otro distinto al final — la lista se salía de la
                  burbuja y se encimaba con los mensajes de abajo. */}
              <Text
                className={`min-w-0 shrink text-[13px] leading-5 ${
                  item.checked === true
                    ? 'text-slate-400 line-through'
                    : 'text-slate-800'
                }`}
              >
                <Inline nodes={item.content} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'table':
      return <Table block={block} />;
    default:
      return null;
  }
}

/**
 * Memoizado por el mismo motivo que el del escritorio: el hilo se re-renderiza
 * con cada delta del stream, y volver a parsear un mensaje que no cambió es
 * trabajo tirado.
 */
export const Markdown = memo(function MarkdownView({ text }: MarkdownProps) {
  const blocks = parseMarkdown(text);
  return (
    <View>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </View>
  );
});
