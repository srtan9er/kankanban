import {uiText} from '../i18n/text.ts';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Same exclusive directory lease as the desktop host; no two independent writers. */
export function acquireWorkspace(root: string): () => void {
  const data = join(resolve(root), '.kkb');
  mkdirSync(data, { recursive: true });
  const lock = join(data, 'writer.lock');
  const take = (): void => mkdirSync(lock);
  try { take(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid = NaN;
    try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch { /* incomplete lease remains protected */ }
    let alive = true;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    if (alive) throw new Error(uiText("node/workspace-lock.text001"));
    unlinkSync(join(lock, 'pid')); rmdirSync(lock); take();
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  let released = false;
  return () => {
    if (released) return; released = true;
    try { unlinkSync(join(lock, 'pid')); rmdirSync(lock); } catch { /* a lease error must not mask the original failure */ }
  };
}
