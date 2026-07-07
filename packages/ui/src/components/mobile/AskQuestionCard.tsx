import { useState } from 'react';
import { Button, TextField, Input } from '@heroui/react';
import type { PermissionRequest } from '../../lib/claude-client';

type AskQuestion = {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
};

interface Props {
  request: PermissionRequest;
  /** Submit selected answers — wraps the original input and the answers map
   *  back into a permission_response payload, just like the desktop. */
  onSubmit: (answers: Record<string, string>) => void;
}

/**
 * Mobile rendering of the AskUserQuestion tool — visually mirrors the desktop
 * `AskUserQuestionForm` (violet accents, radio-button cards, auto-submit on
 * single-question case) but with touch-sized targets and the same outer pill
 * card styling other mobile permission UIs use.
 */
export function MobileAskQuestionCard({ request, onSubmit }: Props) {
  const input = request.input as { questions?: AskQuestion[] };
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  // `selections[i]` is either the chosen option label or, when in custom mode,
  // the user's typed text. Claude keys answers by question text, so translate
  // at the submit boundary.
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});

  const buildAnswers = (sels: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(sels)) {
      const q = questions[Number(key)]?.question;
      const trimmed = val.trim();
      if (q && trimmed) out[q] = trimmed;
    }
    return out;
  };

  const handleSelect = (qIdx: number, label: string) => {
    const key = String(qIdx);
    setCustomMode(prev => ({ ...prev, [key]: false }));
    const next = { ...selections, [key]: label };
    setSelections(next);
    if (questions.length === 1) onSubmit(buildAnswers(next));
  };

  const handleEnterCustom = (qIdx: number) => {
    const key = String(qIdx);
    setCustomMode(prev => ({ ...prev, [key]: true }));
    setSelections(prev => ({ ...prev, [key]: '' }));
  };

  const handleCustomChange = (qIdx: number, text: string) => {
    const key = String(qIdx);
    setSelections(prev => ({ ...prev, [key]: text }));
  };

  const submitCustomSingle = (qIdx: number) => {
    const key = String(qIdx);
    const val = (selections[key] || '').trim();
    if (!val) return;
    onSubmit(buildAnswers({ [key]: val }));
  };

  const allAnswered = questions.length > 0 && questions.every((_, i) => (selections[String(i)] || '').trim());

  if (questions.length === 0) return null;

  return (
    <div className="mx-3 my-3 rounded-2xl border border-violet-500/40 bg-violet-500/5 p-3 shadow-lg">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">
          Question
        </span>
      </div>

      <div className="space-y-3">
        {questions.map((q, i) => {
          const key = String(i);
          const isCustom = customMode[key] === true;
          const selected = !isCustom ? selections[key] : undefined;
          return (
            <div key={i}>
              {q.header && (
                <span className="inline-block text-[10px] font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded mb-1.5">
                  {q.header}
                </span>
              )}
              <p className="text-[14px] text-zinc-200 leading-snug mb-2">{q.question}</p>
              {q.options && q.options.length > 0 && (
                <div className="space-y-1.5">
                  {q.options.map((opt, j) => {
                    const isActive = selected === opt.label;
                    return (
                      <Button
                        key={j}
                        variant="ghost"
                        onPress={() => handleSelect(i, opt.label)}
                        className={`w-full h-auto min-w-0 justify-start text-left px-3 py-3 rounded-xl border transition-colors active:scale-[0.99] ${
                          isActive
                            ? 'border-violet-400/60 bg-violet-500/15 ring-1 ring-violet-400/30'
                            : 'border-white/10 bg-white/[0.03] active:border-zinc-500 active:bg-white/5'
                        }`}
                      >
                        <div className="flex items-start gap-2.5 w-full">
                          <span
                            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                              isActive ? 'border-violet-400' : 'border-zinc-600'
                            }`}
                          >
                            {isActive && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className="text-[14px] font-medium text-zinc-100 leading-snug">{opt.label}</span>
                            {opt.description && (
                              <p className="text-[12px] text-zinc-400 mt-1 leading-snug">{opt.description}</p>
                            )}
                          </div>
                        </div>
                      </Button>
                    );
                  })}
                  {isCustom ? (
                    <div className="flex items-stretch gap-1.5">
                      <TextField
                        value={selections[key] || ''}
                        onChange={(text) => handleCustomChange(i, text)}
                        aria-label="Custom answer"
                        autoFocus
                        className="flex-1"
                      >
                        <Input
                          placeholder="Type your own answer…"
                          className="px-3 py-3 rounded-xl border border-violet-400/60 bg-violet-500/15 ring-1 ring-violet-400/30 text-[14px] text-zinc-100 placeholder:text-zinc-500 outline-none"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && questions.length === 1) {
                              e.preventDefault();
                              submitCustomSingle(i);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setCustomMode(prev => ({ ...prev, [key]: false }));
                              setSelections(prev => ({ ...prev, [key]: '' }));
                            }
                          }}
                        />
                      </TextField>
                      {questions.length === 1 && (
                        <Button
                          variant="ghost"
                          isDisabled={!(selections[key] || '').trim()}
                          onPress={() => submitCustomSingle(i)}
                          className="h-auto min-w-0 px-4 rounded-xl text-[13px] font-semibold bg-violet-500/20 border border-violet-500/40 text-violet-100 active:bg-violet-500/30 disabled:opacity-40 transition-colors"
                        >
                          Send
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      onPress={() => handleEnterCustom(i)}
                      className="w-full h-auto min-w-0 justify-start text-left px-3 py-3 rounded-xl border border-dashed border-white/15 text-[13px] text-zinc-400 active:bg-white/5 transition-colors"
                    >
                      + Other (write your own answer)
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {questions.length > 1 && (
        <Button
          variant="ghost"
          fullWidth
          isDisabled={!allAnswered}
          onPress={() => onSubmit(buildAnswers(selections))}
          className="mt-3 h-auto min-h-12 rounded-xl bg-violet-500/20 border border-violet-500/40 text-violet-100 font-semibold active:bg-violet-500/30 disabled:opacity-40 transition-colors"
        >
          Submit answers
        </Button>
      )}
    </div>
  );
}
