import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drafts } from '../src/webview/drafts.ts';

test('an old acknowledgement cannot discard newer text; failed drafts remain retryable', async () => {
  const calls: { value: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const drafts = new Drafts((_, value) => new Promise<void>((resolve, reject) => calls.push({ value, resolve, reject })));
  drafts.set('content', 'first'); const first = drafts.flush();
  drafts.set('content','newer');
  const failure=assert.rejects(first,/disk/);
  calls[0]!.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(drafts.has('content'),true);
  assert.equal(calls[1]!.value,'newer');calls[1]!.reject(new Error('disk'));await failure;
  assert.equal(drafts.has('content'), true);
  const retry = drafts.flush(); assert.equal(calls[2]!.value, 'newer'); calls[2]!.resolve(); await retry;
  assert.equal(drafts.has('content'), false);
});
