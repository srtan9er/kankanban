import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  assertMovable,
  childCardsOf,
  childIndex,
  depthOf,
  descendantsOf,
  isDescendantOf,
  rootOf,
  scopeOf,
  subtreeOf,
} from '../src/index.ts'
import { card, lookupOf } from './helpers.ts'

/** 一棵小树：001(看板) ├ a ├ a1 └ b，外加一棵浮卡树 c_float ├ f1 */
const CARDS = [
  card('001', { scope: 'public', view: 'kanban', children: [{ id: 'a' }, { id: 'b' }] }),
  card('a', { parent: '001', scope: 'public', children: [{ id: 'a1' }] }),
  card('a1', { parent: 'a', scope: 'public' }),
  card('b', { parent: '001', scope: 'public' }),
  card('c_float', { parent: null, scope: 'private', children: [{ id: 'f1' }] }),
  card('f1', { parent: 'c_float', scope: 'private' }),
]

const get = lookupOf(CARDS)

describe('树遍历', () => {
  it('ancestorsOf 从父到根，不含自己', () => {
    expect(ancestorsOf(get, 'a1').map((c) => c.id)).toEqual(['a', '001'])
    expect(ancestorsOf(get, '001')).toEqual([])
  })

  it('rootOf 找出所在树的根', () => {
    expect(rootOf(get, 'a1').id).toBe('001')
    expect(rootOf(get, 'f1').id).toBe('c_float')
  })

  it('depthOf 根为 0', () => {
    expect(depthOf(get, '001')).toBe(0)
    expect(depthOf(get, 'a')).toBe(1)
    expect(depthOf(get, 'a1')).toBe(2)
  })

  it('descendantsOf 是深度优先，不含自己', () => {
    expect(descendantsOf(get, '001').map((c) => c.id)).toEqual(['a', 'a1', 'b'])
    expect(descendantsOf(get, 'a1')).toEqual([])
  })

  it('subtreeOf 含自己', () => {
    expect(subtreeOf(get, 'a').map((c) => c.id)).toEqual(['a', 'a1'])
  })

  it('childCardsOf 保持 children 的顺序', () => {
    expect(childCardsOf(get, '001').map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('isDescendantOf 不含自己', () => {
    expect(isDescendantOf(get, 'a1', '001')).toBe(true)
    expect(isDescendantOf(get, '001', 'a1')).toBe(false)
    expect(isDescendantOf(get, 'a', 'a')).toBe(false)
  })

  it('childIndex 找不到时返回 -1', () => {
    expect(childIndex(get('001')!, 'b')).toBe(1)
    expect(childIndex(get('001')!, 'a1')).toBe(-1)
  })
})

describe('作用域是派生的', () => {
  it('保留根底下一律公有', () => {
    expect(scopeOf(get, '001')).toBe('public')
    expect(scopeOf(get, 'a1')).toBe('public')
  })

  it('浮卡底下一律私有', () => {
    expect(scopeOf(get, 'c_float')).toBe('private')
    expect(scopeOf(get, 'f1')).toBe('private')
  })
})

describe('环保护', () => {
  it('把卡塞进自己里面会被拒绝', () => {
    expect(() => assertMovable(get, 'a', 'a')).toThrowError(/不能把卡片 a 移动到它自己里面/)
  })

  it('把卡塞进自己的后代里面会被拒绝', () => {
    expect(() => assertMovable(get, '001', 'a1')).toThrowError(/移动到它自己的后代 a1 里面/)
  })

  it('移动到无关的树是允许的', () => {
    expect(() => assertMovable(get, 'a', 'c_float')).not.toThrow()
    expect(() => assertMovable(get, 'a', null)).not.toThrow()
  })

  it('数据本身有环时遍历会报出来，而不是死循环', () => {
    const cyclic = [
      card('p', { parent: 'q', children: [{ id: 'q' }] }),
      card('q', { parent: 'p', children: [{ id: 'p' }] }),
    ]
    expect(() => ancestorsOf(lookupOf(cyclic), 'p')).toThrowError(/祖先链里出现了环/)
  })

  it('parent 指向不存在的卡时报出来', () => {
    const broken = [card('a', { parent: 'ghost' })]
    expect(() => ancestorsOf(lookupOf(broken), 'a')).toThrowError(/parent 指向 ghost，但那张卡不存在/)
  })
})
