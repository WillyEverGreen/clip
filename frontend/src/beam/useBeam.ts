import { useCallback, useEffect, useRef, useState } from 'react'
import { BeamSession, INITIAL_BEAM_STATE, type BeamState } from './beamSession'

/** React wrapper around one BeamSession at a time. */
export function useBeam() {
  const [state, setState] = useState<BeamState>(INITIAL_BEAM_STATE)
  const sessionRef = useRef<BeamSession | null>(null)

  const fresh = useCallback(() => {
    sessionRef.current?.dispose()
    const session = new BeamSession(setState)
    sessionRef.current = session
    return session
  }, [])

  useEffect(() => () => sessionRef.current?.dispose(), [])

  const send = useCallback((file: File) => fresh().send(file), [fresh])
  const join = useCallback((pin: string) => fresh().join(pin), [fresh])
  const accept = useCallback(() => sessionRef.current?.accept(), [])
  const decline = useCallback(() => sessionRef.current?.decline(), [])
  const cancel = useCallback(() => sessionRef.current?.cancel(), [])
  const reset = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
    setState(INITIAL_BEAM_STATE)
  }, [])

  return { state, send, join, accept, decline, cancel, reset }
}
