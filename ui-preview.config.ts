import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import pkg from './package.json'

export default defineConfig({
  root: resolve('src/renderer'),
  cacheDir: resolve('node_modules/.vite-ui-preview'),
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
  server: { host: '127.0.0.1', port: 5186, strictPort: true },
  optimizeDeps: { entries: ['ui-preview.html'] },
  build: {
    outDir: resolve('out/ui-preview'),
    rollupOptions: { input: resolve('src/renderer/ui-preview.html') }
  }
})
