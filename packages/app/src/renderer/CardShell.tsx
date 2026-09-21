import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Card } from '@kankanban/core'
import { useAppStore } from './store.ts'
import { Markdown } from './markdown.tsx'
import { childrenOf, crumbsWithin, getCard, isFloating } from './selectors.ts'

/**
 * 三区域卡片：面包屑索引区 / 正文区 / 子卡片区。
 *
 * 一个必须记住的坑：**这里绝不能出现 `-webkit-app-region: drag`。**
 * 只要它出现在 DOM 里，整张卡片的 CSS 圆角就会被合成层绕过、变成直角
 * （spike/corner.ts 里有四组对照实验）。窗口拖动改成主进程轮询光标自己实现了。
 */

const MIN_KIDS = 0
const MAX_KIDS_RATIO = 0.72

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

function EditableTitle({ card, floating }: { card: Card; floating: boolean }): ReactNode {
  const run = useAppStore((state) => state.run)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(card.title)

  useEffect(() => {
    if (!editing) setDraft(card.title)
  }, [card.title, editing])

  const commit = async (): Promise<void> => {
    setEditing(false)
    const next = draft.trim()
    if (next === card.title || next === '') return
    await run({ type: 'card_update', id: card.id, patch: { title: next } })
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`title ${floating ? 'draggable' : ''}`}
        onClick={() => setEditing(true)}
        title="单击改名"
      >
        {card.title || '未命名'}
      </button>
    )
  }

  return (
    <input
      className="title-input"
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void commit()
        if (event.key === 'Escape') {
          setDraft(card.title)
          setEditing(false)
        }
      }}
    />
  )
}

