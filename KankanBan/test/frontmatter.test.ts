import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCard, serializeCard } from '../src/core/storage/frontmatter.ts';
import type { CardFields } from '../src/core/types.ts';

function card(over: Partial<CardFields> = {}): CardFields {
  return {
    id: 'c1',
    title: '标题',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    prefabBase: null,
    doodle: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
    editingBy: null,
    deleted: false,
    ...over,
  };
}

test('serialize → parse 往返无损', () => {
  const original = card({ content: '# 正文\n\n- 一\n- 二\n' });

  const back = parseCard(serializeCard(original));

  assert.deepEqual(back, original);
});

test('标题里的冒号 / 引号 / 换行 / 反斜杠都不破坏解析', () => {
  const nasty = card({
    title: '他说: "你好"\n第二行\\结尾',
    content: 'body',
  });

  const back = parseCard(serializeCard(nasty));

  assert.equal(back.title, nasty.title);
});

test('正文里出现 --- 不会被误当作 frontmatter 结束', () => {
  const original = card({ content: '上面\n---\n下面\n' });

  const back = parseCard(serializeCard(original));

  assert.equal(back.content, original.content);
});

test('非空字段逐个往返正确', () => {
  const original = card({
    type: 'tpl-a',
    layout: 'plane',
    isPrefab: true,
    prefabRef: 'pf-1',
    overrides: ['title', 'content'],
    createdAt: 1710000000000,
    updatedAt: 1710000001000,
    createdBy: 'jiajie',
    editingBy: null,
  });

  const back = parseCard(serializeCard(original));

  assert.deepEqual(back, original);
});

test('没有 frontmatter 的文本直接抛错', () => {
  assert.throws(() => parseCard('就是一段正文，没有分隔符'), /frontmatter/);
});

test('frontmatter 里出现未知字段时抛错，而不是静默丢弃', () => {
  const text = '---\nid: "c1"\ntitle: "t"\n不认识的字段: 1\n---\n';

  assert.throws(() => parseCard(text), /未知字段/);
});

test('frontmatter 缺少必填字段时抛错，并指出是哪个', () => {
  const text = '---\nid: "c1"\n---\n';

  assert.throws(() => parseCard(text), /title/);
});

test('字段类型不对时抛错（layout 必须是合法值）', () => {
  // 用完整文件改写 layout，避免"缺别的字段"先一步抛错，掩盖了本测试要查的东西。
  const text = serializeCard(card()).replace('layout: "plain"', 'layout: "spiral"');

  assert.throws(() => parseCard(text), /layout/);
});
