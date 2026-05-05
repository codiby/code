import { useState, useEffect, useRef } from 'react';
import type { ClaudeClient } from './claude-client';

export interface FileEntry {
  name: string;
  path: string;
  rel: string;
  type?: 'file' | 'dir';
}

export interface ScoredFile extends FileEntry {
  score: number;
}

/**
 * VS Code-style fuzzy match scoring.
 * Matches characters in order anywhere in the target string.
 * Rewards: consecutive matches, word boundary matches, filename matches, exact substrings.
 */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact substring match gets a big bonus
  if (t.includes(q)) {
    // Prefer filename matches over path matches
    const filename = t.split('/').pop() || t;
    if (filename.includes(q)) return 1000 + (100 - filename.length);
    return 500 + (100 - t.length);
  }

  // Fuzzy character-by-character matching
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      score += 10;

      // Consecutive match bonus
      if (ti === lastMatchIdx + 1) {
        consecutive++;
        score += consecutive * 5;
      } else {
        consecutive = 0;
      }

      // Word boundary bonus (after /, -, _, . or camelCase)
      if (ti === 0 || '/\\-_.'.includes(t[ti - 1]!) || (t[ti - 1] !== t[ti - 1]!.toUpperCase() && t[ti] === t[ti]!.toUpperCase())) {
        score += 15;
      }

      // Filename portion bonus (after last /)
      const lastSlash = t.lastIndexOf('/');
      if (ti > lastSlash) {
        score += 5;
      }

      lastMatchIdx = ti;
    }
  }

  // All query characters must match
  if (qi < q.length) return -1;

  // Penalize longer paths slightly
  score -= t.length * 0.5;

  return score;
}

/**
 * Search files with fuzzy matching. Returns top results sorted by score.
 */
export function searchFiles(files: FileEntry[], query: string, maxResults = 30): ScoredFile[] {
  if (!query) return [];
  const scored: ScoredFile[] = [];
  for (const file of files) {
    const score = Math.max(fuzzyScore(query, file.rel), fuzzyScore(query, file.name));
    if (score >= 0) {
      scored.push({ ...file, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * Shared hook that loads the file index once and provides a synchronous fuzzy search.
 */
export function useFileIndex(client: ClaudeClient | null, rootPath: string | null) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const rootRef = useRef<string | null>(null);

  useEffect(() => {
    if (!client || !rootPath) { setFiles([]); return; }
    // Only re-fetch if root changed
    if (rootRef.current === rootPath && files.length > 0) return;
    rootRef.current = rootPath;
    client.getFileIndex(rootPath).then(setFiles).catch(() => setFiles([]));
  }, [client, rootPath]);

  return files;
}
