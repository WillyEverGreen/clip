import { BrowserRouter, Routes, Route } from 'react-router-dom'
import CreatePage  from './pages/CreatePage'
import ViewPage    from './pages/ViewPage'
import EditPage    from './pages/EditPage'
import ExpiredPage from './pages/ExpiredPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"            element={<CreatePage />} />
        <Route path="/:slug"       element={<ViewPage />} />
        <Route path="/:slug/edit"  element={<EditPage />} />
        <Route path="/404"         element={<ExpiredPage />} />
        <Route path="*"            element={<ExpiredPage />} />
      </Routes>
    </BrowserRouter>
  )
}
