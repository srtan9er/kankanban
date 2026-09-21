/**
 * 错误类型。
 *
 * 消息一律写成人话（中文），因为：git 面板要把错误翻译成人话，
 * MCP 工具的错误也会直接回到 AI 面前，含糊的消息会让人和 AI 都瞎猜。
 */

export type KkbErrorCode =
  | 'CARD_NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'CYCLE_DETECTED'
  | 'RESERVED_CARD'
  | 'ID_DUPLICATE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MOVE'
  | 'CARD_TRASHED'
  | 'WORKSPACE_LOCKED'
  | 'CORRUPT_CARD_FILE'
  | 'TREE_CORRUPT'
  | 'IO_ERROR'

export type KkbErrorDetails = Record<string, unknown>

export class KkbError extends Error {
  readonly code: KkbErrorCode
  readonly details: KkbErrorDetails

  constructor(code: KkbErrorCode, message: string, details: KkbErrorDetails = {}) {
    super(message)
    this.name = 'KkbError'
    this.code = code
    this.details = details
  }

  toJSON(): { code: KkbErrorCode; message: string; details: KkbErrorDetails } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function isKkbError(e: unknown): e is KkbError {
  return e instanceof KkbError
}

/** 把任意抛出的东西变成 KkbError，保证 MCP 层永远能拿到结构化的错误。 */
export function toKkbError(e: unknown): KkbError {
  if (isKkbError(e)) return e
  if (e instanceof Error) {
    const withCode = e as Error & { code?: unknown }
    if (typeof withCode.code === 'string' && withCode.code.startsWith('E')) {
      return new KkbError('IO_ERROR', `文件操作失败：${e.message}`, { cause: withCode.code })
    }
    return new KkbError('IO_ERROR', e.message)
  }
  return new KkbError('IO_ERROR', String(e))
}

export function cardNotFound(id: string): KkbError {
  return new KkbError('CARD_NOT_FOUND', `找不到卡片 ${id}。它可能已经被删除，或者 id 写错了。`, { id })
}

export function reservedCard(id: string, what: string): KkbError {
  return new KkbError('RESERVED_CARD', `卡片 ${id} 是保留根卡片，不能${what}。`, { id })
}

export function invalidArgument(what: string, details: KkbErrorDetails = {}): KkbError {
  return new KkbError('INVALID_ARGUMENT', what, details)
}
