/**
 * Visual-check judge.
 *
 * Runs as a one-shot `query()` with no tools and none of the working session's
 * context, so the agent being graded can't talk its way to a pass. Anything
 * that isn't an explicit `{"pass": true}` is a fail — a malformed reply, a
 * timeout, a crashed subprocess all land on `false`.
 */

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { CLAUDE_BIN } from '../config/config';
import { log } from '../lib/logger';

const JUDGE_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = [
  'You are a strict UI acceptance judge.',
  'You receive one or two screenshots and a requirement written by a developer.',
  'When two images are given, the FIRST is the reference design and the SECOND is the current state to grade; grade the SECOND against the requirement, using the first only as context for what was intended.',
  'When one image is given, grade that image against the requirement.',
  '',
  'Judge only what is visible. Do not assume behaviour you cannot see.',
  'Be strict: if the requirement is not clearly met, it fails.',
  '',
  'Reply with a single JSON object and nothing else:',
  '{"pass": true|false, "reason": "<one short sentence>"}',
].join('\n');

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type JudgeImage = { path: string; label: string };
export type JudgeVerdict = { pass: boolean; reason: string };

async function toImageBlock(image: JudgeImage) {
  const data = await fs.readFile(image.path);
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: (MEDIA_TYPES[extname(image.path).toLowerCase()] ?? 'image/png') as any,
      data: data.toString('base64'),
    },
  };
}

/** Pull the verdict out of the reply, tolerating code fences and stray prose. */
function parseVerdict(text: string): JudgeVerdict {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { pass: false, reason: 'Judge did not return a JSON verdict.' };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { pass?: unknown; reason?: unknown };
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'No reason given.';
    return { pass: parsed.pass === true, reason };
  } catch {
    return { pass: false, reason: 'Judge returned malformed JSON.' };
  }
}

export async function judgeVisual(opts: {
  prompt: string;
  images: JudgeImage[];
  model: string;
  cwd: string;
}): Promise<JudgeVerdict> {
  if (opts.images.length === 0) {
    return { pass: false, reason: 'No image to grade.' };
  }

  let blocks;
  try {
    blocks = await Promise.all(opts.images.map(toImageBlock));
  } catch (error) {
    return { pass: false, reason: `Could not read the screenshot: ${error instanceof Error ? error.message : String(error)}` };
  }

  const label = opts.images.map((img, i) => `Image ${i + 1}: ${img.label}`).join('\n');
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...blocks,
        { type: 'text' as const, text: `${label}\n\nRequirement:\n${opts.prompt}` },
      ] as any,
    },
    parent_tool_use_id: null,
    session_id: undefined,
  };

  // A single-message async iterable: the SDK closes the input stream when the
  // generator ends, which is what makes this one-shot.
  async function* once() { yield message; }

  const runtime = query({
    prompt: once(),
    options: {
      cwd: opts.cwd,
      model: opts.model,
      maxTurns: 1,
      allowedTools: [],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      systemPrompt: SYSTEM_PROMPT,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    },
  });

  const timeout = new Promise<JudgeVerdict>((resolve) => {
    setTimeout(() => resolve({ pass: false, reason: 'Judge timed out.' }), JUDGE_TIMEOUT_MS);
  });

  const graded = (async (): Promise<JudgeVerdict> => {
    let text = '';
    try {
      for await (const msg of runtime) {
        if (msg.type === 'assistant') {
          for (const block of (msg.message.content as any[]) ?? []) {
            if (block?.type === 'text') text += block.text;
          }
        } else if (msg.type === 'result') {
          const result = (msg as { result?: string }).result;
          if (result) text = result;
        }
      }
    } catch (error) {
      log(`[requirements:judge] ${error instanceof Error ? error.message : String(error)}`);
      return { pass: false, reason: 'Judge failed to run.' };
    }
    return parseVerdict(text);
  })();

  const verdict = await Promise.race([graded, timeout]);
  try { await runtime.interrupt?.(); } catch {}
  return verdict;
}
