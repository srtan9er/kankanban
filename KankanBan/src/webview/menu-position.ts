/**
 * 右键菜单的定位与尺寸估算 —— 纯函数，因此能在命令行里测。
 *
 * 【为什么需要】菜单是绝对定位的，点在窗口右下角时会被裁到视口外 ——
 * 表现是"菜单出现了但够不到"。真正的做法是渲染后量一次真实尺寸再夹，
 * 但那要求先渲染再改位置（会闪一下），而菜单尺寸是可以从条目数直接估出来的。
 *
 * 代价是估算值必须与 CSS 对得上：`itemHeight` / `chrome` / `minWidth` 三个数
 * 与 `style.css` 里的 `.menu-item` / `.context-menu` 保持一致。
 * 对不上时最坏结果是"夹得偏了一点"，不会裁没 —— 可接受。
 */

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** 与 `.menu-item` 的 padding + 行高对得上（见 `style.css`）。 */
export const MENU_ITEM_HEIGHT = 26;
/** `.context-menu` 的上下 padding 之和。 */
export const MENU_CHROME_HEIGHT = 8;
/** `.context-menu` 的 `min-width`。 */
export const MENU_MIN_WIDTH = 136;

/** 按条目数估一下菜单多大。 */
export function estimateMenuSize(itemCount: number): Size {
  return {
    width: MENU_MIN_WIDTH,
    height: MENU_CHROME_HEIGHT + Math.max(itemCount, 1) * MENU_ITEM_HEIGHT,
  };
}

/**
 * 把菜单位置夹进视口。
 *
 * 默认让菜单出现在指针**右下方**（和所有桌面系统一致）；
 * 贴边时往回收，收到 0 为止 —— **保证整块菜单都在视口内**，不会出现够不到的条目。
 */
export function clampMenuPosition(pointer: Point, size: Size, viewport: Size): Point {
  const maxX = Math.max(0, viewport.width - size.width);
  const maxY = Math.max(0, viewport.height - size.height);

  return {
    x: Math.max(0, Math.min(pointer.x, maxX)),
    y: Math.max(0, Math.min(pointer.y, maxY)),
  };
}

/**
 * 浮层要不要往回收。
 *
 * 之所以单独一个函数：断言里需要区分"夹住了"和"本来就没超"，
 * 而不是只看最后坐标 —— 后者在"视口比菜单还小"时会给出 0 而看不出原因。
 */
export function isClamped(pointer: Point, size: Size, viewport: Size): boolean {
  const clamped = clampMenuPosition(pointer, size, viewport);
  return clamped.x !== pointer.x || clamped.y !== pointer.y;
}
