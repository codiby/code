import { execSync } from 'child_process';
import { corsHeaders } from '../config';

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.next', '.nuxt', '.output', '__pycache__', '.cache', 'coverage', '.turbo'];

export function handleSearch(root: string, query: string): Response {
  try {
    let cmd: string;
    let useRg = false;
    try {
      execSync('which rg', { encoding: 'utf-8', timeout: 2000 });
      useRg = true;
    } catch {}

    if (useRg) {
      cmd = `rg --json --max-count 5 --max-filesize 1M -e ${JSON.stringify(query)} .`;
    } else {
      const excludes = EXCLUDE_DIRS.map(d => `--exclude-dir=${d}`).join(' ');
      cmd = `grep -rn ${excludes} -m 50 ${JSON.stringify(query)} .`;
    }

    const output = execSync(cmd, { cwd: root, encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });

    if (useRg) {
      const results: { file: string; line: number; text: string }[] = [];
      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'match') {
            results.push({
              file: msg.data.path.text,
              line: msg.data.line_number,
              text: msg.data.lines.text.trim().slice(0, 200),
            });
          }
        } catch {}
      }
      return Response.json({ results: results.slice(0, 100) }, { headers: corsHeaders });
    }

    // Parse grep output: file:line:text
    const results = output.split('\n').filter(Boolean).slice(0, 100).map(line => {
      const [file, lineNum, ...rest] = line.split(':');
      return { file: file || '', line: parseInt(lineNum || '0', 10), text: rest.join(':').trim().slice(0, 200) };
    });
    return Response.json({ results }, { headers: corsHeaders });
  } catch {
    return Response.json({ results: [] }, { headers: corsHeaders });
  }
}
