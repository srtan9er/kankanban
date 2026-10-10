import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-backend.ts';
export async function openLink(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri()) await invoke('open_link', { url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}
