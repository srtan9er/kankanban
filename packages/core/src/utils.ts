/** 一堆小工具。刻意保持零依赖。 */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深比较。用于「值没变就不要发事件」——事件日志是给同步和 AI 看的，
 * 塞满没意义的空转事件会让它变成噪声。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const aKeys = Object.keys(ao)
    const bKeys = Object.keys(bo)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) => Object.hasOwn(bo, key) && deepEqual(ao[key], bo[key]))
  }
  return false
}

/** 深拷贝。结构化克隆够用，且不会像 JSON 往返那样吃掉 undefined。 */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 去重并去掉空白项，保持首次出现的顺序。 */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
