import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from './store.ts'
import { CardShell } from './CardShell.tsx'
import { allVisible, floatingCards, getCard, roots } from './selectors.ts'

/**
 * main 板：应用外壳。
 *
 * 三栏 —— 卡片管理器 / git / 设置。git 那一栏是阶段四的事，这里先占位，
 * 但把「所有浮卡的入口」和「撤销栈」放出来，因为它现在就有用。
 */

const ROOT_LABELS: Record<string, string> = {
  '001': '看板',
  '002': '灵感台',
  '003': '预制体',
}

export function MainBoard(): ReactNode {
  const cards = useAppStore((state) => state.cards)
  const history = useAppStore((state) => state.history)
  const workspaceName = useAppStore((state) => state.workspaceName)
  const workspaceRoot = useAppStore((state) => state.workspaceRoot)
  const undo = useAppStore((state) => state.undo)
  const redo = useAppStore((state) => state.redo)
  const run = useAppStore((state) => state.run)
  const notice = useAppStore((state) => state.notice)

  const [selected, setSelected] = useState('001')

  const rootCards = roots(cards).filter((card) => card.id !== '000')
  const floaters = floatingCards(cards)
  const selectedCard = getCard(cards, selected)
  const visible = allVisible(cards).length

  return (
    <div className="board-layout">
      {/* 卡片管理器 */}
      <aside className="rail">
        <div className="rail-head">
          <div className="rail-title">{workspaceName}</div>
          <div className="rail-sub" title={workspaceRoot}>
            {workspaceRoot}
          </div>
        </div>

        <div className="rail-section">
          <div className="rail-label">固定根节点</div>
          {rootCards.map((card) => (
            <button
              key={card.id}
              type="button"
              className={`rail-item ${card.id === selected ? 'active' : ''}`}
              onClick={() => setSelected(card.id)}
            >
              <span className="rail-item-title">{ROOT_LABELS[card.id] ?? card.title}</span>
              <span className="rail-count">{card.children.length}</span>
            </button>
          ))}
        </div>

        <div className="rail-section">
          <div className="rail-label">
            桌面上的浮卡
            <span className="rail-count">{floaters.length}</span>
          </div>
          {floaters.length === 0 ? (
            <div className="rail-empty">还没有浮卡</div>
          ) : (
            floaters.map((card) => (
              <button
                key={card.id}
                type="button"
                className="rail-item"
                onClick={() => void run({ type: 'card_update', id: card.id, patch: {} })}
                onDoubleClick={() => setSelected(card.id)}
                title="双击在看板里查看"
              >
                <span className="rail-item-title">{card.title}</span>
              </button>
            ))
          )}
        </div>

        <div className="rail-foot">
          <button type="button" className="wide-btn primary" onClick={() => void run({ type: 'card_create', parent: null, title: '新卡片' })}>
            ＋ 新建浮卡
          </button>
          <div className="row">
            <button type="button" className="wide-btn" disabled={!history.canUndo} onClick={() => void undo()} title={history.undoLabel ?? ''}>
              撤销
            </button>
            <button type="button" className="wide-btn" disabled={!history.canRedo} onClick={() => void redo()} title={history.redoLabel ?? ''}>
              重做
            </button>
          </div>
          <div className="rail-stats">{visible} 张可见卡片</div>
        </div>
      </aside>

      {/* 中间：选中的根节点 */}
      <main className="stage">
        {selectedCard === undefined ? (
          <div className="fatal">选中的卡片不见了</div>
        ) : (
          <CardShell windowRootId={selected} focusId={selected} onDrill={setSelected} />
        )}
      </main>

      {/* git / 设置 */}
      <aside className="rail right">
        <div className="rail-section">
          <div className="rail-label">git</div>
          <div className="placeholder">
            阶段四。到时会在这里呈现 git 树、执行操作，
            并且**显示 LFS 状态** —— 美术最想问「我那张图真的传上去了吗」。
          </div>
        </div>
        <div className="rail-section">
          <div className="rail-label">设置</div>
          <div className="placeholder">快捷键等全局应用设置放这里（不是工作区设置）。</div>
        </div>
        <div className="rail-section">
          <div className="rail-label">阶段状态</div>
          <div className="placeholder small">
            阶段一 核心库 + MCP ✅
            <br />
            阶段二 最小 UI ← 正在做
            <br />
            阶段三 固定根节点
            <br />
            阶段四 git 集成
            <br />
            阶段五 打磨与演示
          </div>
        </div>
      </aside>

      {notice !== null ? <div className="notice board-notice">{notice}</div> : null}
    </div>
  )
}
