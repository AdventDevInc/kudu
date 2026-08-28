import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import pkg from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'yara-worker': resolve(__dirname, 'src/main/workers/yara-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        // The renderer's hardcoded CSP (script-src 'self') blocks Vite's
        // inline HMR injection in dev → blank window. Strip the meta tag
        // when serving dev only; the production HTML keeps the strict CSP.
        name: 'kudu-strip-csp-in-dev',
        apply: 'serve',
        transformIndexHtml(html: string): string {
          return html.replace(
            /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i,
            ''
          )
        }
      }
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
