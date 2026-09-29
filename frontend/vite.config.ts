import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import posthog from '@posthog/rollup-plugin'
import { themeInitScript } from '@cqu-moe/theme'

const sourceMapUpload = process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID
  ? posthog({
      personalApiKey: process.env.POSTHOG_CLI_API_KEY,
      projectId: process.env.POSTHOG_CLI_PROJECT_ID,
      host: process.env.POSTHOG_CLI_HOST || 'https://us.posthog.com',
      sourcemaps: {
        enabled: true,
        releaseName: 'auth-web',
        releaseVersion: process.env.VITE_RELEASE || 'development',
        deleteAfterUpload: true,
      },
    })
  : null

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
    ...(sourceMapUpload ? [sourceMapUpload] : []),
  ],
  build: { sourcemap: Boolean(sourceMapUpload) },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
})