function EditableBody({ card }: { card: Card }): ReactNode {
  const run = useAppStore((state) => state.run)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(card.content)

  useEffect(() => {
    if (!editing) setDraft(card.content)
  }, [card.content, editing])

  const commit = async (): Promise<void> => {
    setEditing(false)
    if (draft === card.content) return
    await run({ type: 'card_update', id: card.id, patch: { content: draft } })
  }

  if (editing) {
    return (
      <textarea
        className="body-input"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(card.content)
            setEditing(false)
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
        }}
      />
    )
  }

  return (
    <div className="body-view" onClick={() => setEditing(true)} title="单击编辑正文">
      <Markdown text={card.content} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 紧凑卡
// ---------------------------------------------------------------------------

export function CompactCard({ cardId, onDrill }: { cardId: string; onDrill?: (id: string) => void }): ReactNode {
  const cards = useAppStore((state) => state.cards)
  const card = getCard(cards, cardId)
  if (card === undefined) return null

  const floating = isFloating(cards, cardId)

  return (
    <div
      className={`compact ${floating ? 'is-floating' : ''}`}
      style={card.color !== undefined ? { borderLeftColor: card.color } : undefined}
      onDoubleClick={() => onDrill?.(cardId)}
      onContextMenu={(event) => {
        event.preventDefault()
        void window.kkb.contextMenu({ cardId })
      }}
      title="双击下钻 · 右键更多"
    >
      <div className="compact-title">{card.title || '未命名'}</div>
      <div className="compact-meta">
        {floating ? <span className="badge floating">浮</span> : null}
        {card.children.length > 0 ? <span className="badge">{card.children.length}</span> : null}
        {card.due !== undefined && card.due !== null ? <span className="badge due">{card.due}</span> : null}
        {card.tags?.map((tag) => (
          <span key={tag} className="badge tag">
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 子卡片区
// ---------------------------------------------------------------------------

function ChildrenArea({ parentId, onDrill }: { parentId: string; onDrill: (id: string) => void }): ReactNode {
  const cards = useAppStore((state) => state.cards)
  const parent = getCard(cards, parentId)
  const children = useMemo(() => childrenOf(cards, parentId), [cards, parentId])

  if (parent === undefined) return null

  const view = parent.view ?? 'row'

  const blank = (
    <div
      className="kids-blank"
      onContextMenu={(event) => {
        event.preventDefault()
        void window.kkb.contextMenu({ cardId: null, containerId: parentId })
      }}
    >
      右键在这里建子卡
    </div>
  )

  if (children.length === 0) return <div className="kids empty">{blank}</div>

  if (view === 'kanban') {
    return (
      <div className="kids kanban">
        {children.map((column) => {
          const columnCards = childrenOf(cards, column.id)
          return (
            <div key={column.id} className="lane">
              <div className="lane-head">
                <span>{column.title}</span>
                <span className="lane-count">{columnCards.length}</span>
              </div>
              <div
                className="lane-body"
                onContextMenu={(event) => {
                  event.preventDefault()
                  void window.kkb.contextMenu({ cardId: null, containerId: column.id })
                }}
              >
                {columnCards.map((child) => (
                  <CompactCard key={child.id} cardId={child.id} onDrill={onDrill} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const className = view === 'column' ? 'kids column' : view === 'grid' ? 'kids grid' : 'kids row'

  return (
    <div
      className={className}
      onContextMenu={(event) => {
        event.preventDefault()
        void window.kkb.contextMenu({ cardId: null, containerId: parentId })
      }}
    >
      {children.map((child) => (
        <CompactCard key={child.id} cardId={child.id} onDrill={onDrill} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 卡片主体
// ---------------------------------------------------------------------------

export function CardShell({
  windowRootId,
  focusId,
  onDrill,
}: {
  windowRootId: string
  focusId: string
  onDrill: (id: string) => void
}): ReactNode {
  const cards = useAppStore((state) => state.cards)
  const card = getCard(cards, focusId)
  const crumbs = useMemo(() => crumbsWithin(cards, windowRootId, focusId), [cards, windowRootId, focusId])

  const [kidsHeight, setKidsHeight] = useState(190)
  const shellRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)

  const onDividerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      dragState.current = { startY: event.clientY, startHeight: kidsHeight }
    },
    [kidsHeight],
  )

  const onDividerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current
    const shell = shellRef.current
    if (state === null || shell === null) return
    const max = shell.clientHeight * MAX_KIDS_RATIO
    const next = Math.min(Math.max(state.startHeight - (event.clientY - state.startY), MIN_KIDS), max)
    setKidsHeight(next)
  }, [])

  const onDividerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = null
    ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
  }, [])

  if (card === undefined) {
    return <div className="fatal">卡片不见了：{focusId}</div>
  }

  const collapsed = kidsHeight < 10
  // 看板和 main 不显示正文 —— 它们的主要任务是摆放子卡
  const showBody = card.view !== 'kanban'

  return (
    <div className="shell" ref={shellRef}>
      {/* 面包屑索引区 */}
      <div className="crumbs">
        {crumbs.map((crumb, index) => (
          <span key={crumb.id} className="crumb-wrap">
            {index > 0 ? <span className="crumb-sep">›</span> : null}
            <button
              type="button"
              className={`crumb ${crumb.id === focusId ? 'current' : ''}`}
              onClick={() => onDrill(crumb.id)}
              disabled={crumb.id === focusId}
            >
              {crumb.title || '未命名'}
            </button>
          </span>
        ))}
        <span className="spacer" />
        {card.due !== undefined && card.due !== null ? <span className="badge due">{card.due}</span> : null}
        {card.tags?.map((tag) => (
          <span key={tag} className="badge tag">
            {tag}
          </span>
        ))}
      </div>

      {/* 正文区 */}
      {showBody ? (
        <>
          <div className="body">
            <EditableBody card={card} />
          </div>

          {/* 子卡片区的折叠把手 */}
          <div
            className="divider"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            title={collapsed ? '往下拖展开' : '往上拖折叠'}
          />
        </>
      ) : null}

      {/* 子卡片区 */}
      <div
        className={collapsed && showBody ? 'kids-slot collapsed' : 'kids-slot'}
        style={showBody && !collapsed ? { height: kidsHeight, flex: '0 0 auto' } : undefined}
      >
        {collapsed && showBody ? (
          <button type="button" className="kids-stub" onClick={() => setKidsHeight(190)}>
            子卡片（{card.children.length}）· 点一下展开
          </button>
        ) : (
          <ChildrenArea parentId={focusId} onDrill={onDrill} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 浮卡窗口
// ---------------------------------------------------------------------------

export function FloatingCard({ cardId }: { cardId: string }): ReactNode {
  const cards = useAppStore((state) => state.cards)
  const focusId = useAppStore((state) => state.focusId)
  const focus = useAppStore((state) => state.focus)
  const run = useAppStore((state) => state.run)
  const notice = useAppStore((state) => state.notice)

  const card = getCard(cards, cardId)
  const active = focusId !== null && getCard(cards, focusId) !== undefined ? focusId : cardId

  /*
   * 窗口拖动：pointerdown 告诉主进程「开始拖」，主进程去轮询光标。
   * 不用 -webkit-app-region: drag —— 它会让 CSS 圆角整体失效。
   */
  useEffect(() => {
    const stop = (): void => window.kkb.dragEnd()
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
  }, [])

  if (card === undefined) return <div className="fatal">卡片不见了：{cardId}</div>

  return (
    <div className="window-frame">
      <div
        className="window-card"
        onContextMenu={(event) => {
          event.preventDefault()
          void window.kkb.contextMenu({ cardId: active })
        }}
      >
        <div className="window-head" onPointerDown={() => window.kkb.dragStart()}>
          <span className="grip" />
          <EditableTitle card={getCard(cards, active) ?? card} floating />
          <span className="spacer" />
          <button
            type="button"
            className="win-btn"
            title="置顶"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void window.kkb.windowAction('toggle-always-on-top')}
          >
            ⇧
          </button>
          <button
            type="button"
            className="win-btn"
            title="最小化"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void window.kkb.windowAction('minimize')}
          >
            –
          </button>
          <button
            type="button"
            className="win-btn danger"
            title="关掉窗口（卡片还在，右键能叫回来）"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void window.kkb.windowAction('close')}
          >
            ×
          </button>
        </div>

        <CardShell windowRootId={cardId} focusId={active} onDrill={(id) => focus(id)} />

        <div className="window-foot">
          <button
            type="button"
            className="foot-btn"
            disabled={!(isFloating(cards, active) || active !== cardId)}
            onClick={() => void run({ type: 'card_move', id: active, parent: null })}
          >
            浮动到桌面
          </button>
          <span className="spacer" />
          <span className="foot-hint">{active === cardId ? '根卡' : '下钻中'}</span>
        </div>
      </div>
      {notice !== null ? <div className="notice">{notice}</div> : null}
    </div>
  )
}
