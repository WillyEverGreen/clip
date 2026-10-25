import { Component, type ReactNode } from 'react'

/** Shows a way out instead of a blank screen when a page fails to load or crashes. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="page-loader" role="alert">
        <div className="page-error">
          <h1>Something did not load</h1>
          <p>Clip may have just been updated. Reloading usually fixes it.</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
