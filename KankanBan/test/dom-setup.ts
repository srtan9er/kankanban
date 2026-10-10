/**
 * 给交互测试装配一个 DOM 环境。
 *
 * 只有**需要真事件**的测试要 import 它（放在文件最前面，ESM 会按顺序先求值它，
 * 这样 `react-dom/client` 加载时全局已经有了）。渲染断言用的
 * `react-dom/server` 不需要 DOM，所以那些测试不引这个文件。
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });

function install(key: string, value: unknown): void {
  // `navigator` 之类在 Node 里是只读的，直接赋值会抛；defineProperty 可控。
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}

const w = dom.window as unknown as Record<string, unknown>;

install('window', dom.window);
install('document', dom.window.document);
install('navigator', dom.window.navigator);
install('HTMLElement', w['HTMLElement']);
install('HTMLInputElement', w['HTMLInputElement']);
install('Element', w['Element']);
install('Node', w['Node']);
install('Event', w['Event']);
install('MouseEvent', w['MouseEvent']);
install('KeyboardEvent', w['KeyboardEvent']);
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
// 不设这个，React 的 act() 会刷一屏警告
install('IS_REACT_ACT_ENVIRONMENT', true);
