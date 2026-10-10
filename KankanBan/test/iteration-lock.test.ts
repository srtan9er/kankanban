import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkspace } from '../src/node/workspace-lock.ts';

test('workspace lease rejects another writer and can be reacquired after release', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-lease-test-'));
  try {
    const release = acquireWorkspace(root);
    try { assert.throws(() => acquireWorkspace(root), /另一个/); } finally { release(); release(); }
    acquireWorkspace(root)();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
