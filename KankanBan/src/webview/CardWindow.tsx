import {uiText} from '../i18n/text.ts';
/**
 * 一个窗口的界面 —— ARCHITECTURE.md §3.1 的三区域、§3.2 的两种形态、§3.3 的手势。
 *
 * **纯展示组件**：所有模型判断（渲染分派、正文可见性、折叠、跨层投影、子卡区排布）
 * 都已经在 `viewOf` 里做完了，这里只负责把 `CardView` 摊成 DOM，
 * 以及把用户动作翻译成回调。连"正在编辑哪个字段"都是外部传进来的（`editing`），
 * 组件自己不持有状态 —— 这样交互断言能一路验到 core。
 */

import type { CSSProperties, JSX } from 'react';

import type { CardView, ColumnProjection, RenderedChild } from '../core/view-model.ts';
import type { Region } from '../core/view-state.ts';
import {
  ContextMenu,
  DeleteConfirm,
  type ContextMenuState,
  type PendingDelete,
} from './ContextMenu.tsx';

/** 正在编辑的目标：哪张卡的哪个字段。 */
export type EditTarget = { cardId: string; field: 'title' | 'content' };

export type CardWindowProps = {
  model: CardView;
  /** 双击子卡 / 点面包屑 → 改变聚焦（§3.3 / §3.4） */
  onFocus: (cardId: string) => void;
  /** 拖拽子卡落到第 index 位 */
  onDropChild: (cardId: string, index: number) => void;
  /** 右键：请求在 (x, y) 处为这张卡开菜单（§3.3 右键菜单） */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  menu: ContextMenuState | null;
  onMenuPick: (itemId: string) => void;
  onDismissMenu: () => void;
  /** §2.7：删除前必须显示张数并要求确认 */
  pendingDelete: PendingDelete | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  editing: EditTarget | null;
  /** §3.3「单击编辑」 */
  onBeginEdit: (target: EditTarget) => void;
  onCommitEdit: (target: EditTarget, value: string) => void;
  onCancelEdit: () => void;
  draggingId: string | null;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
};

function regionStyle(model: CardView, region: Region): CSSProperties {
  const state = model.regions[region];
  if (state.collapsed) return { display: 'none' };
  return { flex: region === 'content' ? 1 : `0 0 ${state.size}px` };
}

/** 内联编辑框。用非受控 + defaultValue：编辑期间不该被外部重渲染打断光标。 */
function InlineEditor(props: {
  className: string;
  value: string;
  multiline: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const commit = (element: HTMLInputElement | HTMLTextAreaElement): void => {
    props.onCommit(element.value);
  };

  const onKeyDown = (event: { key: string; currentTarget: HTMLInputElement | HTMLTextAreaElement; preventDefault: () => void }): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onCancel();
      return;
    }
    // 多行编辑里 Enter 是换行，Ctrl/Cmd+Enter 才提交
    const wantsCommit = event.key === 'Enter' && (!props.multiline || (event as unknown as { ctrlKey?: boolean }).ctrlKey === true);
    if (wantsCommit) {
      event.preventDefault();
      commit(event.currentTarget);
    }
  };

  return props.multiline
    ? (
      <textarea
        className={props.className}
        defaultValue={props.value}
        autoFocus
        onKeyDown={onKeyDown}
        onBlur={(event) => commit(event.currentTarget)}
      />
    )
    : (
      <input
        className={props.className}
        defaultValue={props.value}
        autoFocus
        onKeyDown={onKeyDown}
        onBlur={(event) => commit(event.currentTarget)}
      />
    );
}

/**
 * 二维无限平面（§3.1「二维无限」、§2.2 inspiration）。
 *
 * 位置直接取 `PlaneEntry` 的 x/y/w/h —— 那些坐标是**数据**（§2.3：布局坐标进 `tree.json`），
 * 不是视图状态，所以这里只负责照着摆。
 *
 * `z` 交给 CSS 的 `zIndex`，渲染顺序不做处理：`z` 的语义本来就是绘制层级。
 */
