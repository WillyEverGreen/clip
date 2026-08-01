import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import CreatePage  from './pages/CreatePage'
import ViewPage    from './pages/ViewPage'
import EditPage    from './pages/EditPage'
import ExpiredPage from './pages/ExpiredPage'

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


