import { useState } from 'react';

export type AskQuestion = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

export function AskUserQuestionForm({ questions, onSubmit }: { questions: AskQuestion[]; onSubmit: (answers: Record<string, string>) => void }) {
  // Per-question state. `selections[i]` is the chosen option label OR the
  // typed custom text when `customMode[i]` is true. Claude's AskUserQuestion
  // tool keys answers by question text (its tool_result formatter looks up
  // `answers[question.question]`), so translate at the submit boundary.
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
    setSelections(prev => ({ ...prev, [key]: label }));
    if (questions.length === 1) {
      onSubmit(buildAnswers({ [key]: label }));
    }
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

  const allAnswered = questions.every((_, i) => (selections[String(i)] || '').trim());

  return (
    <div className="space-y-3 mb-2">
      {questions.map((q, i) => {
        const key = String(i);
        const isCustom = customMode[key] === true;
        const selected = !isCustom ? selections[key] : undefined;
        return (
          <div key={i}>
            {q.header && (
              <span className="inline-block text-[10px] font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded mb-1">
                {q.header}
              </span>
            )}
            <p className="text-[12px] text-zinc-300 leading-relaxed mb-1.5">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="space-y-1">
                {q.options.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => handleSelect(i, opt.label)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                      selected === opt.label
                        ? 'border-violet-400/50 bg-violet-500/10 ring-1 ring-violet-400/20'
                        : 'border-border hover:border-zinc-600 hover:bg-surface-light/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                        selected === opt.label ? 'border-violet-400' : 'border-zinc-600'
                      }`}>
                        {selected === opt.label && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                      </span>
                      <div>
                        <span className="text-[12px] font-medium text-zinc-200">{opt.label}</span>
                        {opt.description && <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{opt.description}</p>}
                      </div>
                    </div>
                  </button>
                ))}
                {isCustom ? (
                  <div className="flex items-stretch gap-1">
                    <input
                      autoFocus
                      type="text"
                      value={selections[key] || ''}
                      onChange={(e) => handleCustomChange(i, e.target.value)}
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
                      placeholder="Type your own answer…"
                      className="flex-1 px-3 py-2 rounded-lg border border-violet-400/50 bg-violet-500/10 ring-1 ring-violet-400/20 text-[12px] text-zinc-100 placeholder:text-zinc-500 outline-none"
                    />
                    {questions.length === 1 && (
                      <button
                        type="button"
                        disabled={!(selections[key] || '').trim()}
                        onClick={() => submitCustomSingle(i)}
                        className="px-3 rounded-lg text-[12px] bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40 transition-colors"
                      >
                        Send
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleEnterCustom(i)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-border text-[12px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                  >
                    + Other (write your own answer)
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {questions.length > 1 && (
        <button
          disabled={!allAnswered}
          onClick={() => onSubmit(buildAnswers(selections))}
          className="px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors disabled:opacity-40"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}
