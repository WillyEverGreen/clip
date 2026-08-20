import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

// All pages are lazy-loaded so the initial JS bundle stays tiny.
// Each page chunk is only downloaded when the user navigates to it.
const CreatePage  = lazy(() => import('./pages/CreatePage'))
const ViewPage    = lazy(() => import('./pages/ViewPage'))
const EditPage    = lazy(() => import('./pages/EditPage'))
const ExpiredPage = lazy(() => import('./pages/ExpiredPage'))

const AdminPage = lazy(() =>
  import('./pages/AdminPage').catch(() => ({
    default: () => <ExpiredPage />,
  }))
)

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/"            element={<CreatePage />} />
          <Route path="/admin"       element={<AdminPage />} />
          <Route path="/:slug"       element={<ViewPage />} />
          <Route path="/:slug/edit"  element={<EditPage />} />
          <Route path="/404"         element={<ExpiredPage />} />
          <Route path="*"            element={<ExpiredPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
