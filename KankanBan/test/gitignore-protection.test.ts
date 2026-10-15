import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {ensureGitignoreEntry} from '../src/core/storage/gitignore.ts';
test('an explicit later unignore cannot silently defeat the default .kkb protection',()=>{
 const fs=createMemoryFs();fs.ops.mkdirp('/repo');fs.ops.writeFile('/repo/.gitignore','build/\n.kkb/\n!.kkb/\n');
 ensureGitignoreEntry('/repo',fs.ops);assert.equal(fs.ops.readFile('/repo/.gitignore').trimEnd().split('\n').at(-1),'.kkb/');
 const saved=fs.ops.readFile('/repo/.gitignore');ensureGitignoreEntry('/repo',fs.ops);assert.equal(fs.ops.readFile('/repo/.gitignore'),saved);
});
