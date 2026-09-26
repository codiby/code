import { describe, expect, test } from 'bun:test';
import { detectOutputLanguage, languageFromCommand, languageFromPath } from './output-language';

const TS = `export const MessageBubble = memo(function MessageBubble({ message, isLast }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [gallery, setGallery] = useState<Gallery | null>(null);
  // Interactive terminals are rendered only in the dock.
  if (message.isTerminal) {
    return <TerminalBubble message={message} />;
  }
  return null;
});`;

const PY = `import os
from pathlib import Path

def load(path: str) -> dict:
    """Read a config file."""
    with open(path) as f:
        for line in f:
            if line.startswith('#'):
                continue
    return {}
`;

const GO = `package main

import (
	"fmt"
	"os"
)

type Config struct {
	Name string
	Port int
}

func load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	fmt.Println("read", len(data))
	return &Config{Name: "x", Port: 80}, nil
}
`;

const TEST_LOG = `bun test v1.3.14 (4d443e540)

src/lib/tool-steps.test.ts:
✓ lineDiff > marks only the changed lines [0.41ms]
✓ lineDiff > numbers both sides from the start line [0.12ms]
✓ shortCommand > drops the cd prefix [0.05ms]

 21 pass
 0 fail
 33 expect() calls
Ran 21 tests across 1 file. [78.00ms]`;

const TSC = `src/components/TabBar.tsx(164,45): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/components/TabBar.tsx(188,12): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
Found 2 errors in the same file, starting at: src/components/TabBar.tsx:164`;

const GIT_STATUS = ` M packages/core/index.ts
 M packages/ui/src/components/ChatApp.tsx
?? packages/ui/src/components/ToolSteps.tsx
?? packages/ui/src/lib/tool-steps.ts`;

const PROSE = `The build finished without problems.
All assets were copied into the application bundle.
Press Command-R in the window to reload the interface.
Nothing else needs to be done right now.`;

describe('languageFromCommand', () => {
  test('file printers take the language from the file', () => {
    expect(languageFromCommand('sed -n 1153,1240p src/components/MessageBubble.tsx; cat tsconfig.json | head -40')).toBe('tsx');
    expect(languageFromCommand('cat tsconfig.json')).toBe('json');
    expect(languageFromCommand('cd /r && head -50 scripts/build.py')).toBe('python');
    expect(languageFromCommand('tail -n 20 logs/app.yaml')).toBe('yaml');
  });

  test('git diff and jq', () => {
    expect(languageFromCommand('git diff -- src/a.ts')).toBe('diff');
    expect(languageFromCommand('curl -s localhost/x | jq .')).toBe('');
    expect(languageFromCommand('jq . package.json')).toBe('json');
  });

  test('other commands say nothing', () => {
    expect(languageFromCommand('bun test src/a.test.ts')).toBe('');
    expect(languageFromCommand('grep -n foo src/a.ts')).toBe('');
    expect(languageFromCommand("sed -i '' 's/a/b/' src/a.tsx && grep -n b src/a.tsx")).toBe('');
  });
});

describe('detectOutputLanguage', () => {
  test('the command wins over the content', () => {
    expect(detectOutputLanguage(TS, 'sed -n 1,20p src/components/MessageBubble.tsx')).toBe('tsx');
  });

  test('JSON', () => {
    expect(detectOutputLanguage('{\n  "name": "x",\n  "version": "1.0.0"\n}')).toBe('json');
  });

  test('recognises code without a hint', () => {
    expect(detectOutputLanguage(TS)).toMatch(/^(typescript|javascript)$/);
    expect(detectOutputLanguage(PY)).toBe('python');
    expect(detectOutputLanguage(GO)).toBe('go');
  });

  test('logs, compiler errors and prose stay plain', () => {
    expect(detectOutputLanguage(TEST_LOG, 'bun test')).toBe('');
    expect(detectOutputLanguage(TSC, 'tsc --noEmit')).toBe('');
    expect(detectOutputLanguage(GIT_STATUS, 'git status --short')).toBe('');
    expect(detectOutputLanguage(PROSE)).toBe('');
  });

  test('output that already has ANSI colours keeps them', () => {
    expect(detectOutputLanguage('\x1b[32m✓\x1b[0m ok\nline\nline', 'cat a.ts')).toBe('');
  });
});

test('languageFromPath', () => {
  expect(languageFromPath('/r/src/ToolSteps.tsx')).toBe('tsx');
  expect(languageFromPath('/r/README.md')).toBe('markdown');
  expect(languageFromPath('/r/Makefile')).toBe('');
});

describe('highlightLines', () => {
  test('keeps a multi-line comment coloured on every line, with balanced markup', async () => {
    const { highlightLines } = await import('./highlight');
    const lines = highlightLines('/**\n * if this is in a comment\n */\nconst x = 1;', 'typescript');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toStartWith('<span class="token comment">');
    expect(lines[1]).not.toContain('token keyword');
    expect(lines[3]).toContain('<span class="token keyword">const</span>');
    for (const l of lines) {
      expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    }
  });
});
