import { createRoot } from 'react-dom/client'
import { useAppStore } from './store.ts'
import { FloatingCard } from './CardShell.tsx'
import { MainBoard } from './MainBoard.tsx'
import './styles.css'

/**
 * 一个 bundle，两种窗口。
 *
 * 浮卡窗口加载 #/card/<id>，main 板加载 #/main。
 * 具体是哪张卡由主进程说了算（它知道是哪个窗口在问），
 * hash 只是给人看和给调试用的。
 */

function Root(): React.ReactElement {
  const ready = useAppStore((state) => state.ready)
  const target = useAppStore((state) => state.target)
  const error = useAppStore((state) => state.error)

  if (error !== null) {
    return <div className="fatal">打不开：{error}</div>
  }
  if (!ready || target === null) {
    return <div className="loading">…</div>
  }
  return target.kind === 'main' ? <MainBoard /> : <FloatingCard cardId={target.cardId} />
}

void useAppStore.getState().init()

/*
 * 开发期自查钩子。
 *
 * 浮卡是无边框透明窗口，没有开发者工具入口，主进程也没法直接读渲染进程的状态。
 * 留这几个只读方法，主进程就能用 executeJavaScript 断言「广播到底有没有到」——
 * 这是「窗口 A 改标题、窗口 B 立刻变」这条验收标准唯一能自动验证的办法。
 */
;(window as unknown as Record<string, unknown>)['__kkb'] = {
  titleOf: (id: string): string | null => useAppStore.getState().cards[id]?.title ?? null,
  cardCount: (): number => Object.keys(useAppStore.getState().cards).length,
  focus: (): string | null => useAppStore.getState().focusId,
  history: () => useAppStore.getState().history,
}

const container = document.getElementById('root')
if (container !== null) createRoot(container).render(<Root />)
