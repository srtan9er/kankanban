/** CSS 由 esbuild 处理并单独产出 app.css，这里只是让 TypeScript 别抱怨副作用导入。 */
declare module '*.css' {
  const content: string
  export default content
}