function PlaneArea(props: {
  model: CardView;
  renderChild: (child: RenderedChild, index: number) => JSX.Element;
}): JSX.Element {
  const { model, renderChild } = props;

  return (
    <div className="child-plane">
      {model.children.map((child, index) => {
        const entry = child.entry;
        // 条目形状由父卡 layout 决定（§2.4），plane 父卡下必然是坐标型；真不是就按横排退化。
        if (!('x' in entry)) return renderChild(child, index);

        return (
          <div
            key={child.id}
            className="plane-slot"
            style={{ left: entry.x, top: entry.y, width: entry.w, height: entry.h, zIndex: entry.z }}
          >
            {renderChild(child, index)}
          </div>
        );
      })}
    </div>
  );
}

export function CardWindow(props: CardWindowProps): JSX.Element {
  const {
    model,
    onFocus,
    onDropChild,
    onContextMenu,
    menu,
    onMenuPick,
    onDismissMenu,
    pendingDelete,
    onConfirmDelete,
    onCancelDelete,
    editing,
    onBeginEdit,
    onCommitEdit,
    onCancelEdit,
    draggingId,
    onDragStart,
    onDragEnd,
  } = props;

  const editingTitleOf = (cardId: string): boolean =>
    editing !== null && editing.cardId === cardId && editing.field === 'title';

  const renderChild = (child: RenderedChild, index: number): JSX.Element => {
    const editingThis = editingTitleOf(child.id);

    return (
      <div
        key={child.id}
        // §3.6：预制体内部发蓝光、实例外圈发蓝光 —— 由 viewOf 算好的 glow 决定
        className={[
          'compact-card',
          child.glow === 'prefab' ? 'glow-prefab' : '',
          child.glow === 'instance' ? 'glow-instance' : '',
          draggingId === child.id ? 'dragging' : '',
          editingThis ? 'editing' : '',
        ]
          .filter((part) => part !== '')
          .join(' ')}
        data-glow={child.glow ?? 'none'}
        // 编辑时不许拖：否则选字会变成拖放
        draggable={!editingThis}
        onDragStart={() => onDragStart(child.id)}
        onDragEnd={onDragEnd}
        // §3.3 单击编辑。双击时第一次单击会先进编辑态，随后 dblclick 把它换成下钻 ——
        // 所以不需要"等 250ms 看有没有第二次点击"那种计时器。
        onClick={() => {
          if (!editingThis) onBeginEdit({ cardId: child.id, field: 'title' });
        }}
        onDoubleClick={() => onFocus(child.id)}
        // 右键落在这张卡上 → 菜单针对它（§3.3）。stopPropagation 免得窗口那一层也开一次。
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(child.id, event.clientX, event.clientY);
        }}
        title={child.hasChildren ? uiText("webview/CardWindow.text001") : uiText("webview/CardWindow.text002")}
      >
        {editingThis
          ? (
            <InlineEditor
              className="title-input"
              value={child.title}
              multiline={false}
              onCommit={(value) => onCommitEdit({ cardId: child.id, field: 'title' }, value)}
              onCancel={onCancelEdit}
            />
          )
          : <span className="compact-title">{child.title}</span>}
        {child.hasChildren ? <span className="compact-more">▸</span> : null}
        {/* 落区：把拖来的卡插到这一位 */ }
        <div
          className="drop-slot"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            // 没有正在拖的卡就什么都不做。
            // 早先写成 `draggingId ?? child.id`，会在"空放"时把这张卡移到自己身上 ——
            // 结果虽然是个无变化的移动，却照样**产生一条事件**（日志噪音 + 多一步撤销）。
            if (draggingId === null) return;
            onDropChild(draggingId, index);
          }}
        />
      </div>
    );
  };

  const renderColumn = (column: ColumnProjection): JSX.Element => (
    <div className="board-column" key={column.columnId}>
      {/* §2.5.1：列头就是列卡的标题；列卡自己的正文在本视图里不渲染 */}
      <div className="column-header" onDoubleClick={() => onFocus(column.columnId)}>
        {column.header}
      </div>
      <div className="column-body">{column.cards.map((card, index) => renderChild(card, index))}</div>
    </div>
  );

  const editingContent = editing !== null && editing.cardId === model.id && editing.field === 'content';

  return (
    <div
      className={[
        'card-window',
        model.glow === 'prefab' ? 'glow-prefab' : '',
        model.glow === 'instance' ? 'glow-instance' : '',
      ]
        .filter((part) => part !== '')
        .join(' ')}
      data-glow={model.glow ?? 'none'}
      onContextMenu={(event) => {
        event.preventDefault();
        // 落在空白处 → 菜单针对**当前聚焦的卡**
        onContextMenu(model.id, event.clientX, event.clientY);
      }}
    >
      {/* 面包屑是这扇窗口的"标题栏"：卡片窗口无边框（decorations(false)），
          拖动只能靠 Tauri 的标准 drag region。它给的是**按住空白处**拖动 ——
          落在面包屑上的条目仍然是"点它下钻"。参考项目那套自定义拖动 / 吸附 / 调整大小
          还没搬过来（它需要 drag_note 一类的命令 + 边缘手柄）。 */}
      <nav className="region breadcrumb" data-tauri-drag-region style={regionStyle(model, 'breadcrumb')}>
        {model.breadcrumb.map((crumb, index) => {
          const isCurrent = crumb.id === model.focusId;
          const editingThis = editingTitleOf(crumb.id);
          return (
            <span key={crumb.id}>
              {index > 0 ? <span className="crumb-sep">/</span> : null}
              {editingThis
                ? (
                  <InlineEditor
                    className="crumb-input"
                    value={crumb.title}
                    multiline={false}
                    onCommit={(value) => onCommitEdit({ cardId: crumb.id, field: 'title' }, value)}
                    onCancel={onCancelEdit}
                  />
                )
                : (
                  <button
                    type="button"
                    className={`crumb${isCurrent ? ' current' : ''}`}
                    // 点当前那一层 = 改这张卡的标题（§3.3 单击编辑）；其余层 = 聚焦过去
                    onClick={() => {
                      if (isCurrent) onBeginEdit({ cardId: crumb.id, field: 'title' });
                      else onFocus(crumb.id);
                    }}
                  >
                    {crumb.title}
                  </button>
                )}
            </span>
          );
        })}
      </nav>

      {/* §3.1：board 与 inspiration 不显示正文 */}
      <section className="region content" style={regionStyle(model, 'content')} hidden={!model.contentShown}>
        {!model.contentShown ? null : editingContent
          ? (
            <InlineEditor
              className="content-input"
              value={model.content}
              multiline
              onCommit={(value) => onCommitEdit({ cardId: model.id, field: 'content' }, value)}
              onCancel={onCancelEdit}
            />
          )
          : (
            <pre
              className="content-body"
              onClick={() => onBeginEdit({ cardId: model.id, field: 'content' })}
            >
              {model.content === '' ? uiText("webview/CardWindow.text003") : model.content}
            </pre>
          )}
      </section>

      <section className="region children" style={regionStyle(model, 'children')}>
        {model.columns !== null
          ? <div className="board">{model.columns.map(renderColumn)}</div>
          : model.childrenMode === 'plane'
            ? <PlaneArea model={model} renderChild={renderChild} />
            : (
              <div className={model.childrenMode === 'grid' ? 'child-grid' : 'child-row'}>
                {model.children.map((child, index) => renderChild(child, index))}
                <div
                  className="drop-slot tail"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingId === null) return;
                    onDropChild(draggingId, model.children.length);
                  }}
                >
                  <span className="hint">{model.childrenMode === 'grid' ? '＋' : uiText("webview/CardWindow.text004")}</span>
                </div>
              </div>
            )}
      </section>

      {/* 浮层：菜单与删除确认（§3.3 / §2.7） */}
      {menu !== null ? <ContextMenu menu={menu} onPick={onMenuPick} onDismiss={onDismissMenu} /> : null}
      {pendingDelete !== null
        ? <DeleteConfirm pending={pendingDelete} onConfirm={onConfirmDelete} onCancel={onCancelDelete} />
        : null}
    </div>
  );
}
