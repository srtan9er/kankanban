import {connectThemeRuntime,themeRuntime} from '../themes/runtime.ts';
import {cardIdFromLabel,windowIdFromLabel} from '../core/window-identity.ts';
import {isSkin} from '../core/skins.ts';
import {uiText} from '../i18n/text.ts';
import { normalizeBoards } from '../core/boards.ts';
import { createRoot } from 'react-dom/client';
import { openSession } from '../core/workspace.ts';
import { readViewState } from '../core/view-state.ts';
import { createBufferedFs } from '../platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../platform/memory-fs-ops.ts';
import { hydrate, toAsync, type AsyncFsOps } from '../platform/async-fs-ops.ts';
import { createTauriBackend, currentWindowLabel, isTauri, workspaceRoot } from './tauri-backend.ts';
import { WorkspaceController } from './controller.ts';
import { WorkspaceApp } from './WorkspaceApp.tsx';
import { connectDesktop } from './desktop.ts';
import { invoke } from '@tauri-apps/api/core';
import {tutorialAssetInputs} from '../tutorial/assets.ts';
import './platte.css';
import './prototype.css';
import './workspace.css';
import '../themes/defaults.css';

// Prevent the webview's native context menu, including on editable controls.
if(!document.documentElement.dataset.contextMenuDisabled){
 document.documentElement.dataset.contextMenuDisabled='true';
 document.addEventListener('contextmenu',event=>event.preventDefault(),true);
}

try {const cached=localStorage.getItem('kkb-theme');if(isSkin(cached))document.documentElement.dataset.theme=cached;} catch { /* optional paint cache */ }

async function boot(): Promise<void> {
  document.title=uiText('app.title');
  document.documentElement.lang='zh-CN';
  document.documentElement.style.setProperty('--empty-card-text',JSON.stringify(uiText('app.emptyContent')));
  const mount = document.getElementById('root')!;
  const native = isTauri();
  const label = currentWindowLabel() ?? 'main';
  const mirror = windowIdFromLabel(label)!==null;
  document.documentElement.dataset.windowKind=mirror ? 'card' : 'manager';
  const buffer = createBufferedFs();
  let backend: AsyncFsOps;
  let root = '/preview';
  const disk = createMemoryFs();
  if (native) {
    root = await workspaceRoot();
    backend = createTauriBackend();
    if (!mirror) {
      await hydrate(buffer.memory, backend, `${root}/.kkb`);
      if (await backend.exists(`${root}/.gitignore`)) {
        buffer.memory.ops.mkdirp(root);
        buffer.memory.poke(`${root}/.gitignore`, await backend.readFile(`${root}/.gitignore`));
      }
    }
  } else {
    try {
      const stored = JSON.parse(localStorage.getItem('kkb-preview-data') ?? '{}') as Record<string,string>;
      for (const [path, value] of Object.entries(stored)) {
        if (!path.startsWith('/preview/') || typeof value !== 'string') continue;
        disk.ops.mkdirp(path.slice(0, path.lastIndexOf('/')));
        disk.ops.writeFile(path, value);
      }
    } catch { /* Preview can always start fresh. */ }
    backend = toAsync(disk.ops);
    await hydrate(buffer.memory, backend, `${root}/.kkb`);
  }
  const newWorkspace=!mirror && !buffer.ops.exists(`${root}/.kkb/tree.json`) && !buffer.ops.exists(`${root}/.kkb/events.jsonl`);
  const session = openSession(root, { ops: mirror ? createMemoryFs().ops : buffer.ops, clientId: 'ui', builtins: !mirror });
  const controller = new WorkspaceController(session, readViewState(root, buffer.ops), buffer, backend);
  if(native)controller.prepareTutorialAssets=async()=>{await invoke('import_image_assets',{inputs:tutorialAssetInputs()});};
  if (!mirror) {
    normalizeBoards(session);
    if(newWorkspace)await controller.execute({kind:'tutorial'});
    else await controller.flush();
  }
  connectThemeRuntime(error=>{controller.error=String(error);controller.accept(controller.snapshot());});
  const applyTheme=()=>{void themeRuntime.set(controller.view.theme ?? '',controller.view.skin ?? 'light').catch(error=>{controller.error=String(error);});};
  applyTheme();controller.subscribe(applyTheme);
  let desktop: Awaited<ReturnType<typeof connectDesktop>> | undefined;
  if (native) desktop = await connectDesktop(controller, label);
  else controller.subscribe(() => { if (!controller.busy && !controller.error) {
    try { localStorage.setItem('kkb-preview-data', JSON.stringify(disk.snapshot())); } catch { /* browser quota, never desktop data */ }
  } });
  createRoot(mount).render(<WorkspaceApp controller={controller} {...(mirror ? { cardId: cardIdFromLabel(label)!, windowId:windowIdFromLabel(label)! } : {})}
    {...(desktop ? { request: desktop.request, startDrag: desktop.startDrag, close: desktop.close, switchWorkspace: desktop.switchWorkspace } : {})}
    />);
  if (desktop && !mirror) await desktop.restore();
}
void boot().catch(error => {
  const mount = document.getElementById('root')!;
  mount.replaceChildren();
  const title = document.createElement('h2'); title.textContent = uiText("webview/main.text001");
  const detail = document.createElement('p'); detail.textContent = String(error);
  const retry = document.createElement('button'); retry.textContent = uiText("webview/main.text002"); retry.onclick = () => location.reload();
  mount.style.cssText = 'padding:24px;overflow:auto'; mount.append(title, detail, retry);
});
