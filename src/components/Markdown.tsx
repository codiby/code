/**
 * Lightweight GitHub-flavored Markdown renderer.
 * Handles: headers, bold, italic, strikethrough, code (inline + blocks),
 * links, images, lists, blockquotes, HR, tables, HTML details/summary/br.
 */

const SAFE_TAGS = new Set(['details', 'summary', 'br', 'hr', 'b', 'i', 'em', 'strong', 'del', 'sub', 'sup', 'kbd', 'mark', 'abbr']);

function escapeHtml(text: string): string {
  // Preserve safe HTML tags, escape everything else
  return text.replace(/&/g, '&amp;')
    .replace(/<(!--.*?--|\/?\w+[^>]*)>/g, (match, inner) => {
      // Strip HTML comments
      if (inner.startsWith('!--')) return '';
      // Allow safe tags
      const tagName = inner.replace(/^\//, '').split(/[\s/>]/)[0].toLowerCase();
      if (SAFE_TAGS.has(tagName)) return match;
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    });
}

function renderInline(text: string): string {
  return text
    // Images: ![alt](url)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="max-w-full rounded my-1" />')
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline">$1</a>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="text-[11px] bg-zinc-800 px-1 py-0.5 rounded font-mono text-indigo-300">$1</code>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-200 font-semibold">$1</strong>')
    // Italic
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>')
    // Strikethrough
    .replace(/~~(.+?)~~/g, '<del class="text-zinc-600">$1</del>')
    // Auto-link bare URLs. Negative lookbehind skips URLs that are already
    // inside markdown link syntax `](url)`, inside HTML attributes `href="..."`,
    // or inside an existing `<a>` tag (preceded by `>`). Trailing punctuation
    // (.,!?:;) is stripped so "see https://x.com." links to https://x.com.
    .replace(/(?<![("'>])https?:\/\/[^\s<>"')]+/g, (url) => {
      const trail = url.match(/[.,!?:;]+$/);
      const href = trail ? url.slice(0, url.length - trail[0].length) : url;
      const tail = trail ? trail[0] : '';
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline break-all">${href}</a>${tail}`;
    });
}

function renderTable(rows: string[]): string {
  const parseRow = (row: string) =>
    row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

  const headers = parseRow(rows[0]);
  // Skip alignment row (row[1])
  const bodyRows = rows.slice(2).map(parseRow);

  let html = '<div class="overflow-x-auto my-2"><table class="text-[11px] w-full border-collapse">';
  html += '<thead><tr>';
  for (const h of headers) {
    html += `<th class="text-left text-zinc-400 font-semibold px-2 py-1 border-b border-border">${renderInline(escapeHtml(h))}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of bodyRows) {
    html += '<tr>';
    for (const cell of row) {
      html += `<td class="text-zinc-300 px-2 py-1 border-b border-border/30">${renderInline(escapeHtml(cell))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let inList = false;
  let listType = '';
  let tableRows: string[] = [];

  const closeList = () => {
    if (inList) {
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length >= 2) {
      closeList();
      html.push(renderTable(tableRows));
    }
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre class="text-[11px] bg-[#0d0d0d] border border-border rounded px-3 py-2 font-mono overflow-x-auto my-2 leading-snug"><code>${codeLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
        continue;
      }
      flushTable();
      inCodeBlock = true;
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Table rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Check if it's an alignment row (|---|---|)
      if (tableRows.length === 1 && /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|$/.test(line.trim())) {
        tableRows.push(line);
        continue;
      }
      tableRows.push(line);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      html.push('<div class="h-2"></div>');
      continue;
    }

    // HR
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      closeList();
      html.push('<hr class="border-border my-3" />');
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      closeList();
      const level = headerMatch[1].length;
      const sizes: Record<number, string> = {
        1: 'text-[14px] font-semibold text-zinc-100 mt-4 mb-2',
        2: 'text-[13px] font-semibold text-zinc-200 mt-3 mb-1.5',
        3: 'text-[12px] font-semibold text-zinc-300 mt-2 mb-1',
        4: 'text-[12px] font-medium text-zinc-400 mt-2 mb-1',
        5: 'text-[11px] font-medium text-zinc-400 mt-1 mb-0.5',
        6: 'text-[11px] font-medium text-zinc-500 mt-1 mb-0.5',
      };
      html.push(`<div class="${sizes[level] || sizes[3]}">${renderInline(escapeHtml(headerMatch[2]))}</div>`);
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('>')) {
      closeList();
      const content = line.replace(/^>\s?/, '');
      html.push(`<div class="border-l-2 border-zinc-600 pl-3 my-1 text-zinc-400 italic">${renderInline(escapeHtml(content))}</div>`);
      continue;
    }

    // Checkbox list
    const checkMatch = line.match(/^[\s]*[-*]\s+\[([ xX])\]\s+(.*)/);
    if (checkMatch) {
      if (!inList || listType !== 'ul') { closeList(); html.push('<ul class="space-y-0.5 my-1">'); inList = true; listType = 'ul'; }
      const checked = checkMatch[1].toLowerCase() === 'x';
      html.push(`<li class="flex items-start gap-1.5 list-none"><span class="${checked ? 'text-green-400' : 'text-zinc-700'} mt-0.5">${checked ? '☑' : '☐'}</span><span class="${checked ? 'text-zinc-500 line-through' : ''}">${renderInline(escapeHtml(checkMatch[2]))}</span></li>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[\s]*[-*+]\s+(.*)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') { closeList(); html.push('<ul class="space-y-0.5 my-1 list-none">'); inList = true; listType = 'ul'; }
      html.push(`<li class="flex items-start gap-1.5"><span class="text-zinc-600 mt-0.5">•</span><span>${renderInline(escapeHtml(ulMatch[1]))}</span></li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^[\s]*(\d+)[.)]\s+(.*)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') { closeList(); html.push('<ol class="space-y-0.5 my-1 list-none">'); inList = true; listType = 'ol'; }
      html.push(`<li class="flex items-start gap-1.5"><span class="text-zinc-500 shrink-0 w-4 text-right">${olMatch[1]}.</span><span>${renderInline(escapeHtml(olMatch[2]))}</span></li>`);
      continue;
    }

    // Regular paragraph — preserve safe HTML
    closeList();
    html.push(`<p class="my-0.5">${renderInline(escapeHtml(line))}</p>`);
  }

  if (inCodeBlock) {
    html.push(`<pre class="text-[11px] bg-[#0d0d0d] border border-border rounded px-3 py-2 font-mono overflow-x-auto my-2 leading-snug"><code>${codeLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`);
  }
  flushTable();
  closeList();

  return html.join('\n');
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const html = renderMarkdown(text);
  return (
    <div
      className={`text-[12px] text-zinc-300 leading-relaxed break-words [&_details]:my-2 [&_details]:border [&_details]:border-border [&_details]:rounded-lg [&_details]:overflow-hidden [&_summary]:px-3 [&_summary]:py-1.5 [&_summary]:bg-surface-light [&_summary]:cursor-pointer [&_summary]:text-zinc-300 [&_summary]:text-[12px] [&_summary]:font-medium [&_details>:not(summary)]:px-3 [&_details>:not(summary)]:py-2 ${className || ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
