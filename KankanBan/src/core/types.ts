import type {InkDocument} from './drawing.ts';
import type {CardImage} from './card-images.ts';
import type {LayoutSizes} from './layout-sizes.ts';
export type {CardImage} from './card-images.ts';
/**
 * KankanBan 核心数据类型 —— 只含类型，不含运行时代码。
 *
 * 依据 ARCHITECTURE.md：
 *   §2.3  卡片字段与权威边界
 *   §2.4  ChildEntry（三种形态）
 *   §2.5  Layout 与呈现分派
 *   §4.1  事件结构
 *
 * 【本文件的硬约束】所有 .ts 都要能被 Node 直接 type-strip 执行，
 * 因此不能用 enum / namespace / 参数属性（tsconfig 的 `erasableSyntaxOnly` 会拦住）。
 */

export type CardId = string;

// ── §2.4 ChildEntry ────────────────────────────────────────────────────────────

/** 【顺序型】横列 / 数列 / tabs / 格子背包 / 列卡 / board 的列顺序 */
export type OrderedEntry = { id: CardId; order: number };

/** 【坐标型】二维无限平面（灵感台 002） */
export type PlaneEntry = {
  id: CardId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
};

/** 【无布局信息型】普通卡的子卡 */
export type PlainEntry = { id: CardId };

export type ChildEntry = OrderedEntry | PlaneEntry | PlainEntry;

// ── §2.3 卡片字段（cards/<id>.md 的 frontmatter） ──────────────────────────────

/** §2.5 `type` 指向的呈现定义卡上的字段 */
export type Layout = 'tabs' | 'columns' | 'ordered' | 'grid' | 'library' | 'plane' | 'plain';

export type CardFields = {
  id: CardId;
  /** 纯文本：窗口标题、紧凑卡正面、搜索 */
  title: string;
  /** Markdown 源码 */
  content: string;
  /** Workspace-local immutable image assets and their intrinsic metadata. */
  images?:CardImage[];
  /** Transparent, scroll-attached doodle layer owned by this card. */
  doodle?: InkDocument | null;
  /** 呈现定义卡的 id；null = 默认呈现 */
  type: CardId | null;
  /**
   * 呈现方式。内置卡由 §2.2 固定；普通卡默认 'plain'。
   *
   * 注意：§2.3 的字段表漏列了 `layout`，但 §2.2（内置卡表）、§2.4.1（layout → 条目形状）
   * 与 §2.5（分派规则第 2 步读它）都把它当落盘字段用，故此处按落盘字段建模。
   */
  layout: Layout;
  /** Non-default body/child-region dimensions, remembered separately per layout. */
  layoutSizes?:LayoutSizes;
  /** 预制体标记；仅 003 子树内为真 */
  isPrefab: boolean;
  /** 实例指向的预制体 id */
  prefabRef: CardId | null;
  /** 实例覆盖的字段名集合 */
  overrides: string[];
  /** Serialized subtree baseline for explicit prefab synchronization; absent in legacy files. */
  prefabBase?: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  /** 为后期同步预留，当前阶段不写入 */
  editingBy: string | null;
  /**
   * 软删除标记（§2.7）。**文件仍然留在 `cards/` 里**，靠这个字段让加载时不复活。
   *
   * 它只由 `card_delete` 与撤销写，**不能通过 `field_set` 改** —— 否则会出现
   * "卡没被删但子树已经被摘掉"这种无法自洽的半删除态。
   * §2.8 不变量 W 里的 `¬deleted` 就是它。
   */
  deleted: boolean;
};

// ── §4.1 事件 ──────────────────────────────────────────────────────────────────

export type Envelope = {
  actor?:import('./collaboration.ts').Actor;
  /** One user action may contain several ordinary events; undo treats it as a unit. */
  transactionId?: string;
  transactionSize?: number;
  id: string;
  /** 单调递增，用于 §4.2 一致性协议 */
  seq: number;
  clientId: string;
  timestamp: number;
  cardId: CardId;
  /**
   * 这条事件**之前** `cardId` 那张卡的 `updatedAt`（新卡则为 `undefined`）。
   *
   * 与 `from` / `fromIndex` / `removedEntry` 是同一类东西：§4.3 断言二要求
   * "撤掉一条事件必须能回到上一状态"，所以凡是这条事件改掉的旧状态，都得由它自己带上。
   * `updatedAt` 是派生的（= 指向这张卡的最后一条事件的时间，见 `state.ts`），
   * 但**派生**不代表撤销能推出来 —— `undoEvent` 只看状态与这一条事件、看不到日志。
   *
   * 旧日志没有这个字段：那时撤销会保持当前值（退化成修复前的行为），不报错。
   */
  prevUpdatedAt?: number | undefined;
};

