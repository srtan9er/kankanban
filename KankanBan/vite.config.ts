import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), {
    name: 'kkb-development-identity',
    configureServer(server) {
      server.middlewares.use('/__kkb_dev', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({root:fileURLToPath(new URL('.',import.meta.url))}));
      });
    },
  }],
  // Tauri 自己管终端输出，别让 vite 清屏
  clearScreen: false,
  build: {
    outDir: 'dist',
    // 与 tsconfig 的 target 对齐：webview 是常青浏览器，不需要降级
    target: 'esnext',
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
    // src-tauri 里的东西不归 vite 管，看着它只会白跑
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
});
