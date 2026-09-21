import { describe, expect, it } from 'vitest'
import { parseCard, serializeCard } from '../src/index.ts'
import type { Card } from '../src/index.ts'

/**
 * 卡片文件格式的 golden test。
 *
 * 这个测试存在的理由是 git：文件格式一旦不稳定，每次保存都会产生噪声 diff，
 * 人看不出改了什么，AI 也会被噪声误导。改动格式就必须在这里同步改。
 */

const SAMPLE: Card = {
  id: 'c_0001',
  parent: '001',
  children: [{ id: 'c_0002' }, { id: 'c_0003', layout: { x: 120, y: 40, w: 200, h: 160, z: 3 } }],
  title: '主角待机动画',
  content: '# 说明\n\n待机动作要松弛。',
  view: 'row',
  scope: 'public',
  color: '#4A90D9',
  due: '2025-06-01',
  tags: ['art', 'character'],
  createdAt: 1748000000000,
  updatedAt: 1748000000100,
  createdBy: 'local',
}

const EXPECTED = `---
id: c_0001
parent: "001"
children:
  - id: c_0002
  - id: c_0003
    layout:
      x: 120
      y: 40
      w: 200
      h: 160
      z: 3
title: 主角待机动画
view: row
scope: public
color: "#4A90D9"
due: 2025-06-01
tags:
  - art
  - character
createdAt: 1748000000000
updatedAt: 1748000000100
createdBy: local
---

# 说明

待机动作要松弛。
`

describe('卡片文件格式', () => {
  it('序列化结果逐字节稳定', () => {
    expect(serializeCard(SAMPLE)).toBe(EXPECTED)
  })

  it('键顺序固定，与字段赋值顺序无关', () => {
    const shuffled: Card = {
      createdBy: 'local',
      updatedAt: 1748000000100,
      createdAt: 1748000000000,
      tags: ['art', 'character'],
      due: '2025-06-01',
      color: '#4A90D9',
      scope: 'public',
      view: 'row',
      content: '# 说明\n\n待机动作要松弛。',
      title: '主角待机动画',
      children: [{ id: 'c_0002' }, { id: 'c_0003', layout: { x: 120, y: 40, w: 200, h: 160, z: 3 } }],
      parent: '001',
      id: 'c_0001',
    }
    expect(serializeCard(shuffled)).toBe(EXPECTED)
  })

  it('往返一圈内容不变', () => {
    expect(parseCard(serializeCard(SAMPLE), { expectedId: 'c_0001' })).toEqual(SAMPLE)
  })

  it('连写两次结果完全一样（幂等）', () => {
    const once = serializeCard(SAMPLE)
    const twice = serializeCard(parseCard(once, { expectedId: 'c_0001' }))
    expect(twice).toBe(once)
  })

  it('可选字段留空时不写进文件', () => {
    const bare: Card = {
      id: 'c_0009',
      parent: null,
      children: [],
      title: '光秃秃的卡',
      content: '',
      scope: 'private',
      createdAt: 1,
      updatedAt: 2,
      createdBy: 'local',
    }
    expect(serializeCard(bare)).toBe(`---
id: c_0009
parent: null
children: []
title: 光秃秃的卡
scope: private
createdAt: 1
updatedAt: 2
createdBy: local
---
`)
  })

  it('正文为空时不留空行', () => {
    const text = serializeCard({ ...SAMPLE, content: '', tags: undefined, due: undefined })
    expect(text.endsWith('createdBy: local\n---\n')).toBe(true)
    expect(text).not.toContain('---\n\n')
  })

  it('CRLF 会被规范化成 LF', () => {
    const text = serializeCard({ ...SAMPLE, content: '第一行\r\n第二行\r\n' })
    expect(text).toContain('---\n\n第一行\n第二行\n')
    expect(text).not.toContain('\r')
  })

  it('看起来像日期的标题仍然是字符串，不会被 YAML 吃成时间对象', () => {
    const text = serializeCard({ ...SAMPLE, title: '2025-06-01', content: '', tags: undefined, due: undefined })
    const back = parseCard(text, { expectedId: 'c_0001' })
    expect(back.title).toBe('2025-06-01')
    expect(typeof back.title).toBe('string')
  })

  it('due 读回来仍然是字符串', () => {
    const back = parseCard(serializeCard(SAMPLE), { expectedId: 'c_0001' })
    expect(typeof back.due).toBe('string')
    expect(back.due).toBe('2025-06-01')
  })
})

describe('卡片文件校验', () => {
  const good = serializeCard(SAMPLE)

  it('不以 frontmatter 开头会报错并说清原因', () => {
    expect(() => parseCard('# 就是一段 markdown', { source: 'x.md' })).toThrowError(/没有以 YAML frontmatter 开头/)
  })

  it('frontmatter 没闭合会报错', () => {
    expect(() => parseCard('---\nid: c_1\ntitle: 哈\n', { source: 'x.md' })).toThrowError(/没有闭合/)
  })

  it('id 和文件名不一致会报错，并且两个值都报出来', () => {
    expect(() => parseCard(good, { expectedId: 'c_9999', source: 'x.md' })).toThrowError(
      /字段 id 是 "c_0001"，但文件名是 "c_9999"/,
    )
  })

  it('scope 只能是 private / public', () => {
    const bad = good.replace('scope: public', 'scope: 公开')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/scope 只能是 "private" 或 "public"/)
  })

  it('view 只能是六个合法值之一', () => {
    const bad = good.replace('view: row', 'view: 瀑布流')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/view 只能是 main \/ kanban \/ row \/ column \/ grid \/ plane/)
  })

  it('children 必须是列表', () => {
    const bad = good.replace('children:\n  - id: c_0002\n  - id: c_0003\n    layout:\n      x: 120\n      y: 40\n      w: 200\n      h: 160\n      z: 3', 'children: 三个')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/children 应该是列表/)
  })

  it('layout 缺字段会报出具体缺哪个', () => {
    const bad = good.replace('      z: 3\n', '')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/children\[1\]\.layout\.z/)
  })

  it('tags 里混进非字符串会报出下标', () => {
    const bad = good.replace('tags:\n  - art\n  - character', 'tags:\n  - art\n  - 3')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/tags\[1\]/)
  })

  it('缺少必填字段会报出字段名', () => {
    const bad = good.replace('title: 主角待机动画\n', '')
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/字段 title 应该是字符串/)
  })

  it('坏 YAML 报错时带上原始原因', () => {
    const bad = '---\nid: c_1\n  title: 缩进错了\n---\n'
    expect(() => parseCard(bad, { source: 'x.md' })).toThrowError(/不是合法的 YAML/)
  })
})
