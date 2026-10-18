// Placeholder used when the private admin page is not present (fresh clone, CI, forks).
// scripts/postinstall.js copies this to AdminPage.tsx only when AdminPage.tsx is missing.
import ExpiredPage from './ExpiredPage'

export default function AdminPage() {
  return <ExpiredPage />
}
