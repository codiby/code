import { memo } from 'react';
import { Text, View } from 'react-native';

import type { DiffDocCodeRow, DiffDocRow } from '../../lib/diffDoc';
import { parseDiffDoc } from '../../lib/diffDoc';
import { parseInline } from '../../lib/markdown';

export interface DiffDocViewProps {
  readonly source: string;
}

const KIND_STYLE: Record<DiffDocCodeRow['kind'], { row: string; sign: string; text: string }> = {
  add: { row: 'bg-emerald-50', sign: 'text-emerald-600', text: 'text-emerald-900' },
  del: { row: 'bg-rose-50', sign: 'text-rose-600', text: 'text-rose-900' },
  ctx: { row: '', sign: 'text-slate-300', text: 'text-slate-600' },
};

const SIGN: Record<DiffDocCodeRow['kind'], string> = {
  add: '+',
  del: '−',
  ctx: ' ',
};

/** Código con el tramo cambiado teñido, cuando el par lo permitió. */
function CodeText({ row }: { readonly row: DiffDocCodeRow }) {
  const style = KIND_STYLE[row.kind];

  if (row.mark === undefined) {
    return (
      <Text className={`font-mono text-[10.5px] leading-[16px] ${style.text}`}>
        {row.code}
      </Text>
    );
  }

  const { start, end } = row.mark;
  return (
    <Text className={`font-mono text-[10.5px] leading-[16px] ${style.text}`}>
      {row.code.slice(0, start)}
      <Text
        className={
          row.kind === 'add'
            ? 'bg-emerald-200 font-semibold'
            : 'bg-rose-200 font-semibold'
        }
      >
        {row.code.slice(start, end)}
      </Text>
      {row.code.slice(end)}
    </Text>
  );
}

function Row({ row }: { readonly row: DiffDocRow }) {
  if (row.kind === 'note') {
    // La nota va en la fuente del cuerpo, no en monoespaciado: es prosa
    // dentro de la figura, y ese contraste es el punto del formato.
    return (
      <View className="border-l-2 border-slate-200 py-1.5 pl-2.5 pr-2">
        <Text className="text-[12px] leading-[18px] text-slate-500">
          <InlineNote text={row.text} />
        </Text>
      </View>
    );
  }

  if (row.kind === 'gap') {
    return (
      <View className="flex-row items-center gap-2 py-1 pl-2 pr-2">
        <View className="h-px flex-1 bg-slate-200" />
        <Text className="text-[9.5px] text-slate-400">
          {`${row.count} ${row.count === 1 ? 'línea' : 'líneas'}`}
        </Text>
        <View className="h-px flex-1 bg-slate-200" />
      </View>
    );
  }

  const style = KIND_STYLE[row.kind];
  return (
    <View className={`flex-row ${style.row}`}>
      <Text className="w-8 pr-1 text-right font-mono text-[9px] leading-[16px] text-slate-300">
        {row.newNo ?? row.oldNo ?? ''}
      </Text>
      <Text className={`w-3 font-mono text-[10.5px] leading-[16px] ${style.sign}`}>
        {SIGN[row.kind]}
      </Text>
      <View className="flex-1 pr-2">
        <CodeText row={row} />
      </View>
    </View>
  );
}

/** Subconjunto de markdown que admiten las notas: `código` y **negrita**. */
function InlineNote({ text }: { readonly text: string }) {
  return (
    <>
      {parseInline(text).map((node, index) => {
        if (node.type === 'code') {
          return (
            <Text
              key={index}
              className="font-mono text-[10px] text-slate-600"
            >
              {node.value}
            </Text>
          );
        }
        if (node.type === 'strong') {
          const inner = node.children
            .map(child => (child.type === 'text' ? child.value : ''))
            .join('');
          return (
            <Text key={index} className="font-semibold text-slate-700">
              {inner}
            </Text>
          );
        }
        if (node.type === 'text') {
          return <Text key={index}>{node.value}</Text>;
        }
        return null;
      })}
    </>
  );
}

/**
 * Un `diffdoc` se lee como parte del texto, no como una tarjeta aparte: lo
 * enmarca una línea fina en el margen y un pie con la ruta, igual que una cita.
 */
export const DiffDocView = memo(function DiffDocFigure({ source }: DiffDocViewProps) {
  const block = parseDiffDoc(source);

  // Malformado: mejor el bloque plano que una figura rota.
  if (block.error !== undefined) {
    return (
      <View className="my-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
        <Text className="px-2.5 py-2 font-mono text-[11px] leading-[17px] text-slate-200">
          {source.trim()}
        </Text>
      </View>
    );
  }

  const slash = block.path.lastIndexOf('/');
  const dir = slash >= 0 ? block.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? block.path.slice(slash + 1) : block.path;

  return (
    <View className="my-1.5 border-l-2 border-slate-300 pl-2">
      <View className="flex-row items-baseline gap-1.5 pb-1 pl-1">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-[11px]">
          <Text className="text-slate-400">{dir}</Text>
          <Text className="font-semibold text-slate-700">{name}</Text>
        </Text>
        {block.added > 0 ? (
          <Text className="text-[10px] font-bold text-emerald-600">
            {`+${block.added}`}
          </Text>
        ) : null}
        {block.removed > 0 ? (
          <Text className="text-[10px] font-bold text-rose-600">
            {`−${block.removed}`}
          </Text>
        ) : null}
      </View>

      <View className="overflow-hidden rounded-md border border-slate-200 bg-white py-0.5">
        {block.rows.map((row, index) => (
          <Row key={index} row={row} />
        ))}
      </View>
    </View>
  );
});
