import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import type { PermissionRequest } from '../../api/types';
import { CheckIcon } from './icons';

/** Una pregunta tal cual la manda la herramienta. */
export interface AskQuestion {
  readonly question: string;
  /** Etiqueta corta para el chip; puede faltar. */
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

/** Texto libre: la herramienta promete que siempre se puede contestar «otra». */
const OTHER = '__other';

export interface AskQuestionCardProps {
  readonly request: PermissionRequest;
  readonly isBusy: boolean;
  /** Indexado por el **texto** de la pregunta, que es como lo espera el bridge. */
  readonly onSubmit: (answers: Record<string, string>) => void;
}

function parseQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AskQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.question !== 'string' || entry.question.length === 0) {
      continue;
    }
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(entry.options)) {
      for (const opt of entry.options) {
        if (typeof opt !== 'object' || opt === null) {
          continue;
        }
        const o = opt as Record<string, unknown>;
        if (typeof o.label === 'string' && o.label.length > 0) {
          options.push({
            label: o.label,
            description: typeof o.description === 'string' ? o.description : undefined,
          });
        }
      }
    }
    out.push({
      question: entry.question,
      header: typeof entry.header === 'string' ? entry.header : undefined,
      options,
      multiSelect: entry.multiSelect === true,
    });
  }
  return out;
}

interface OptionRowProps {
  readonly label: string;
  readonly description?: string;
  readonly isPicked: boolean;
  readonly isMulti: boolean;
  readonly isDashed?: boolean;
  readonly onPress: () => void;
}

