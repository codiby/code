import { execSync } from 'child_process';
import { corsHeaders } from '../config';

export function handleSearch(root: string, query: string): Response {
  try {
    // Try ripgrep first, fall back to grep
    let cmd: string;
    try {
      execSync('which rg', { encoding: 'utf-8', timeout: 2000 });
      cmd = `rg --json --max-count 5 --max-filesize 1M -e ${JSON.stringify(query)} .`;
    } catch {
      cmd = `grep -rn --include='*' -m 5 ${JSON.stringify(query)} .`;
    }
    const output = execSync(cmd, { cwd: root, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 });

    // Parse ripgrep JSON output
    if (cmd.startsWith('rg')) {
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
