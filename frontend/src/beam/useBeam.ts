import { useCallback, useEffect, useRef, useState } from 'react'
import { BeamSender, INITIAL_SENDER_STATE, type SenderState } from './beamSender'
import { loadMyName } from '../lib/cuteNames'
import { BeamReceiver, INITIAL_RECEIVER_STATE, type ReceiverState } from './beamReceiver'
import { BeamLobbyClient, type LobbyInvite, type LobbyStatus } from './beamLobby'
import { deleteRecord, listRecords, type ResumeRecord } from './resumeStore'

export type BeamRole = 'sender' | 'receiver'

/** Receive mode: this browser is listed to senders on the same network and can get requests. */
export interface VisibleState {
  on: boolean
  status: LobbyStatus
  /** The name senders see (the lobby may add a number if someone else has it) */
  name: string
  invites: LobbyInvite[]
}

const VISIBLE_OFF: VisibleState = { on: false, status: 'connecting', name: '', invites: [] }

/** React wrapper: at most one BeamSender or one BeamReceiver is alive at a time. */
export function useBeam() {
  const [role, setRole] = useState<BeamRole | null>(null)
  const [sender, setSender] = useState<SenderState>(INITIAL_SENDER_STATE)
  const [receiver, setReceiver] = useState<ReceiverState>(INITIAL_RECEIVER_STATE)
  const [visible, setVisibleState] = useState<VisibleState>(VISIBLE_OFF)
  const [unfinished, setUnfinished] = useState<ResumeRecord[]>([])
  const senderRef = useRef<BeamSender | null>(null)
  const receiverRef = useRef<BeamReceiver | null>(null)
  const lobbyRef = useRef<BeamLobbyClient | null>(null)

  const closeLobby = useCallback(() => {
    lobbyRef.current?.close()
    lobbyRef.current = null
    setVisibleState(VISIBLE_OFF)
  }, [])

  const disposeAll = useCallback(() => {
    senderRef.current?.dispose()
    receiverRef.current?.dispose()
    senderRef.current = null
    receiverRef.current = null
  }, [])

  useEffect(() => () => {
    disposeAll()
    lobbyRef.current?.close()
  }, [disposeAll])

  /** Downloads that were interrupted earlier and can be carried on (this browser only). */
  const refreshUnfinished = useCallback(() => {
    void listRecords().then(setUnfinished)
  }, [])
  useEffect(() => {
    refreshUnfinished()
  }, [refreshUnfinished])

  /** Start sharing: opens a room with these files. More can be added while it stays open. */
  const send = useCallback((files: File[]) => {
    if (files.length === 0) return
    disposeAll()
    closeLobby() // a sender is never listed
    const s = new BeamSender(setSender)
    senderRef.current = s
    setRole('sender')
    s.start(files, loadMyName())
  }, [disposeAll, closeLobby])

  const join = useCallback((pin: string, name = loadMyName()) => {
    disposeAll()
    closeLobby()
    const r = new BeamReceiver(setReceiver)
    receiverRef.current = r
    setRole('receiver')
    r.join(pin, name)
  }, [disposeAll, closeLobby])

  const reset = useCallback(() => {
    disposeAll()
    closeLobby()
    setRole(null)
    setSender(INITIAL_SENDER_STATE)
    setReceiver(INITIAL_RECEIVER_STATE)
    refreshUnfinished()
  }, [disposeAll, closeLobby, refreshUnfinished])

  /** Carry on an unfinished download from an earlier visit. Must be called from a click. */
  const resumeUnfinished = useCallback((record: ResumeRecord) => {
    disposeAll()
    closeLobby()
    const r = new BeamReceiver(setReceiver)
    receiverRef.current = r
    setRole('receiver')
    void r.resumeFromRecord(record)
  }, [disposeAll, closeLobby])

  const discardUnfinished = useCallback((rk: string) => {
    void deleteRecord(rk).then(refreshUnfinished)
  }, [refreshUnfinished])

  /** Turns Receive mode on or off. Off by default; only while on does anyone nearby see this browser. */
  const setVisible = useCallback((on: boolean) => {
    lobbyRef.current?.close()
    lobbyRef.current = null
    if (!on) {
      setVisibleState(VISIBLE_OFF)
      return
    }
    setVisibleState({ on: true, status: 'connecting', name: loadMyName(), invites: [] })
    const lobby = new BeamLobbyClient('receiver', loadMyName(), {
      onStatus: (status) => setVisibleState((v) => (v.on ? { ...v, status } : v)),
      onWelcome: (_id, name) => setVisibleState((v) => (v.on ? { ...v, name } : v)),
      onInvite: (invite) => setVisibleState((v) => (v.on ? { ...v, invites: [...v.invites.filter((i) => i.inviteId !== invite.inviteId), invite] } : v)),
      onInviteGone: (inviteId) => setVisibleState((v) => ({ ...v, invites: v.invites.filter((i) => i.inviteId !== inviteId) })),
    })
    lobbyRef.current = lobby
    lobby.connect()
  }, [])

  /** Answer a request from a nearby sender. Accepting connects to that sender and stops being listed. */
  const respondInvite = useCallback((invite: LobbyInvite, accept: boolean, block = false) => {
    const lobby = lobbyRef.current
    lobby?.respond(invite.inviteId, accept, block)
    if (accept) {
      join(invite.pin, visible.name || loadMyName())
    } else {
      setVisibleState((v) => ({ ...v, invites: v.invites.filter((i) => i.inviteId !== invite.inviteId) }))
    }
  }, [join, visible.name])

  return {
    role, sender, receiver, visible, unfinished, send, join, reset, setVisible, respondInvite,
    resumeUnfinished, discardUnfinished,
    // Sender
    addFiles: useCallback((files: File[]) => senderRef.current?.addFiles(files), []),
    stopSharing: useCallback(() => senderRef.current?.stop(), []),
    cancelSendFile: useCallback((legId: string, f: number) => senderRef.current?.cancelFile(legId, f), []),
    disconnectLeg: useCallback((legId: string) => senderRef.current?.disconnectLeg(legId), []),
    dismissLeg: useCallback((legId: string) => senderRef.current?.dismissLeg(legId), []),
    inviteNearby: useCallback((ids: string[]) => senderRef.current?.invite(ids), []),
    /** Reconnect the sender's own link to Clip now */
    reconnectSender: useCallback(() => senderRef.current?.reconnectNow(), []),
    // Receiver
    acceptOffer: useCallback(() => receiverRef.current?.acceptOffer(), []),
    declineOffer: useCallback(() => receiverRef.current?.declineOffer(), []),
    setAcceptAll: useCallback((on: boolean) => receiverRef.current?.setAcceptAll(on), []),
    cancelReceiveFile: useCallback(() => receiverRef.current?.cancelFile(), []),
    disconnectReceiver: useCallback(() => receiverRef.current?.disconnect(), []),
    /** Reconnect an interrupted receiver now (the Reconnect button) */
    reconnectReceive: useCallback(() => receiverRef.current?.reconnect(true), []),
  }
}
