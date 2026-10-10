/** Vite 处理 CSS 导入，TypeScript 需要被告知这一点。 */
declare module '*.css' {
  const content: string;
  export default content;
}