function OptionRow({
  label,
  description,
  isPicked,
  isMulti,
  isDashed = false,
  onPress,
}: OptionRowProps) {
  return (
    <Pressable
      accessibilityRole={isMulti ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: isPicked }}
      accessibilityLabel={label}
      onPress={onPress}
      className={`mb-1.5 flex-row items-start gap-2.5 rounded-[10px] border-[1.5px] bg-white px-2.5 py-2 ${
        isPicked
          ? 'border-indigo-600 bg-indigo-50'
          : isDashed
            ? 'border-dashed border-slate-200'
            : 'border-slate-200'
      }`}
    >
      <View
        className={`mt-0.5 h-[15px] w-[15px] border-[2px] ${
          isMulti ? 'rounded-[4px]' : 'rounded-full'
        } ${isPicked ? 'border-indigo-600 bg-indigo-600' : 'border-slate-300'}`}
      >
        {isPicked ? (
          <View className="flex-1 items-center justify-center">
            <CheckIcon size={8} color="#ffffff" />
          </View>
        ) : null}
      </View>
      <View className="flex-1">
        <Text
          className={`text-[11.5px] leading-[15px] ${
            isDashed ? 'font-medium text-slate-500' : 'font-semibold text-slate-800'
          }`}
        >
          {label}
        </Text>
        {description !== undefined ? (
          <Text className="mt-0.5 text-[10px] leading-[14px] text-slate-500">
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * `AskUserQuestion` en el hilo, en acordeón.
 *
 * Llega por el mismo canal que los permisos —es un `USER_INTERACTION_TOOL`, así
 * que el bridge pregunta siempre— pero no se contesta con sí o no: hay que
 * devolver las opciones elegidas dentro de `updatedInput`.
 *
 * Solo una pregunta abierta a la vez. Con hasta cuatro preguntas de cuatro
 * opciones cada una, desplegarlas todas daría una tarjeta más alta que la
 * pantalla, y al vivir dentro de la lista no hay forma de desplazarla sola.
 */
export function AskQuestionCard({ request, isBusy, onSubmit }: AskQuestionCardProps) {
  const questions = useMemo(() => parseQuestions(request.input), [request.input]);

  /** índice → etiqueta elegida, o `OTHER` mientras se escribe la respuesta. */
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  /**
   * Cuál está desplegada. Se guarda aparte de las respuestas porque tocar una
   * ya contestada tiene que poder reabrirla sin borrar lo elegido.
   */
  const [open, setOpen] = useState(0);

  if (questions.length === 0) {
    return null;
  }

  const answerOf = (index: number): string => {
    const chosen = picked[index] ?? [];
    if (chosen.length === 1 && chosen[0] === OTHER) {
      return (custom[index] ?? '').trim();
    }
    return chosen.filter(label => label !== OTHER).join(', ');
  };

  const isAnswered = (index: number) => answerOf(index).length > 0;
  const allAnswered = questions.every((_, index) => isAnswered(index));

  /** La siguiente sin contestar, para saltar sola al acabar una. */
  const nextPending = (from: number) => {
    for (let i = 0; i < questions.length; i += 1) {
      if (i !== from && !isAnswered(i)) {
        return i;
      }
    }
    return -1;
  };

  const choose = (index: number, label: string) => {
    const question = questions[index]!;
    if (question.multiSelect === true) {
      // Marcar no significa «he terminado», así que aquí no se avanza solo:
      // esta pregunta tiene su propio botón.
      const chosen = picked[index] ?? [];
      setPicked({
        ...picked,
        [index]: chosen.includes(label)
          ? chosen.filter(other => other !== label)
          : [...chosen, label],
      });
      return;
    }
    setPicked({ ...picked, [index]: [label] });
    if (label === OTHER) {
      // Se queda abierta: aún hay que escribir el texto.
      return;
    }
    if (questions.length === 1) {
      // Única, de una sola opción y elegida: no queda nada que revisar, así que
      // pedir además un botón sería un toque de más.
      onSubmit({ [question.question]: label });
      return;
    }
    const next = nextPending(index);
    setOpen(next === -1 ? -1 : next);
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
      const value = answerOf(index);
      if (value.length > 0) {
        answers[question.question] = value;
      }
    }
    onSubmit(answers);
  };

  const single = questions.length === 1;
  /**
   * El autoenvío solo cubre el caso limpio: una pregunta, una opción, elegida.
   * Con texto libre hay que poder decir «ya he acabado de escribir», y con
   * `multiSelect` marcar no significa haber terminado — sin botón, esas dos
   * variantes se quedaban sin salida.
   */
  const needsButton =
    !single || questions[0]?.multiSelect === true || (picked[0] ?? []).includes(OTHER);

  return (
    <View className="mx-3 mb-2 mt-1 rounded-[15px] border-[1.5px] border-indigo-200 bg-white p-2.5">
      <View className="mb-2 flex-row items-center gap-1.5">
        <View className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
        <Text className="text-[8.5px] font-bold uppercase tracking-[0.9px] text-indigo-500">
          Pregunta
        </Text>
        {single ? null : (
          <Text className="ml-auto text-[9px] font-bold text-indigo-300">
            {`${questions.filter((_, i) => isAnswered(i)).length} / ${questions.length}`}
          </Text>
        )}
      </View>

      {questions.map((question, index) => {
        const answered = isAnswered(index);
        const isOpen = single || open === index;
        const chosen = picked[index] ?? [];

        return (
          <View
            key={question.question}
            className={`mb-1.5 overflow-hidden rounded-xl border-[1.5px] ${
              isOpen
                ? 'border-indigo-200 bg-indigo-50/40'
                : answered
                  ? 'border-slate-200 bg-slate-50'
                  : 'border-slate-200'
            }`}
          >
            {single ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
                accessibilityLabel={question.question}
                onPress={() => setOpen(isOpen ? -1 : index)}
                className="flex-row items-center gap-2 px-2.5 py-2 active:bg-slate-100"
              >
                <View
                  className={`h-[17px] w-[17px] items-center justify-center rounded-full ${
                    answered ? 'bg-emerald-600' : isOpen ? 'bg-indigo-600' : 'bg-slate-200'
                  }`}
                >
                  {answered ? (
                    <CheckIcon size={9} color="#ffffff" />
                  ) : (
                    <Text
                      className={`text-[9px] font-bold ${
                        isOpen ? 'text-white' : 'text-slate-400'
                      }`}
                    >
                      {index + 1}
                    </Text>
                  )}
                </View>
                <View className="flex-1">
                  {question.header !== undefined ? (
                    <Text className="text-[8.5px] font-bold uppercase tracking-[0.7px] text-slate-400">
                      {question.header}
                    </Text>
                  ) : null}
                  {answered && !isOpen ? (
                    <Text
                      numberOfLines={1}
                      className="mt-0.5 text-[11px] font-semibold text-emerald-700"
                    >
                      {answerOf(index)}
                    </Text>
                  ) : (
                    <Text
                      numberOfLines={2}
                      className={`mt-0.5 text-[11.5px] leading-[15px] ${
                        isOpen
                          ? 'font-semibold text-slate-900'
                          : 'font-normal text-slate-400'
                      }`}
                    >
                      {question.question}
                    </Text>
                  )}
                </View>
                {isOpen ? null : <Text className="text-[11px] text-slate-300">›</Text>}
              </Pressable>
            )}

            {isOpen ? (
              <View className={single ? '' : 'px-2.5 pb-2'}>
                {single ? (
                  <Text className="mb-2 px-2.5 pt-2.5 text-[11.5px] font-semibold leading-[15px] text-slate-900">
                    {question.question}
                  </Text>
                ) : null}
                <View className={single ? 'px-2.5 pb-2.5' : ''}>
                  {(question.options ?? []).map(option => (
                    <OptionRow
                      key={option.label}
                      label={option.label}
                      description={option.description}
                      isMulti={question.multiSelect === true}
                      isPicked={chosen.includes(option.label)}
                      onPress={() => choose(index, option.label)}
                    />
                  ))}
                  <OptionRow
                    label="Otra… (escribir)"
                    isDashed
                    isMulti={false}
                    isPicked={chosen.includes(OTHER)}
                    onPress={() => choose(index, OTHER)}
                  />
                  {chosen.includes(OTHER) ? (
                    <TextInput
                      value={custom[index] ?? ''}
                      onChangeText={text => setCustom({ ...custom, [index]: text })}
                      placeholder="Tu respuesta…"
                      placeholderTextColor="#94a3b8"
                      autoFocus
                      multiline
                      className="mb-1.5 rounded-[10px] border-[1.5px] border-indigo-600 bg-white px-2.5 py-2 text-[11.5px] leading-[16px] text-slate-900"
                    />
                  ) : null}
                  {question.multiSelect === true && !single ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !answered }}
                      onPress={() => {
                        const next = nextPending(index);
                        setOpen(next === -1 ? -1 : next);
                      }}
                      disabled={!answered}
                      className={`mt-0.5 items-center rounded-[10px] py-2 ${
                        answered ? 'bg-indigo-600 active:opacity-80' : 'bg-slate-200'
                      }`}
                    >
                      <Text
                        className={`text-[11px] font-semibold ${
                          answered ? 'text-white' : 'text-slate-400'
                        }`}
                      >
                        {`Listo · ${chosen.filter(l => l !== OTHER).length} ${
                          chosen.filter(l => l !== OTHER).length === 1
                            ? 'elegida'
                            : 'elegidas'
                        }`}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}

      {/*
        Con una sola pregunta se envía al elegir: no hay nada más que revisar y
        un botón sería un toque de más. Con varias no se autoenvía, porque
        mandarlo al contestar la última quitaría la ocasión de repasar las de
        arriba.
      */}
      {needsButton ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !allAnswered || isBusy }}
            onPress={submit}
            disabled={!allAnswered || isBusy}
            className={`mt-0.5 items-center rounded-xl py-2.5 ${
              allAnswered && !isBusy ? 'bg-slate-900 active:opacity-80' : 'bg-slate-200'
            }`}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text
                className={`text-[12px] font-semibold ${
                  allAnswered ? 'text-white' : 'text-slate-400'
                }`}
              >
                Enviar respuestas
              </Text>
            )}
          </Pressable>
          {single ? null : (
            <Text className="mt-1.5 text-center text-[9.5px] text-slate-400">
              {allAnswered
                ? 'Puedes tocar cualquiera para cambiarla'
                : `Faltan ${questions.filter((_, i) => !isAnswered(i)).length}`}
            </Text>
          )}
        </>
      ) : null}
    </View>
  );
}

/** Para que la pantalla sepa si toca esta tarjeta o la de permisos normal. */
export function isAskQuestion(request: PermissionRequest): boolean {
  return request.toolName === 'AskUserQuestion';
}
