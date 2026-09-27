import { useEffect, useRef, useState, useCallback } from 'react'
import { BASE, type FileItem } from './api'

export function useLiveSocket(slug: string | undefined) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting')
  const [text, setText] = useState<string>('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [peers, setPeers] = useState<number>(1)
  const [clientId, setClientId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const destroyedRef = useRef(false)
  const localTextRef = useRef<string>('')
  const isDirtyRef = useRef(false)
  const [remoteUpdateTrigger, setRemoteUpdateTrigger] = useState(0)

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

  useEffect(() => {
    if (!slug) return
    destroyedRef.current = false
    let retryDelay = 1000
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null

    const connect = () => {
      if (destroyedRef.current) return
      setStatus(prev => prev === 'connected' ? 'reconnecting' : 'connecting')

      try {
        const url = getWsUrl(slug)
        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onopen = () => {
          if (destroyedRef.current) {
            ws.close()
            return
          }
          setStatus('connected')
          retryDelay = 1000

          // If there were local edits queued while disconnected, sync them immediately
          if (isDirtyRef.current && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'text',
              text: localTextRef.current,
            }))
            isDirtyRef.current = false
          }

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
              case 'init':
                if (typeof data.text === 'string') {
                  if (isDirtyRef.current && localTextRef.current !== data.text) {
                    // Local changes exist that the server didn't have; push them
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'text', text: localTextRef.current }))
                      isDirtyRef.current = false
                    }
                  } else {
                    localTextRef.current = data.text
                    setText(data.text)
                    setRemoteUpdateTrigger(prev => prev + 1)
                  }
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
                break

              case 'text':
                if (typeof data.text === 'string') {
                  localTextRef.current = data.text
                  isDirtyRef.current = false
                  setText(data.text)
                  setRemoteUpdateTrigger(prev => prev + 1)
                }
                break

              case 'peers':
                if (typeof data.peers === 'number') {
                  setPeers(data.peers)
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

              case 'pong':
                break
            }
          } catch (e) {
            console.error('Error handling live message:', e)
          }
        }

        ws.onclose = () => {
          if (pingTimer) clearInterval(pingTimer)
          if (destroyedRef.current) return
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
  }, [slug, getWsUrl])

  // Method to send live text update
  const sendText = useCallback((newText: string) => {
    localTextRef.current = newText
    setText(newText)
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      isDirtyRef.current = false
      wsRef.current.send(JSON.stringify({
        type: 'text',
        text: newText,
      }))
    } else {
      isDirtyRef.current = true
    }
  }, [])

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
  }, [])

  return {
    status,
    text,
    files,
    peers,
    clientId,
    remoteUpdateTrigger,
    sendText,
    addLocalFile,
    removeLocalFile,
  }
}
