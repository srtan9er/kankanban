import { app, BrowserWindow } from 'electron'
import type { WorkspaceService } from './service.ts'
import type { WindowManager } from './windows.ts'

/**
 * 阶段二验收自查。
 *
 * 界面类的东西很难自动断言，但阶段二那几条验收标准其实是可以机械验证的 ——
 * 它们说的都是「某个操作之后，窗口和数据分别变成什么样」：
 *
 *   1. main 板建卡 → 自动开窗
 *   2. 在窗口 A 改标题，窗口 B 立刻变        ← 靠 executeJavaScript 读渲染进程的状态
 *   3. 关闭浮卡窗口 → 卡还在，能重新打开
 *   4. 收回进容器 → 窗口关、卡进容器
 *   5. 广播到达每个窗口（不是只到了发起的那个）
 *
 * 由 KKB_VERIFY=1 触发。
 */

interface Check {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function titleInRenderer(window: BrowserWindow, cardId: string): Promise<string | null> {
  try {
    return (await window.webContents.executeJavaScript(
      `window.__kkb ? window.__kkb.titleOf(${JSON.stringify(cardId)}) : '__NO_HOOK__'`,
      true,
    )) as string | null
  } catch (error) {
    return `__ERR__ ${error instanceof Error ? error.message : String(error)}`
  }
}

async function cardCountInRenderer(window: BrowserWindow): Promise<number | string> {
  try {
    return (await window.webContents.executeJavaScript(
      `window.__kkb ? window.__kkb.cardCount() : '__NO_HOOK__'`,
      true,
    )) as number | string
  } catch (error) {
    return `__ERR__ ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function runVerification(service: WorkspaceService, windows: WindowManager): Promise<void> {
  const checks: Check[] = []
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  await sleep(2500)

  // ---------------------------------------------------------------- 1. 建浮卡自动开窗
  const a = await service.run({ type: 'card_create', parent: null, title: '甲：会被改名的卡' })
  const b = await service.run({ type: 'card_create', parent: null, title: '乙：旁观者' })
  await sleep(2200)

  const idA = a.created ?? ''
  const idB = b.created ?? ''
  const winA = windows.stateOf(idA)
  const winB = windows.stateOf(idB)

  record(
    '1. 建浮卡自动开窗',
    winA !== undefined && winB !== undefined,
    winA !== undefined && winB !== undefined ? `两个窗口都开了：${idA} / ${idB}` : '窗口没开出来',
  )

  // ---------------------------------------------------------------- 2. 广播：A 改 B 变
  const beforeA = await titleInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idA}`)?.window as BrowserWindow, idA)
  const beforeB = await titleInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idB}`)?.window as BrowserWindow, idB)
  void beforeB

  await service.run({ type: 'card_update', id: idA, patch: { title: '甲：改过名字了' } })
  await sleep(900)

  const afterA = await titleInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idA}`)?.window as BrowserWindow, idA)
  const afterB = await titleInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idB}`)?.window as BrowserWindow, idB)

  // B 窗口的根卡不是 A，但它的 cards 副本里应该有 A 的新标题 —— 这就是广播到位的证据
  const bSeesTitle = await window0(() =>
    (windows.labeledWindows().find((w) => w.label === `card-${idB}`)?.window as BrowserWindow).webContents.executeJavaScript(
      `window.__kkb ? window.__kkb.titleOf(${JSON.stringify(idA)}) : null`,
      true,
    ),
  )

  record(
    '2. 在 A 改标题，B 窗口的副本也跟着变',
    afterA === '甲：改过名字了' && bSeesTitle === '甲：改过名字了',
    `A 窗口里：${String(beforeA)} → ${String(afterA)}；B 窗口看到的 A：${String(bSeesTitle)}（B 自己的标题仍是 ${String(afterB)}）`,
  )

  record(
    '3. 两个窗口的卡片总数一致（说明收到的是同一份数据）',
    (await cardCountInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idA}`)?.window as BrowserWindow)) ===
      (await cardCountInRenderer(windows.labeledWindows().find((w) => w.label === `card-${idB}`)?.window as BrowserWindow)),
    'A 和 B 各自数出来的卡片数量',
  )

  // ---------------------------------------------------------------- 4. 关窗不丢卡
  const winAObj = windows.labeledWindows().find((w) => w.label === `card-${idA}`)?.window
  winAObj?.hide()
  await sleep(500)
  const stillThere = service.cardView(idA) !== null
  const windowCountAfterHide = windows.openCards().length

  // 重新叫回来
  windows.openCard(idA, service.cardState(idA))
  await sleep(700)
  const backVisible = windows.labeledWindows().find((w) => w.label === `card-${idA}`)?.window.isVisible() ?? false

  record(
    '4. 关掉窗口卡片还在，能重新叫回来',
    stillThere && backVisible,
    `隐藏后工作区里还有这张卡：${stillThere}；重新打开后可见：${backVisible}（窗口数 ${windowCountAfterHide}）`,
  )

  // ---------------------------------------------------------------- 5. 收回进容器
  const column = service.firstBoardColumn()
  if (column === null) {
    record('5. 收回进容器', false, '找不到看板的第一列')
  } else {
    const outcome = await service.run({ type: 'card_move', id: idA, parent: column })
    await sleep(900)
    const floatA = service.isFloating(idA)
    const windowGone = windows.labeledWindows().find((w) => w.label === `card-${idA}`) === undefined
    record(
      '5. 收回进容器：窗口关掉，卡片落到列里',
      outcome.ok && !floatA && windowGone,
      `移进「待办」成功：${outcome.ok}；不再是浮卡：${!floatA}；窗口已销毁：${windowGone}`,
    )
  }

  // ---------------------------------------------------------------- 6. 删除浮卡
  const outcomeTrash = await service.run({ type: 'card_trash', id: idB })
  await sleep(900)
  const bGone = windows.labeledWindows().find((w) => w.label === `card-${idB}`) === undefined
  const bStillInWorkspace = service.cardView(idB) !== null
  record(
    '6. 删除浮卡：窗口关了，卡片只是进了回收站',
    outcomeTrash.ok && bGone && bStillInWorkspace,
    `窗口已关：${bGone}；工作区里还查得到：${bStillInWorkspace}`,
  )

  // ---------------------------------------------------------------- 报告
  const passed = checks.filter((c) => c.ok).length
  process.stdout.write('\n\n===VERIFY===\n')
  for (const check of checks) {
    process.stdout.write(`${check.ok ? '  ✅' : '  ❌'} ${check.name}\n        ${check.detail}\n`)
  }
  process.stdout.write(`\n  ${passed}/${checks.length} 条通过\n===END===\n`)

  if (process.env['KKB_VERIFY_EXIT'] === '1') app.exit(passed === checks.length ? 0 : 1)
}

/** 小助手：把一段可能抛异常的异步读取包起来。 */
async function window0(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (error) {
    return `__ERR__ ${error instanceof Error ? error.message : String(error)}`
  }
}
