import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { themeInitScript } from '@cqu-moe/theme'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'theme-init',
      transformIndexHtml: () => [
        { tag: 'script', children: themeInitScript, injectTo: 'head-prepend' },
      ],
    },
  ],
  build: { sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
})
