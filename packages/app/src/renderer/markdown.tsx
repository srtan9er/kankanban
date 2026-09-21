import type { ReactNode } from 'react'

/**
 * 极简 Markdown 渲染。
 *
 * 刻意产出 React 元素而不是 innerHTML —— 这样天然没有注入问题，
 * 也不用引 dompurify。覆盖标题、粗斜体、行内代码、链接、列表、引用、分隔线、
 * 围栏代码块，够卡片正文用。
 *
 * 完整的编辑体验（CodeMirror 6）留到后面。
 */

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g
  let last = 0
  let index = 0
  let match = pattern.exec(text)

  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index++}`

    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('[')) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      nodes.push(
        <a key={key} href={parts?.[2] ?? '#'} target="_blank" rel="noreferrer">
          {parts?.[1] ?? token}
        </a>,
      )
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    }

    last = match.index + token.length
    match = pattern.exec(text)
  }

  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ text, empty }: { text: string; empty?: ReactNode }): ReactNode {
  if (text.trim() === '') {
    return <div className="md-empty">{empty ?? '点一下写点什么'}</div>
  }

  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  const push = (node: ReactNode): void => {
    blocks.push(node)
    key++
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i++
      continue
    }

    // 围栏代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // 跳过结束的 ```
      push(
        <pre key={`b${key}`} data-lang={lang || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = heading[1]?.length ?? 1
      const content = inline(heading[2] ?? '', `h${key}`)
      if (level === 1) push(<h1 key={`b${key}`}>{content}</h1>)
      else if (level === 2) push(<h2 key={`b${key}`}>{content}</h2>)
      else if (level === 3) push(<h3 key={`b${key}`}>{content}</h3>)
      else push(<h4 key={`b${key}`}>{content}</h4>)
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      push(<hr key={`b${key}`} />)
      i++
      continue
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, ''))
        i++
      }
      push(
        <ul key={`b${key}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `ul${key}-${n}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      push(
        <ol key={`b${key}`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `ol${key}-${n}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // 引用
    if (line.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i++
      }
      push(<blockquote key={`b${key}`}>{inline(body.join(' '), `q${key}`)}</blockquote>)
      continue
    }

    // 段落
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (
        current.trim() === '' ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*[-*]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        current.startsWith('>') ||
        current.trimStart().startsWith('```')
      ) {
        break
      }
      paragraph.push(current)
      i++
    }
    push(<p key={`b${key}`}>{inline(paragraph.join(' '), `p${key}`)}</p>)
  }

  return <div className="md">{blocks}</div>
}
