import {uiText} from '../i18n/text.ts';
/**
 * 右键菜单与删除确认 —— ARCHITECTURE.md §3.3（右键菜单）、§3.5（创建）、§2.7（删除）。
 *
 * **纯展示**：不知道菜单从哪来、点了之后会怎样，只把条目渲染出来并把点击转成回调。
 * 位置由外部算好传进来（省掉组件里不必要的状态）。
 */

import type { JSX } from 'react';

export type MenuItem = {
  id: string;
  label: string;
  /** 危险动作（删除）—— 视觉上分开，免得手滑 */
  danger?: boolean;
  /** 当前正在用的那一项（呈现方式里标出来） */
  active?: boolean;
  /** 分组标题：不可点，只用来分段 */
  heading?: boolean;
};

export type ContextMenuState = {
  cardId: string;
  /** 屏幕上出现的位置（CSS 像素） */
  x: number;
  y: number;
  items: MenuItem[];
};

export type PendingDelete = { cardId: string; count: number; title: string };

export type ContextMenuProps = {
  menu: ContextMenuState;
  onPick: (itemId: string) => void;
  onDismiss: () => void;
};

export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const { menu, onPick, onDismiss } = props;

  return (
    <div className="menu-layer" onClick={onDismiss} onContextMenu={(event) => event.preventDefault()}>
      <ul
        className="context-menu"
        style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        // 点菜单本体不该把它关掉（关掉就走不到 onPick 了）
        onClick={(event) => event.stopPropagation()}
      >
        {menu.items.map((item) =>
          item.heading === true
            ? (
              <li key={item.id} className="menu-heading">
                {item.label}
              </li>
            )
            : (
              <li key={item.id}>
                <button
                  type="button"
                  className={[
                    'menu-item',
                    item.danger === true ? 'danger' : '',
                    item.active === true ? 'active' : '',
                  ]
                    .filter((part) => part !== '')
                    .join(' ')}
                  onClick={() => onPick(item.id)}
                >
                  {/* 用字符而不是图标：不引图标库，也不怕字体缺失 */}
                  <span className="menu-check">{item.active === true ? '✓' : ''}</span>
                  {item.label}
                </button>
              </li>
            ),
        )}
      </ul>
    </div>
  );
}

export type DeleteConfirmProps = {
  pending: PendingDelete;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * 删除确认 —— §2.7 要求"显示将删除的卡片数并要求确认"。
 *
 * 用应用内面板而不是 `window.confirm`：桌面 webview 对原生对话框的支持不一致，
 * 而且应用内面板才能被交互断言覆盖。
 */
export function DeleteConfirm(props: DeleteConfirmProps): JSX.Element {
  const { pending, onConfirm, onCancel } = props;

  return (
    <div className="menu-layer">
      <div className="confirm-box">
        <p className="confirm-title">{uiText("webview/ContextMenu.text001")}{pending.title}」</p>
        <p className="confirm-count">
          {uiText("webview/ContextMenu.text002")}<strong>{pending.count}</strong> {uiText("webview/ContextMenu.text003")}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-ok" onClick={onConfirm}>
            {uiText("webview/ContextMenu.text004")}</button>
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            {uiText("webview/ContextMenu.text005")}</button>
        </div>
      </div>
    </div>
  );
}
