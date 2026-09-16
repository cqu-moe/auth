import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PostHogErrorBoundary, PostHogProvider } from '@posthog/react'
import { initPostHog, isPostHogEnabled, posthog } from './lib/posthog'

initPostHog()

const app = isPostHogEnabled() ? (
  <PostHogProvider client={posthog}>
    <PostHogErrorBoundary fallback={<div>页面暂时不可用，请刷新后重试。</div>}>
      <App />
    </PostHogErrorBoundary>
  </PostHogProvider>
) : <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {app}
  </StrictMode>,
)
