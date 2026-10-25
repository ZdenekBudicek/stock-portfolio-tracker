// A deliberately tiny Markdown subset for verified assistant answers: paragraphs, line breaks,
// "•"/"-" bullet lists, **bold** and [title](url) links. Everything is rendered as React text, so
// HTML, scripts and images stay visible characters and never create an element or a request.
// A link becomes active only when its exact URL is in the verified list the server sent.
import { Fragment, type ReactNode } from 'react';
import type { Link } from '../../supabase/functions/agent/core/protocol.ts';
import { cn } from '@/lib/utils';

/** https only, no credentials, ports or IP hosts — checked again here, whatever the list says. */
export function isSafeHref(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && url.hostname.includes('.') && !/^[\d.]+$/.test(url.hostname) && !url.hostname.startsWith('[');
}

function inline(text: string, allowed: ReadonlySet<string>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*\n]+)\*\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g;
  let last = 0, n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${key}-${n++}`} className="font-semibold text-foreground">{m[1]}</strong>);
    else if (allowed.has(m[3]) && isSafeHref(m[3])) {
      out.push(<a key={`${key}-${n++}`} href={m[3]} target="_blank" rel="noopener noreferrer"
        className="text-primary underline-offset-2 hover:underline">{m[2]}</a>);
    } else out.push(m[2]); // an unverified link keeps only its words
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*(?:•|-)\s+/;

export function SafeMarkdown({ text, links, className }: { text: string; links: Link[]; className?: string }) {
  const allowed = new Set(links.map(l => l.url).filter(isSafeHref));
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(b => b.split('\n').filter(l => l.trim()));
  return (
    <div className={cn('space-y-2.5 text-[13.5px] leading-relaxed', className)}>
      {blocks.map((lines, b) => {
        // Consecutive bullet lines form one list; other lines stay a paragraph with line breaks.
        const groups: { list: boolean; lines: string[] }[] = [];
        for (const line of lines) {
          const list = BULLET.test(line);
          const last = groups[groups.length - 1];
          if (last && last.list === list) last.lines.push(line); else groups.push({ list, lines: [line] });
        }
        return (
          <Fragment key={b}>
            {groups.map((g, i) => g.list ? (
              <ul key={i} className="space-y-1 pl-1">
                {g.lines.map((l, j) => (
                  <li key={j} className="flex gap-2"><span aria-hidden className="text-primary/80">•</span><span>{inline(l.replace(BULLET, ''), allowed, `${b}-${i}-${j}`)}</span></li>
                ))}
              </ul>
            ) : (
              <p key={i}>
                {g.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {/* A short first line without a full stop is a block heading of the verified renderer. */}
                    {j === 0 && g.lines.length > 1 && l.length <= 40 && !/[.:!?]$/.test(l)
                      ? <span className="font-semibold text-foreground">{inline(l, allowed, `${b}-${i}-${j}`)}</span>
                      : inline(l, allowed, `${b}-${i}-${j}`)}
                  </Fragment>
                ))}
              </p>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
