import { randomBytes } from 'node:crypto'

/** 卡片 id 前缀。保留根卡片不用前缀，是 '000' 这样的三位数字，读起来醒目。 */
const CARD_PREFIX = 'c_'
const EVENT_PREFIX = 'e_'

function token(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * 生成卡片 id。
 *
 * `exists` 用来避免碰撞——虽然 4 字节随机撞上的概率极低，
 * 但卡片 id 会变成文件名，撞一次就会覆盖别人的工作，值得花这几行。
 */
export function createCardId(exists: (id: string) => boolean = () => false): string {
  for (let i = 0; i < 1000; i++) {
    const id = CARD_PREFIX + token(4)
    if (!exists(id)) return id
  }
  throw new Error('连续 1000 次都没生成出不重复的卡片 id，随机源可能坏了')
}

export function isCardId(id: string): boolean {
  return id.startsWith(CARD_PREFIX)
}

export function createEventId(): string {
  return EVENT_PREFIX + token(6)
}

export function createWorkspaceId(): string {
  return 'ws_' + token(6)
}

export function createClientId(): string {
  return 'cl_' + token(6)
}
