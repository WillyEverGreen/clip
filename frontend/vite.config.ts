import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy API calls to local Wrangler dev server during development
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      // Short CLI routes served by worker
      '/r':   { target: 'http://localhost:8787', changeOrigin: true },
      '/z':   { target: 'http://localhost:8787', changeOrigin: true },
      '/f':   { target: 'http://localhost:8787', changeOrigin: true },
      // Long-form routes
      '/raw':  { target: 'http://localhost:8787', changeOrigin: true },
      '/zip':  { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Core React runtime — always needed, safe to split
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor'
          }
          // Router — safe to split, no global side effects
          if (id.includes('node_modules/react-router')) {
            return 'router-vendor'
          }
          // Lucide icons — safe to split, no global side effects
          if (id.includes('node_modules/lucide-react')) {
            return 'icons-vendor'
          }
          // QR Code — safe to split, only used behind showQrModal gate
          if (id.includes('node_modules/qrcode')) {
            return 'qrcode-vendor'
          }
          // ⚠️  DO NOT split prismjs, katex, marked, or dompurify.
          // Prism language grammar files (prism-clike, prism-c, etc.) mutate
          // Prism.languages at module evaluation time. If the base prismjs chunk
          // and the grammar chunks load in parallel, Prism is not yet defined
          // when the grammars run → ReferenceError: Prism is not defined.
          // These libraries stay co-bundled with MarkdownRenderer (lazy chunk),
          // which guarantees correct initialization order.
        },
      },
    },
  },
})

