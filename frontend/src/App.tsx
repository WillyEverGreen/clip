import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import PageLoader from './components/PageLoader'

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
const CreatePage  = lazy(loaders.create)
const ViewPage    = lazy(loaders.view)
const EditPage    = lazy(loaders.edit)
const LivePage    = lazy(loaders.live)
const ExpiredPage = lazy(loaders.expired)
const AboutPage   = lazy(loaders.about)
const BeamPage    = lazy(loaders.beam)

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

export default function App() {
  useDismissSplash()
  useWarmPages()
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
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
      </Suspense>
    </BrowserRouter>
  )
}