/**
 * 字段路径是平铺的：`/title`、`/content`、`/layout`、`/prefabRef`。
 * `from` 是撤销的依据（§4.3 `undo(events) === 上一状态`）。
 */
export type FieldPath = `/${string}`;

export type CardEvent = Envelope &
  (
    | { type: 'field_set'; path: FieldPath; from: unknown; to: unknown }
    | { type: 'child_add'; parentId: CardId; entry: ChildEntry; index: number }
    | { type: 'child_remove'; parentId: CardId; entry: ChildEntry; index: number }
    /**
     * 改条目本身（顺序型改 `order`、坐标型改 x/y/w/h/z）。
     *
     * `from` 与 `entry` 成对出现，理由和 `field_set` 一样：撤销要能把旧顺序放回去。
     * 只带新条目的版本无法撤销一次重排序。
     */
    | { type: 'child_update'; parentId: CardId; entry: ChildEntry; from: ChildEntry; index: number }
    /**
     * 跨容器移动。记 `fromIndex` 与 `index` 两个下标是**必须**的：
     * `removedEntry.order` 只在顺序型父卡里能反推原位，`plain` / `plane` 父卡里
     * 原位无处可存，撤销就会把卡放错位置。
     *
     * **四个字段都可空**，因为"没有父卡"是一个合法状态（§2.8 不变量 W）：
     * 根卡拖进容器是 `fromParent === null`，子卡浮动到桌面是 `toParent === null`。
     * 非空版本表达不了这两件事，而它们正是 W 的两条。
     */
    | {
        type: 'card_move';
        cardId: CardId;
        fromParent: CardId | null;
        toParent: CardId | null;
        /** 在 fromParent.children 里的下标，撤销时放回这里（fromParent 为空则也为空） */
        fromIndex: number | null;
        /** 从旧父摘下的条目（旧形状） */
        removedEntry: ChildEntry | null;
        /** 按新父形状重建的条目 */
        addedEntry: ChildEntry | null;
        /** 在 toParent.children 里的插入下标（toParent 为空则也为空） */
        index: number | null;
      }
    | {
        type: 'card_create';
        cardId: CardId;
        parentId: CardId | null;
        entry: ChildEntry | null;
        fields: CardFields;
      }
    /** 软删除：携带整棵子树快照以支持撤销 */
    | {
        type: 'card_delete';
        cardId: CardId;
        parentId: CardId | null;
        /** 从旧父摘下的条目（根卡为 null） */
        removedEntry: ChildEntry | null;
        /**
         * 在旧父 children 里的下标（根卡为 null）。
         *
         * 与 `card_move.fromIndex` 同理：`plain` 父卡的子卡顺序**只由数组下标表达**
         * （`PlainEntry` 里没有 order），不记下标就无法把卡放回原位。
         */
        removedIndex: number | null;
        subtree: SubtreeSnapshot;
      }
    /**
     * 改一张卡的 `layout`（§2.4.1）。
     *
     * **必须连带重写它的子卡条目** —— 条目形状由父卡的 `layout` 决定，
     * 而加载时要按 `layout` 校验形状。只改字段不重写条目，下次打开工作区直接报数据损坏。
     *
     * `before` / `after` 都带全，是因为重写是**有损**的
     * （`plane → 其它` 会丢掉坐标），只靠新布局反推不回原样。
     */
    | {
        type: 'layout_change';
        cardId: CardId;
        from: Layout;
        to: Layout;
        /** 改之前的条目，撤销用 */
        before: ChildEntry[];
        /** 改之后的条目，应用用；形状必须与 `to` 相符 */
        after: ChildEntry[];
      }
  );

export type CardEventType = CardEvent['type'];

/** §2.7 软删除时随事件携带的整棵子树快照 */
export type SubtreeSnapshot = {
  /** 根节点自身的字段 */
  fields: CardFields;
  /** 该子树内所有卡片：id → 字段（含根自身） */
  cards: Record<CardId, CardFields>;
  /** 该子树内所有父子关系：父 id → 有序条目（不含根指向其父的那条） */
  children: Record<CardId, ChildEntry[]>;
};
