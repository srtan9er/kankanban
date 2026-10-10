import {discardLegacyInk} from '../core/drawing.ts';
import { Fragment, type ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} onClick={e => { e.preventDefault(); void import('./native.ts').then(m => m.openLink(link[2]!)); }}>{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** React text nodes escape all raw HTML. Links are explicitly restricted to http(s). */
export function Markdown({ text, placeholder }: { text: string; placeholder?: string }): ReactNode {
  text=discardLegacyInk(text);
  if (!text.trim() && placeholder) return <div className="markdown body-placeholder">{placeholder}</div>;
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i]!);
      blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>); continue;
    }
    if (!line.trim()) { blocks.push(<div className="paragraph-gap" key={i} />); continue; }
    if (/^### /.test(line)) blocks.push(<h3 key={i}>{inline(line.slice(4))}</h3>);
    else if (/^## /.test(line)) blocks.push(<h2 key={i}>{inline(line.slice(3))}</h2>);
    else if (/^# /.test(line)) blocks.push(<h1 key={i}>{inline(line.slice(2))}</h1>);
    else if (/^> /.test(line)) blocks.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>);
    else if (/^[-*] \[[ xX]\] /.test(line)) blocks.push(<div className="md-task" key={i}><input type="checkbox" readOnly checked={line[3]?.toLowerCase() === 'x'} />{inline(line.slice(6))}</div>);
    else if (/^[-*] /.test(line)) blocks.push(<div className="md-list" key={i}><span>•</span>{inline(line.slice(2))}</div>);
    else if (/^\d+\. /.test(line)) blocks.push(<div className="md-list" key={i}>{inline(line)}</div>);
    else blocks.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
