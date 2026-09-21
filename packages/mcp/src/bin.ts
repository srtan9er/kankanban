import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { toKkbError, Workspace } from '@kankanban/core'
import { createStandaloneBackend } from './backend.ts'
import { createMcpServer } from './server.ts'

/**
 * 独立 stdio 入口。
 *
 * 注意：stdout 是 MCP 的协议通道，任何调试输出都必须走 stderr。
 *
 * 阶段二之后这个进程会搬进 Electron 主进程（两个进程同时写 .kkb 会互相覆盖），
 * 但独立模式保留给「只让 AI 用、不开 UI」的场景。
 */

interface Args {
  dir: string
  lock: boolean
}

function usage(): string {
  return [
    'KankanBan MCP server',
    '',
    '用法:',
    '  node src/bin.ts [工作区目录] [--dir <目录>] [--no-lock]',
    '',
    '参数:',
    '  目录            工作区目录（.kkb 所在的父目录）。缺省取 KKB_WORKSPACE 环境变量，再缺省取当前目录。',
    '  --dir, -d       同上，显式指定。',
    '  --no-lock       不加工作区锁。只有在确定没有别的进程在写同一个工作区时才用。',
    '  --help, -h      显示这段帮助。',
  ].join('\n')
}

export function parseArgs(argv: readonly string[]): Args {
  let dir = process.env['KKB_WORKSPACE'] ?? process.cwd()
  let lock = true

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '--dir' || arg === '-d') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error('--dir 后面要跟一个目录')
      dir = next
      i++
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length)
    } else if (arg === '--no-lock') {
      lock = false
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(usage() + '\n')
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      dir = arg
    } else {
      throw new Error(`不认识的参数：${arg}\n\n${usage()}`)
    }
  }

  return { dir, lock }
}

async function main(): Promise<void> {
  const { dir, lock } = parseArgs(process.argv.slice(2))

  const workspace = await Workspace.open({ dir, create: true, lock })
  process.stderr.write(
    `[kankanban] 工作区 ${workspace.paths.root}（${workspace.allCards().length} 张卡，lastSeq=${workspace.lastSeq()}）\n`,
  )

  const server = createMcpServer(createStandaloneBackend(workspace))
  await server.connect(new StdioServerTransport())

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await server.close().catch(() => undefined)
    await workspace.close().catch(() => undefined)
  }

  /*
   * stdin 关闭（客户端断了）时**不要**马上 process.exit：
   * 可能还有正在处理的工具调用没写完盘。close() 会把三处队列都等干净，
   * 之后事件循环自然就空了，进程会自己退出。
   */
  process.stdin.on('close', () => {
    void shutdown()
  })

  // 收到信号是真的要走了，但也要先把盘写完再走。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown().then(() => process.exit(0))
    })
  }
}

try {
  await main()
} catch (error) {
  const kkb = toKkbError(error)
  process.stderr.write(`[kankanban] 启动失败：${kkb.message}\n`)
  process.exit(1)
}
