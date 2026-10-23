/** Shown while a page's code downloads. Same look as the splash in index.html so nothing flashes in between. */
export default function PageLoader() {
  return (
    <div className="page-loader" role="status" aria-label="Loading">
      <i />
    </div>
  )
}
