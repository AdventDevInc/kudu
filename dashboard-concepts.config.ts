import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5185, strictPort: true },
  optimizeDeps: { entries: ['dashboard-concepts.html'] },
  build: {
    outDir: resolve('out/dashboard-concepts'),
    rollupOptions: { input: resolve('src/renderer/dashboard-concepts.html') }
  }
})
