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
})
