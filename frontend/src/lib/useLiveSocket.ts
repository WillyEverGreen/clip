import { useEffect, useRef, useState, useCallback } from 'react'
import { BASE, getLiveState, type FileItem } from './api'
import { computeAuthHash } from './crypto'
import { useWebRtcPeer } from './useWebRtcPeer'
import { OtClient, diffOps, hashText, mapPos, type ClientStep, type Op, type ReplayOp } from './ot'

export interface RemoteCursor {
  id: string
  name: string
  start: number
  end: number
}

interface LiveSocketOptions {
  /**
   * Called synchronously whenever the network changes the editor text, with the edit that was
   * applied when it was a single op. The editor must put `text` into the textarea right away
   * (before React re-renders), otherwise a keystroke in that gap would be computed against stale
   * text and could undo someone else's change.
   */
  syncEditor?: (text: string, op?: Op) => void
}

function isRemoteCursor(v: unknown): v is RemoteCursor {
  if (typeof v !== 'object' || v === null) return false
  const c = v as RemoteCursor
  return typeof c.id === 'string' && typeof c.name === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end)
}

export function useLiveSocket(slug: string | undefined, options: LiveSocketOptions = {}) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting')
  const [text, setText] = useState<string>('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [peers, setPeers] = useState<number>(1)
  const [clientId, setClientId] = useState<string | null>(null)
  const [peerIds, setPeerIds] = useState<string[]>([])
  const [cursors, setCursors] = useState<RemoteCursor[]>([])

  // Authentication states
  const [isProtected, setIsProtected] = useState<boolean>(false)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(true)
  const [isProtectionChecked, setIsProtectionChecked] = useState<boolean>(false)
  const [salt, setSalt] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [roomClosedMessage, setRoomClosedMessage] = useState<string | null>(null)
  const currentPasswordRef = useRef<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const destroyedRef = useRef(false)
  // Identifies this page's editor across reconnects (not persisted, so duplicated tabs never collide)
  const sidRef = useRef<string | null>(null)
  if (sidRef.current === null) sidRef.current = crypto.randomUUID()
  const otRef = useRef<OtClient | null>(null)
  // True once we hold server state; decides between replaying missed ops and a fresh start
  const hasStateRef = useRef(false)
  const resyncTimesRef = useRef<number[]>([])
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map())
  const presenceRef = useRef<{ on: boolean; name: string }>({ on: false, name: '' })
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const syncEditorRef = useRef(options.syncEditor)
  useEffect(() => {
    syncEditorRef.current = options.syncEditor
  })
  const [remoteUpdateTrigger, setRemoteUpdateTrigger] = useState(0)
  const p2pBlobsRef = useRef<Map<string, Blob>>(new Map())
  const handleIncomingSignalRef = useRef<((senderId: string, payload: any) => Promise<void>) | null>(null)

  // Helper to derive WebSocket URL from the base API URL
  const getWsUrl = useCallback((s: string) => {
    let wsBase: string
    if (BASE.startsWith('http://')) {
      wsBase = BASE.replace('http://', 'ws://')
    } else if (BASE.startsWith('https://')) {
      wsBase = BASE.replace('https://', 'wss://')
    } else {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsBase = `${proto}//${window.location.host}`
    }
    return `${wsBase}/api/live/${s}/ws`
  }, [])

  const sendJson = useCallback((msg: object): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  // Send whatever the sync engine wants on the wire, or ask the server to resync
  const flushStep = useCallback((step: ClientStep) => {
    if (step.kind === 'desync') {
      sendJson({ type: 'resync' })
      return
    }
    if (step.send) {
      sendJson({ type: 'op', v: step.baseVersion, n: step.n, s: step.send.s, e: step.send.e, x: step.send.x })
    }
  }, [sendJson])

  const commitCursors = useCallback(() => {
    setCursors(Array.from(cursorsRef.current.values()))
  }, [])

  // Keep other people's carets on the same words when the text shifts
  const shiftCursors = useCallback((op: Op) => {
    if (cursorsRef.current.size === 0) return
    for (const c of cursorsRef.current.values()) {
      c.start = mapPos(c.start, op)
      c.end = mapPos(c.end, op)
    }
    commitCursors()
  }, [commitCursors])

  const announcePresence = useCallback(() => {
    const p = presenceRef.current
    if (!p.on) return
    sendJson({ type: 'presence', on: true, name: p.name, start: selectionRef.current.start, end: selectionRef.current.end })
  }, [sendJson])

  useEffect(() => {
    if (!slug) return
    destroyedRef.current = false
    otRef.current = new OtClient(sidRef.current!)
    hasStateRef.current = false
    resyncTimesRef.current = []
    cursorsRef.current = new Map()
    setCursors([])
    let retryDelay = 1000
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null

    // Pre-check room protection state so UI never flashes unprotected content
    getLiveState(slug).then(st => {
      if (destroyedRef.current) return
      if (st?.isProtected) {
        setIsProtected(true)
        if (st.salt) setSalt(st.salt)
        const cachedPass = currentPasswordRef.current || sessionStorage.getItem('clip_live_pass_' + slug)
        if (!cachedPass) {
          setIsAuthenticated(false)
        }
      }
      setIsProtectionChecked(true)
    }).catch(() => {
      if (!destroyedRef.current) setIsProtectionChecked(true)
    })

    const connect = () => {
      if (destroyedRef.current) return
      setStatus(prev => prev === 'connected' ? 'reconnecting' : 'connecting')

      try {
        const ot = otRef.current!
        // Tell the server which version we last saw so it can replay what we missed
        const connectedAt = hasStateRef.current ? ot.version : -1
        const url = `${getWsUrl(slug)}?ot=1&sid=${encodeURIComponent(ot.sid)}&v=${connectedAt}`
        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onopen = () => {
          if (destroyedRef.current) {
            ws.close()
            return
          }
          setStatus('connected')
          retryDelay = 1000

          // Keep connection alive with lightweight ping
          if (pingTimer) clearInterval(pingTimer)
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }))
            }
          }, 20_000)
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            switch (data.type) {
              case 'auth_challenge':
                setIsProtected(true)
                setIsAuthenticated(false)
                setIsProtectionChecked(true)
                if (data.salt) {
                  setSalt(data.salt)
                  const cachedPass = currentPasswordRef.current || sessionStorage.getItem('clip_live_pass_' + slug)
                  if (cachedPass && ws.readyState === WebSocket.OPEN) {
                    computeAuthHash(cachedPass, data.salt).then(hash => {
                      ws.send(JSON.stringify({ type: 'auth', hash }))
                    })
                  }
                }
                if (typeof data.peers === 'number') {
                  setPeers(data.peers)
                }
                if (data.clientId) {
                  setClientId(data.clientId)
                }
                break

              case 'auth_error':
                setAuthError(data.message || 'Incorrect password')
                currentPasswordRef.current = null
                if (slug) {
                  sessionStorage.removeItem('clip_live_pass_' + slug)
                }
                break

              case 'init':
                setIsAuthenticated(true)
                setIsProtectionChecked(true)
                setAuthError(null)
                if (typeof data.text === 'string' && typeof data.version === 'number') {
                  const ot = otRef.current!
                  const state = {
                    text: data.text as string,
                    version: data.version as number,
                    replay: Array.isArray(data.replay) ? (data.replay as ReplayOp[]) : null,
                  }
                  // First connect starts from the server's text; later ones pick up where we left off
                  const step = hasStateRef.current
                    ? ot.resume(state, connectedAt)
                    : ot.rebase(state.text, state.version)
                  hasStateRef.current = true
                  syncEditorRef.current?.(ot.local)
                  setText(ot.local)
                  setRemoteUpdateTrigger(prev => prev + 1)
                  flushStep(step)
                  announcePresence()
                }
                if (Array.isArray(data.files)) {
                  setFiles(data.files)
                }
                if (typeof data.peers === 'number') {
                  setPeers(data.peers)
                }
                if (data.clientId) {
                  setClientId(data.clientId)
                }
                if (Array.isArray(data.peerIds)) {
                  setPeerIds(data.peerIds)
                }
                break

              case 'ack':
                if (typeof data.v === 'number') flushStep(otRef.current!.ack(data.v))
                break

              case 'op': {
                const ot = otRef.current!
                const step = typeof data.v === 'number'
                  ? ot.remote({ s: data.s, e: data.e, x: data.x }, data.v)
                  : ({ kind: 'desync' } as const)
                if (step.kind === 'desync') {
                  sendJson({ type: 'resync' })
                  break
                }
                syncEditorRef.current?.(ot.local, step.applied)
                setText(ot.local)
                shiftCursors(step.applied)
                setRemoteUpdateTrigger(prev => prev + 1)
                break
              }

              case 'resync':
                if (typeof data.text === 'string' && typeof data.version === 'number') {
                  const ot = otRef.current!
                  const now = Date.now()
                  const recent = resyncTimesRef.current.filter(t => now - t < 10_000)
                  recent.push(now)
                  resyncTimesRef.current = recent
                  // Repeated resyncs mean our edits keep conflicting: take the server's text outright
                  const step = recent.length > 3 ? ot.rebase(data.text, data.version) : ot.merge(data.text, data.version)
                  hasStateRef.current = true
                  syncEditorRef.current?.(ot.local)
                  setText(ot.local)
                  setRemoteUpdateTrigger(prev => prev + 1)
                  flushStep(step)
                }
                break

              // Periodic proof that we hold exactly the server's text; anything else heals itself
              case 'check': {
                const ot = otRef.current!
                if (typeof data.v === 'number' && typeof data.h === 'string' && ot.version === data.v
                  && ot.isSynced() && hashText(ot.base) !== data.h) {
                  sendJson({ type: 'resync' })
                }
                break
              }

              case 'cursors':
                cursorsRef.current = new Map(
                  (Array.isArray(data.list) ? data.list : []).filter(isRemoteCursor).map((c: RemoteCursor) => [c.id, c]),
                )
                commitCursors()
                break

              case 'cursor':
                if (isRemoteCursor(data)) {
                  cursorsRef.current.set(data.id, { id: data.id, name: data.name, start: data.start, end: data.end })
                  commitCursors()
                }
                break

              case 'cursor_off':
                if (typeof data.id === 'string' && cursorsRef.current.delete(data.id)) commitCursors()
                break

              case 'peers':
                if (typeof data.peers === 'number') {
                  setPeers(data.peers)
                }
                if (Array.isArray(data.peerIds)) {
                  setPeerIds(data.peerIds)
                  const present = new Set<string>(data.peerIds)
                  let pruned = false
                  for (const id of Array.from(cursorsRef.current.keys())) {
                    if (!present.has(id)) { cursorsRef.current.delete(id); pruned = true }
                  }
                  if (pruned) commitCursors()
                }
                break

              case 'rtc_signal':
                if (data.senderId && data.payload && handleIncomingSignalRef.current) {
                  handleIncomingSignalRef.current(data.senderId, data.payload)
                }
                break

              case 'file_added':
                if (data.file) {
                  setFiles(prev => {
                    const filtered = prev.filter(f => f.id !== data.file.id)
                    return [...filtered, data.file]
                  })
                }
                break

              case 'file_removed':
                if (data.fileId) {
                  setFiles(prev => prev.filter(f => f.id !== data.fileId))
                }
                break

              case 'files_removed':
                if (Array.isArray(data.fileIds)) {
                  const idSet = new Set(data.fileIds)
                  setFiles(prev => prev.filter(f => !idSet.has(f.id)))
                }
                break

              case 'room_closed':
                destroyedRef.current = true
                setStatus('disconnected')
                setRoomClosedMessage(data.message || 'Room has been terminated by administrator.')
                if (retryTimer) clearTimeout(retryTimer)
                if (pingTimer) clearInterval(pingTimer)
                try { ws.close(1000, 'Room terminated') } catch {}
                break

              case 'pong':
                break
            }
          } catch (e) {
            console.error('Error handling live message:', e)
          }
        }

        ws.onclose = (event: CloseEvent) => {
          if (pingTimer) clearInterval(pingTimer)
          if (destroyedRef.current || (event && event.code === 1000 && event.reason === 'Room terminated')) {
            destroyedRef.current = true
            setStatus('disconnected')
            setRoomClosedMessage(prev => prev || 'Room has been terminated by administrator.')
            return
          }
          otRef.current?.setOnline(false)
          cursorsRef.current.clear()
          setCursors([])
          setStatus('reconnecting')
          retryTimer = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 1.5, 10_000)
            connect()
          }, retryDelay)
        }

        ws.onerror = () => {
          ws.close()
        }
      } catch {
        if (!destroyedRef.current) {
          retryTimer = setTimeout(connect, 3000)
        }
      }
    }

    connect()

    return () => {
      destroyedRef.current = true
      if (retryTimer) clearTimeout(retryTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [slug, getWsUrl, flushStep, sendJson, shiftCursors, commitCursors, announcePresence])

  // WebRTC P2P DataChannel setup
  const sendWsSignal = useCallback((targetId: string, payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'rtc_signal',
        targetId,
        payload,
      }))
    }
  }, [])

  // Peer-to-peer text is ignored: concurrent edits must go through the server so they merge
  const ignoreP2PText = useCallback(() => {}, [])

  const onRemoteFileReceived = useCallback((file: FileItem, blob: Blob) => {
    p2pBlobsRef.current.set(file.id, blob)
    setFiles(prev => {
      if (prev.some(f => f.id === file.id)) return prev
      return [...prev, file]
    })
  }, [])

  const {
    isP2PActive,
    p2pPeerCount,
    sendP2PFile,
    handleIncomingSignal,
  } = useWebRtcPeer({
    myClientId: clientId,
    activePeerIds: peerIds,
    sendWsSignal,
    onRemoteText: ignoreP2PText,
    onRemoteFileReceived,
  })

  useEffect(() => {
    handleIncomingSignalRef.current = handleIncomingSignal
  }, [handleIncomingSignal])

  // Method to authenticate with room password
  const authenticate = useCallback(async (password: string) => {
    if (!salt || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    setAuthError(null)
    currentPasswordRef.current = password
    if (slug) {
      sessionStorage.setItem('clip_live_pass_' + slug, password)
    }
    const hash = await computeAuthHash(password, salt)
    wsRef.current.send(JSON.stringify({
      type: 'auth',
      hash,
    }))
  }, [salt, slug])

  // The user typed: update the editor right away and let the sync engine decide what to send
  const sendText = useCallback((newText: string) => {
    const ot = otRef.current
    if (!ot) return
    const before = ot.local
    const step = ot.edit(newText)
    setText(newText)
    if (cursorsRef.current.size > 0) {
      for (const op of diffOps(before, newText)) shiftCursors(op)
    }
    flushStep(step)
  }, [flushStep, shiftCursors])

  // Turn multi-cursor on or off for this tab (the choice is the caller's to persist)
  const setPresence = useCallback((on: boolean, name: string) => {
    presenceRef.current = { on, name }
    if (on) {
      announcePresence()
      return
    }
    cursorsRef.current.clear()
    setCursors([])
    sendJson({ type: 'presence', on: false })
  }, [announcePresence, sendJson])

  // Report where our caret is
  const sendCursor = useCallback((start: number, end: number) => {
    selectionRef.current = { start, end }
    if (presenceRef.current.on) sendJson({ type: 'cursor', start, end })
  }, [sendJson])

  // Method to update local files after an upload
  const addLocalFile = useCallback((file: FileItem) => {
    setFiles(prev => {
      if (prev.some(f => f.id === file.id)) return prev
      return [...prev, file]
    })
  }, [])

  // Method to remove local file after deletion
  const removeLocalFile = useCallback((fileId: string) => {
    setFiles(prev => prev.filter(f => f.id !== fileId))
    p2pBlobsRef.current.delete(fileId)
  }, [])

  // Method to remove multiple files
  const removeLocalFiles = useCallback((fileIds: string[]) => {
    const idSet = new Set(fileIds)
    setFiles(prev => prev.filter(f => !idSet.has(f.id)))
    fileIds.forEach(id => p2pBlobsRef.current.delete(id))
  }, [])

  const getP2PBlob = useCallback((fileId: string) => {
    return p2pBlobsRef.current.get(fileId)
  }, [])

  const setLocalP2PBlob = useCallback((fileId: string, blob: Blob) => {
    p2pBlobsRef.current.set(fileId, blob)
  }, [])

  return {
    status,
    roomClosedMessage,
    text,
    files,
    peers,
    clientId,
    cursors,
    setPresence,
    sendCursor,
    isProtected,
    isAuthenticated,
    isProtectionChecked,
    authError,
    authenticate,
    remoteUpdateTrigger,
    sendText,
    addLocalFile,
    removeLocalFile,
    removeLocalFiles,
    isP2PActive,
    p2pPeerCount,
    sendP2PFile,
    getP2PBlob,
    setLocalP2PBlob,
  }
}

