import { useCallback, useEffect, useRef, useState } from 'react'
import { BeamSender, INITIAL_SENDER_STATE, type SenderState } from './beamSender'
import { loadMyName } from '../lib/cuteNames'
import { BeamReceiver, INITIAL_RECEIVER_STATE, type ReceiverState } from './beamReceiver'

export type BeamRole = 'sender' | 'receiver'

/** React wrapper: at most one BeamSender or one BeamReceiver is alive at a time. */
export function useBeam() {
  const [role, setRole] = useState<BeamRole | null>(null)
  const [sender, setSender] = useState<SenderState>(INITIAL_SENDER_STATE)
  const [receiver, setReceiver] = useState<ReceiverState>(INITIAL_RECEIVER_STATE)
  const senderRef = useRef<BeamSender | null>(null)
  const receiverRef = useRef<BeamReceiver | null>(null)

  const disposeAll = useCallback(() => {
    senderRef.current?.dispose()
    receiverRef.current?.dispose()
    senderRef.current = null
    receiverRef.current = null
  }, [])

  useEffect(() => disposeAll, [disposeAll])

  const send = useCallback((file: File) => {
    disposeAll()
    const s = new BeamSender(setSender)
    senderRef.current = s
    setRole('sender')
    s.start(file, loadMyName())
  }, [disposeAll])

  const join = useCallback((pin: string) => {
    disposeAll()
    const r = new BeamReceiver(setReceiver)
    receiverRef.current = r
    setRole('receiver')
    r.join(pin, loadMyName())
  }, [disposeAll])

  const reset = useCallback(() => {
    disposeAll()
    setRole(null)
    setSender(INITIAL_SENDER_STATE)
    setReceiver(INITIAL_RECEIVER_STATE)
  }, [disposeAll])

  return {
    role, sender, receiver, send, join, reset,
    accept: useCallback(() => receiverRef.current?.accept(), []),
    decline: useCallback(() => receiverRef.current?.decline(), []),
    cancelReceive: useCallback(() => receiverRef.current?.cancel(), []),
    stopSharing: useCallback(() => senderRef.current?.stop(), []),
    cancelLeg: useCallback((id: string) => senderRef.current?.cancelLeg(id), []),
  }
}
