import { defineConfig, loadEnv } from 'vite'
import posthog from '@posthog/rollup-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { themeInitScript } from '@cqu-moe/theme'

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const uploadMaps = Boolean(env.POSTHOG_CLI_API_KEY)
  if (uploadMaps && env.POSTHOG_CLI_PROJECT_ID !== '662666') throw new Error('Auth source maps must target PostHog project 662666')
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'theme-init',
        transformIndexHtml: () => [
          { tag: 'script', children: themeInitScript, injectTo: 'head-prepend' },
        ],
      },
      ...(uploadMaps ? [posthog({
        personalApiKey: env.POSTHOG_CLI_API_KEY!,
        projectId: env.POSTHOG_CLI_PROJECT_ID,
        host: 'https://us.posthog.com',
        sourcemaps: {
          releaseName: 'auth-web',
          releaseVersion: env.VITE_RELEASE,
          releaseMode: 'symbol-set',
          deleteAfterUpload: true,
        },
      })] : []),
    ],
    build: { sourcemap: uploadMaps ? 'hidden' : false },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:8787', ws: true },
      },
    },
  }
})
