import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import PageLoader from './components/PageLoader'
import ErrorBoundary from './components/ErrorBoundary'
import { lazyWithRetry } from './lib/lazyWithRetry'

// All pages are lazy-loaded so the initial JS bundle stays tiny.
// Each page chunk is only downloaded when the user navigates to it.
const loaders = {
  create: () => import('./pages/CreatePage'),
  view: () => import('./pages/ViewPage'),
  edit: () => import('./pages/EditPage'),
  live: () => import('./pages/LivePage'),
  expired: () => import('./pages/ExpiredPage'),
  about: () => import('./pages/AboutPage'),
  beam: () => import('./beam/BeamPage'),
}
const CreatePage  = lazyWithRetry(loaders.create)
const ViewPage    = lazyWithRetry(loaders.view)
const EditPage    = lazyWithRetry(loaders.edit)
const LivePage    = lazyWithRetry(loaders.live)
const ExpiredPage = lazyWithRetry(loaders.expired)
const AboutPage   = lazyWithRetry(loaders.about)
const BeamPage    = lazyWithRetry(loaders.beam)

/** Once the page in front of the visitor is up, fetch the main pages quietly so moving between them is instant. */
function useWarmPages() {
  useEffect(() => {
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return
    const warm = () => { for (const load of [loaders.create, loaders.about, loaders.beam, loaders.live]) load().catch(() => undefined) }
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(warm, { timeout: 4000 })
    else setTimeout(warm, 2500)
  }, [])
}

/** The splash in index.html covers the page until the first screen is ready. */
function useDismissSplash() {
  useEffect(() => {
    const el = document.getElementById('boot')
    if (!el) return
    el.classList.add('is-gone')
    const t = setTimeout(() => el.remove(), 300)
    return () => clearTimeout(t)
  }, [])
}

const AdminPage = lazy(() =>
  import('./pages/AdminPage').catch(() => ({
    default: () => <ExpiredPage />,
  }))
)

/** Fades each page in so switching pages does not pop. Keyed on the first path segment so in-page changes do not replay it. */
function RouteFade({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <div className="route-fade" key={pathname.split('/')[1] ?? ''}>{children}</div>
}

export default function App() {
  useDismissSplash()
  useWarmPages()
  return (
    <BrowserRouter>
      <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <RouteFade>
        <Routes>
          <Route path="/"            element={<CreatePage />} />
          <Route path="/live"        element={<LivePage />} />
          <Route path="/live/:slug"  element={<LivePage />} />
          <Route path="/about"       element={<AboutPage />} />
          <Route path="/beam"        element={<BeamPage />} />
          <Route path="/admin"      element={<AdminPage />} />
          <Route path="/:slug"       element={<ViewPage />} />
          <Route path="/:slug/edit"  element={<EditPage />} />
          <Route path="/404"         element={<ExpiredPage />} />
          <Route path="*"            element={<ExpiredPage />} />
        </Routes>
        </RouteFade>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
