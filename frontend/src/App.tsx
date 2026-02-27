import { useState, useRef, type FormEvent, useEffect, useCallback, useMemo } from 'react'
import './App.css'
import { GraphicsPage } from './GraphicsPage'
import {
  MicIcon, StopIcon, DisplayIcon, SparklesIcon,
  ChevronLeftIcon, ChevronRightIcon,
  LinkIcon, YoutubeIcon, FileUploadIcon, TextIcon,
  CheckCircleIcon, XIcon, RefreshIcon, PlusIcon, PencilIcon, NarlugaLogo
} from './Icons'
import {
  signInWithGoogle, firebaseSignOut, getIdToken, onAuthChange,
  isFirebaseConfigured, saveGraphic, listGraphics,
  type User, type SavedGraphic
} from './firebase'

// Backend URL from environment (defaults to localhost for dev)
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
const WS_BACKEND_URL = BACKEND_URL.replace(/^http/, 'ws')

// Source types
type SourceType = 'url' | 'youtube' | 'text' | 'file'
type Source = {
  id: string
  type: SourceType
  content: string
  label: string
}

// Session phases
type SessionPhase = 'idle' | 'analyzing' | 'designing' | 'complete' | 'conversation'

function App() {
  // Source management
  const [sources, setSources] = useState<Source[]>([])
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [showTextArea, setShowTextArea] = useState(false)
  const [textAreaValue, setTextAreaValue] = useState('')

  // Session state
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('idle')
  const [, setStatusMessage] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [currentPage, setCurrentPage] = useState<'home' | 'gallery'>('home')
  const accountMenuRef = useRef<HTMLDivElement>(null)

  // Auth state
  const [user, setUser] = useState<User | null>(null)

  // Saved graphics gallery
  const [savedGraphics, setSavedGraphics] = useState<SavedGraphic[]>([])
  const [galleryLoading, setGalleryLoading] = useState(false)

  // SVG display state
  const [currentSvg, _setCurrentSvg] = useState<string | null>(null)
  const currentSvgRef = useRef<string | null>(null)
  const setCurrentSvg = (svg: string | null) => {
    currentSvgRef.current = svg
    _setCurrentSvg(svg)
  }
  const [currentControls, _setCurrentControls] = useState<string | null>(null)
  const currentControlsRef = useRef<string | null>(null)
  const setCurrentControls = (controls: string | null) => {
    currentControlsRef.current = controls
    _setCurrentControls(controls)
  }
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null)
  const narrationContextRef = useRef<string>('')
  const sourceLabelsRef = useRef<string[]>([])

  // Refs
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null)
  const micAudioCtxRef = useRef<AudioContext | null>(null)
  const micReadyRef = useRef<boolean>(false)
  const hasStartedRef = useRef<boolean>(false)
  const eventQueueRef = useRef<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nextPlayTimeRef = useRef<number>(0)
  const activeAudioNodesRef = useRef<AudioBufferSourceNode[]>([])

  // Detect input type from text
  const detectInputType = useCallback((text: string): { type: SourceType, label: string } => {
    const trimmed = text.trim()

    // YouTube detection
    if (/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)/.test(trimmed)) {
      return { type: 'youtube', label: trimmed }
    }

    // URL detection
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed)
        return { type: 'url', label: url.hostname + url.pathname.slice(0, 30) }
      } catch {
        return { type: 'url', label: trimmed.slice(0, 50) }
      }
    }

    // Default to text
    return { type: 'text', label: trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '') }
  }, [])

  // Add a source from the main input
  const addSource = useCallback((e?: FormEvent) => {
    if (e) e.preventDefault()
    const value = inputValue.trim()
    if (!value) return

    const { type, label } = detectInputType(value)
    const newSource: Source = {
      id: crypto.randomUUID(),
      type,
      content: value,
      label
    }
    setSources(prev => [...prev, newSource])
    setInputValue('')
  }, [inputValue, detectInputType])

  // Add text source from textarea
  const addTextSource = useCallback(() => {
    const value = textAreaValue.trim()
    if (!value) return

    const newSource: Source = {
      id: crypto.randomUUID(),
      type: 'text',
      content: value,
      label: value.slice(0, 50) + (value.length > 50 ? '...' : '')
    }
    setSources(prev => [...prev, newSource])
    setTextAreaValue('')
    setShowTextArea(false)
  }, [textAreaValue])

  // Handle file upload
  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)

      try {
        const token = await getIdToken()
        const response = await fetch(`${BACKEND_URL}/upload`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          method: 'POST',
          body: formData,
        })
        const data = await response.json()

        if (data.status === 'success') {
          const newSource: Source = {
            id: crypto.randomUUID(),
            type: 'file',
            content: data.content,
            label: `📄 ${data.filename}`
          }
          setSources(prev => [...prev, newSource])
        } else {
          setError(`Failed to process file: ${file.name}`)
        }
      } catch {
        setError(`Failed to upload file: ${file.name}`)
      }
    }

    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  // Remove a source
  const removeSource = useCallback((id: string) => {
    setSources(prev => prev.filter(s => s.id !== id))
  }, [setSources])

  const updateSource = useCallback((id: string, newValue: string) => {
    const trimmed = newValue.trim()
    if (!trimmed) return
    setSources(prev => prev.map(s => {
      if (s.id !== id) return s
      // Re-detect type from new value
      const { type } = detectInputType(trimmed)
      const displayLabel = type === 'youtube'
        ? trimmed
        : type === 'url'
          ? trimmed
          : trimmed
      return { ...s, type, content: trimmed, label: displayLabel }
    }))
  }, [])

  // Firebase auth state listener
  useEffect(() => {
    const unsubscribe = onAuthChange(async (firebaseUser) => {
      setUser(firebaseUser)
      if (firebaseUser) {
        // Load saved graphics when user signs in
        setGalleryLoading(true)
        try {
          const graphics = await listGraphics(firebaseUser.uid)
          setSavedGraphics(graphics)
        } catch (e) {
          console.error('[Gallery] Failed to load graphics:', e)
        } finally {
          setGalleryLoading(false)
        }
      } else {
        setSavedGraphics([])
      }
    })
    return unsubscribe
  }, [])

  // Attach a global function so the generated SVG's <script> can send events to the Voice AI
  // Also listen for iframe postMessage events (Hover & Interactions)
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout>;
    let hoverDebounceTimer: ReturnType<typeof setTimeout>;

    const sendToVoiceAI = (textPayload: string) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: textPayload }] }],
              turnComplete: true
            }
          }));
        } else {
          eventQueueRef.current.push(textPayload);
        }
      }
    };

    (window as any).sendEventToAI = (textMessage: string) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        sendToVoiceAI(`[System Status: The user just interacted with the dashboard UI. Action: ${textMessage}]`);
      }, 300);
    };

    let aiEventPending = false;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'HOVER_EVENT') {
        clearTimeout(hoverDebounceTimer);
        hoverDebounceTimer = setTimeout(() => {
          sendToVoiceAI(`[Cursor position: ${data.payload}]`);
        }, 300); // Small debounce for hover events
      } else if (data && data.type === 'AI_EVENT') {
        // Explicit state event from generated code (e.g., "User paused flight animation")
        // HIGH PRIORITY: cancel any pending INTERACTION_EVENT and block new ones briefly
        aiEventPending = true;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          sendToVoiceAI(`[System Status: The user just interacted with the dashboard UI. Action: ${data.payload}]`);
          aiEventPending = false;
        }, 200);
        // Release the lock after 500ms in case no timer fires
        setTimeout(() => { aiEventPending = false; }, 500);
      } else if (data && data.type === 'INTERACTION_EVENT') {
        // Generic click event — skip if an AI_EVENT from the same click is pending
        if (aiEventPending) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          sendToVoiceAI(`[System Status: The user just interacted with the dashboard UI. Action: ${data.payload}]`);
        }, 300);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(hoverDebounceTimer);
      delete (window as any).sendEventToAI;
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  // Disconnect cleanup
  const disconnect = useCallback(() => {
    micReadyRef.current = false
    hasStartedRef.current = false
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (audioWorkletNodeRef.current) {
      audioWorkletNodeRef.current.disconnect()
      audioWorkletNodeRef.current = null
    }
    if (micAudioCtxRef.current) {
      try { micAudioCtxRef.current.close() } catch (e) { }
      micAudioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    setIsConnecting(false)
    setHasStarted(false)
    // If we're ending a conversation and have a graphic, go back to 'complete'
    setSessionPhase(prev => {
      if ((prev === 'conversation' || prev === 'complete') && currentSvgRef.current) {
        return 'complete'
      }
      return 'idle'
    })
    setStatusMessage('')
  }, [])

  // Start live conversation (mic + audio)
  const startPresentation = async () => {
    if (!streamRef.current) {
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (err: any) {
        setError("Microphone permission is required to converse with the AI.");
        return;
      }
    }

    if (!audioCtxRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new AudioContext({ sampleRate: 24000 });
      nextPlayTimeRef.current = audioCtxRef.current.currentTime;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // WS is already open — just send start_live_session
      wsRef.current.send(JSON.stringify({
        type: "start_live_session",
        pre_events: eventQueueRef.current
      }))
      setHasStarted(true)
      hasStartedRef.current = true
      eventQueueRef.current = []

      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        try { audioCtxRef.current.resume(); } catch (err) { }
      }

      setupMic()
    } else if (narrationContextRef.current) {
      // WS is closed but we have context — reconnect via /ws/live-restart
      setIsConnecting(true)
      setError('')
      setStatusMessage('Reconnecting...')

      const token = await getIdToken()
      const wsUrl = token ? `${WS_BACKEND_URL}/ws/live-restart?token=${encodeURIComponent(token)}` : `${WS_BACKEND_URL}/ws/live-restart`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setIsConnecting(false)
        // Send restart context
        ws.send(JSON.stringify({
          type: "restart_live",
          narration_context: narrationContextRef.current,
          source_labels: sourceLabelsRef.current,
          svg_html: currentSvgRef.current || "",
          controls_html: currentControlsRef.current || ""
        }))
        // Immediately send start_live_session
        ws.send(JSON.stringify({
          type: "start_live_session",
          pre_events: eventQueueRef.current
        }))
        setHasStarted(true)
        hasStartedRef.current = true
        eventQueueRef.current = []

        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
          try { audioCtxRef.current.resume(); } catch (err) { }
        }
      }

      // Reuse the same message/close/error handlers
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type === 'phase') {
          setSessionPhase(data.phase as SessionPhase)
        } else if (data.type === 'ready') {
          micReadyRef.current = true
          setupMic()
        } else if (data.type === 'clear') {
          if (audioCtxRef.current) {
            // Stop all currently scheduled/playing audio nodes instantly without destroying the AudioContext
            activeAudioNodesRef.current.forEach(node => {
              try { node.stop() } catch (e) { }
            })
            activeAudioNodesRef.current = []
            // Reset the playhead so new audio plays immediately
            nextPlayTimeRef.current = audioCtxRef.current.currentTime
          }
        } else if (data.type === 'audio') {
          const base64Data = data.data
          const binaryStr = window.atob(base64Data)
          const len = binaryStr.length
          const bytes = new Uint8Array(len)
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i)
          }
          const int16Array = new Int16Array(bytes.buffer)
          const float32Array = new Float32Array(int16Array.length)
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0
          }
          if (audioCtxRef.current) {
            const audioBuffer = audioCtxRef.current.createBuffer(1, float32Array.length, 24000)
            audioBuffer.getChannelData(0).set(float32Array)
            const source = audioCtxRef.current.createBufferSource()
            source.buffer = audioBuffer
            source.connect(audioCtxRef.current.destination)
            const startTime = Math.max(audioCtxRef.current.currentTime, nextPlayTimeRef.current)
            source.start(startTime)
            nextPlayTimeRef.current = startTime + audioBuffer.duration

            // Track the playing node so we can interrupt it later
            activeAudioNodesRef.current.push(source)
            // Clean up node from tracking array when it finishes naturally
            source.onended = () => {
              activeAudioNodesRef.current = activeAudioNodesRef.current.filter(n => n !== source)
            }
          }
        } else if (data.type === 'error') {
          setError(data.message)
          disconnect()
        }
      }

      ws.onclose = (event) => {
        if (event.code === 1000 && event.reason) {
          // Clean server-side close with a reason — show it as info, not error
          setStatusMessage(event.reason)
        } else if (!event.wasClean && event.code !== 1000 && event.code !== 1005) {
          setError(`Connection lost (${event.code}). Click 'Start Live Conversation' to reconnect.`)
        }
        disconnect()
      }

      ws.onerror = () => {
        setError('WebSocket connection error.')
        disconnect()
      }
    }
  }

  // Helper: setup mic AudioWorklet
  const setupMic = () => {
    if (streamRef.current && !micAudioCtxRef.current) {
      const startMic = async () => {
        try {
          const micAudioCtx = new AudioContext({ sampleRate: 16000 })
          if (micAudioCtx.state === 'suspended') {
            await micAudioCtx.resume();
          }

          const source = micAudioCtx.createMediaStreamSource(streamRef.current!)

          const workletCode = `
              class PCMProcessor extends AudioWorkletProcessor {
                constructor() {
                  super();
                  this.buffer = new Int16Array(4096);
                  this.offset = 0;
                  this.sumSquare = 0;
                }
                process(inputs, outputs, parameters) {
                  const input = inputs[0];
                  if (input && input.length > 0) {
                    const channelData = input[0];
                    for (let i = 0; i < channelData.length; i++) {
                      const val = Math.max(-32768, Math.min(32767, channelData[i] * 32768));
                      this.buffer[this.offset++] = val;
                      this.sumSquare += val * val;
                      
                      if (this.offset >= 4096) {
                         this.port.postMessage(this.buffer.buffer.slice(0));
                         this.offset = 0;
                         this.sumSquare = 0;
                      }
                    }
                  }
                  return true;
                }
              }
              registerProcessor('pcm-processor', PCMProcessor);
            `;

          const blob = new Blob([workletCode], { type: 'application/javascript' });
          const workletUrl = URL.createObjectURL(blob);
          await micAudioCtx.audioWorklet.addModule(workletUrl);

          const processorNode = new AudioWorkletNode(micAudioCtx, 'pcm-processor')

          processorNode.port.onmessage = (e) => {
            const buffer = e.data;
            const uint8Array = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < uint8Array.byteLength; i++) {
              binary += String.fromCharCode(uint8Array[i]);
            }
            const base64Data = btoa(binary);

            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && micReadyRef.current) {
              wsRef.current.send(JSON.stringify({
                realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Data }] }
              }));
            }
          };

          source.connect(processorNode)
          processorNode.connect(micAudioCtx.destination)

          audioWorkletNodeRef.current = processorNode
          micAudioCtxRef.current = micAudioCtx
        } catch (err) {
          console.error("Failed to start mic audio context", err);
        }
      };
      startMic();
    }
  }

  // Start session: connect WebSocket and send sources
  const startSession = async () => {
    if (sources.length === 0) return

    setIsConnecting(true)
    setError('')
    setSessionPhase('analyzing')
    setStatusMessage('Connecting...')

    try {
      const token = await getIdToken()
      const wsUrl = token ? `${WS_BACKEND_URL}/ws/live?token=${encodeURIComponent(token)}` : `${WS_BACKEND_URL}/ws/live`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = async () => {
        setIsConnecting(false)
        setStatusMessage('Sending sources...')

        // Send the sources array as the first message
        ws.send(JSON.stringify({
          type: "init_sources",
          sources: sources.map(s => ({
            type: s.type,
            content: s.content,
            label: s.label
          }))
        }))
      }

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)

        if (data.type === 'phase') {
          setSessionPhase(data.phase as SessionPhase)
          if (data.phase === 'analyzing') setStatusMessage('Analyzing sources...')
          else if (data.phase === 'designing') setStatusMessage('Designing interactive graphic...')
          else if (data.phase === 'complete') setStatusMessage('Graphic complete!')
          else if (data.phase === 'conversation') setStatusMessage('Live conversation active')
        } else if (data.type === 'status') {
          setStatusMessage(data.message)
        } else if (data.type === 'ready') {
          micReadyRef.current = true
        } else if (data.type === 'interactive_svg') {
          setCurrentSvg(data.svg_html)
          setCurrentControls(data.controls_html || null)
          setCurrentTitle(data.title || null)
          setCurrentSubtitle(data.subtitle || null)
          // Store narration context for conversation restart
          if (data.narration_context) narrationContextRef.current = data.narration_context
          if (data.source_labels) sourceLabelsRef.current = data.source_labels

          // Auto-save to Firestore if user is signed in
          if (user && isFirebaseConfigured) {
            saveGraphic(user.uid, {
              title: data.title || 'Untitled',
              subtitle: data.subtitle || '',
              svg_html: data.svg_html || '',
              controls_html: data.controls_html || '',
              narration_context: data.narration_context || '',
              source_labels: data.source_labels || [],
            }).then(id => {
              setSavedGraphics(prev => [{
                id,
                title: data.title || 'Untitled',
                subtitle: data.subtitle || '',
                svg_html: data.svg_html || '',
                controls_html: data.controls_html || '',
                narration_context: data.narration_context || '',
                source_labels: data.source_labels || [],
                created_at: null,
              }, ...prev])
            }).catch(e => console.error('[Gallery] Failed to save graphic:', e))
          }
        } else if (data.type === 'clear') {
          if (audioCtxRef.current) {
            audioCtxRef.current.close().catch(console.error)
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            audioCtxRef.current = new AudioContext({ sampleRate: 24000 })
            nextPlayTimeRef.current = audioCtxRef.current.currentTime
          }
        } else if (data.type === 'audio') {
          const base64Data = data.data
          const binaryStr = window.atob(base64Data)
          const len = binaryStr.length
          const bytes = new Uint8Array(len)
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i)
          }

          const int16Array = new Int16Array(bytes.buffer)
          const float32Array = new Float32Array(int16Array.length)
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0
          }

          if (audioCtxRef.current) {
            const audioBuffer = audioCtxRef.current.createBuffer(1, float32Array.length, 24000)
            audioBuffer.getChannelData(0).set(float32Array)

            const source = audioCtxRef.current.createBufferSource()
            source.buffer = audioBuffer
            source.connect(audioCtxRef.current.destination)

            const startTime = Math.max(audioCtxRef.current.currentTime, nextPlayTimeRef.current)
            source.start(startTime)
            nextPlayTimeRef.current = startTime + audioBuffer.duration
          }
        } else if (data.type === 'tool_action') {
          const { action, params } = data

          // Handle fetch_more_detail indicator in the parent (it's a fixed overlay)
          if (action === 'fetch_more_detail') {
            if (params.status === 'searching') {
              const badge = document.createElement('div')
              badge.id = 'fetch-indicator'
              badge.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(59,130,246,0.9);color:white;padding:8px 16px;border-radius:20px;font-size:13px;z-index:9999;backdrop-filter:blur(8px);animation:fadeIn 0.3s ease;'
              badge.textContent = `🔍 Searching: ${params.query}`
              document.body.appendChild(badge)
            } else {
              document.getElementById('fetch-indicator')?.remove()
            }
          }

          // Forward ALL tool actions into the iframe where the SVG elements actually live
          if (iframeRef.current && iframeRef.current.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              { type: 'TOOL_ACTION', action, params }, '*'
            )
          }
        } else if (data.type === 'error') {
          setError(data.message)
          disconnect()
        }
      }

      ws.onclose = (event) => {
        if (event.code === 1000 && event.reason) {
          setStatusMessage(event.reason)
        } else if (!event.wasClean && event.code !== 1000 && event.code !== 1005) {
          setError(`Connection lost (${event.code}). Click 'Start Live Conversation' to reconnect.`)
        }
        disconnect()
      }

    } catch (err: any) {
      setError(err.message || 'Failed to initialize connection.')
      disconnect()
    }
  }

  // Reset everything for a new graphic
  const resetSession = useCallback(() => {
    disconnect()
    // Keep sources — only reset graphic state
    setCurrentSvg(null)
    setCurrentControls(null)
    setCurrentTitle(null)
    setCurrentSubtitle(null)
    setSessionPhase('idle')
    setStatusMessage('')
    setError('')
  }, [disconnect])

  // Cursor hover tracking — tell the AI what the user is pointing at
  useEffect(() => {
    if (sessionPhase !== 'conversation') return
    const container = document.querySelector('[data-svg-container]')
    if (!container) return

    let lastReport = ''
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const handleMouseMove = (e: Event) => {
      const mouseEvent = e as MouseEvent
      const target = mouseEvent.target as Element
      if (!target || target === container) return

      // Skip if hovering over the controls panel (right sidebar of the graphic)
      if (target.closest('[data-controls-container]')) return

      const cx = mouseEvent.clientX
      const cy = mouseEvent.clientY

      // 1. Find what the cursor is directly on
      let directLabel = ''
      // Check for id or data attributes on the target or nearest parent
      const attrEl = target.closest('[id], [data-label], [data-section]')
      if (attrEl) {
        directLabel = attrEl.getAttribute('data-label') || ''
        if (!directLabel && attrEl.id && attrEl.id.length >= 3) {
          directLabel = attrEl.id.replace(/[-_]/g, ' ')
        }
      }
      // If directly over text
      const directText = target.closest('text, tspan')
      if (directText) {
        directLabel = (directText.textContent || '').trim()
      }

      // 2. Find the nearest <text> label by proximity (within 150px)
      let nearestLabel = ''
      let nearestDist = 150
      container.querySelectorAll('text').forEach(textEl => {
        const content = (textEl.textContent || '').trim()
        if (content.length < 2 || content.length > 60) return
        const rect = textEl.getBoundingClientRect()
        const textCx = rect.left + rect.width / 2
        const textCy = rect.top + rect.height / 2
        const dist = Math.sqrt((cx - textCx) ** 2 + (cy - textCy) ** 2)
        if (dist < nearestDist) {
          nearestDist = dist
          nearestLabel = content
        }
      })

      // 3. Describe the element under cursor
      const tagName = target.tagName.toLowerCase()
      const fill = target.getAttribute('fill') || ''
      let elementDesc = ''
      if (['rect', 'circle', 'ellipse', 'polygon', 'path', 'line'].includes(tagName)) {
        elementDesc = `a ${fill ? fill + ' ' : ''}${tagName} shape`
      }

      // Build the report
      let report = ''
      if (directLabel && directLabel.length >= 2) {
        report = `"${directLabel}"`
      } else if (nearestLabel) {
        report = `near the "${nearestLabel}" label`
        if (elementDesc) report += ` (on ${elementDesc})`
      } else if (elementDesc) {
        report = elementDesc
      }

      if (!report || report === lastReport) return
      lastReport = report

      // Debounce: only send every 1.5 seconds
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        console.log('[Hover]', report)
        // Send as turnComplete:false so Gemini gets context without triggering a full response
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Cursor position: The user is currently pointing at ${report} in the diagram.]` }] }],
              turnComplete: false
            }
          }))
        }
      }, 1500)
    }

    container.addEventListener('mousemove', handleMouseMove)
    return () => {
      container.removeEventListener('mousemove', handleMouseMove)
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [sessionPhase, currentSvg])

  // Close account dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setShowAccountMenu(false)
      }
    }
    if (showAccountMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showAccountMenu])

  // Listen for telemetry // Setup iframe listener for AI events & Hovers & Interactions
  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      // Allow AI_EVENT (explicitly sent by generated code via sendEventToAI)
      if (event.data?.type === 'AI_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Graphic Event: ${event.data.payload}]` }] }],
              turnComplete: false
            }
          }))
        }
      }
      // Allow HOVER_EVENT (automatically sent continuously by the iframe script)
      else if (event.data?.type === 'HOVER_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Cursor position: The user is currently pointing at ${event.data.payload} in the diagram.]` }] }],
              turnComplete: false
            }
          }))
        }
      }
      // Allow INTERACTION_EVENT (automatically sent when user clicks buttons/inputs in the iframe)
      else if (event.data?.type === 'INTERACTION_EVENT' && event.data?.payload) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          wsRef.current.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Interaction: The user just ${event.data.payload} in the interactive controls panel.]` }] }],
              turnComplete: true
            }
          }))
        }
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

  // Construct a secure, isolated HTML document for the graphic and controls
  const iframeSrcDoc = useMemo(() => {
    if (!currentSvg) return '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: transparent;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    .layout-container {
      display: flex;
      width: 100%;
      height: 100%;
    }
    .svg-area {
      flex: 1;
      padding: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      position: relative;
      min-height: 0;
      min-width: 0;
    }
    .controls-area {
      flex: 0.4;
      min-width: 420px;
      max-width: 500px;
      height: 100%;
      padding: 24px;
      box-sizing: border-box;
      overflow-y: auto;
      transition: all 0.3s ease-in-out;
      border-left: 1px solid rgba(0,0,0,0.05);
    }
    body.sidebar-open .controls-area {
      flex: none;
      width: 380px;
      min-width: 380px;
      max-width: 380px;
    }
  </style>
  
  <script>
    // --- INTERVAL TRACKING ---
    // Monkey-patch setInterval/clearInterval to track all intervals created by generated code.
    // This prevents the interval-stacking bug where multiple setIntervals accumulate
    // because generated togglePlay()/stopAutoPlay() has a race condition.
    var __trackedIntervals = new Set();
    var __origSetInterval = window.setInterval.bind(window);
    var __origClearInterval = window.clearInterval.bind(window);
    window.setInterval = function(fn, ms) {
      var id = __origSetInterval(fn, ms);
      __trackedIntervals.add(id);
      return id;
    };
    window.clearInterval = function(id) {
      __trackedIntervals.delete(id);
      return __origClearInterval(id);
    };
    window.__clearAllIntervals = function() {
      __trackedIntervals.forEach(function(id) { __origClearInterval(id); });
      __trackedIntervals.clear();
    };

    // Communication bridge to host React app
    window.sendEventToAI = function(message) {
      window.parent.postMessage({ type: 'AI_EVENT', payload: message }, '*');
    };

    // Listen for layout changes and tool actions from host
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'SIDEBAR_TOGGLE') {
        if (event.data.isOpen) {
          document.body.classList.add('sidebar-open');
        } else {
          document.body.classList.remove('sidebar-open');
        }
      } else if (event.data?.type === 'TOOL_ACTION') {
        handleToolAction(event.data.action, event.data.params);
      }
    });

    // --- TOOL ACTIONS (Highlighting, Zooming) ---
    function handleToolAction(action, params) {
      const svgContainer = document.querySelector('.svg-area');
      if (!svgContainer) return;

      const findElements = (keyword) => {
        const kw = keyword.toLowerCase().replace(/[-_]/g, ' ').trim();
        if (!kw) return [];
        const results = [];
        const containerRect = svgContainer.getBoundingClientRect();

        const isTooLarge = (el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > containerRect.width * 0.6 && rect.height > containerRect.height * 0.6;
        };

        svgContainer.querySelectorAll('[id], [data-label], [data-section]').forEach(el => {
          const id = (el.id || '').toLowerCase().replace(/[-_]/g, ' ');
          const label = (el.getAttribute('data-label') || '').toLowerCase();
          const section = (el.getAttribute('data-section') || '').toLowerCase();
          if ((id.length >= 3 && id.includes(kw)) || label.includes(kw) || section.includes(kw)) {
            if (!isTooLarge(el)) results.push(el);
          }
        });

        if (results.length === 0) {
          svgContainer.querySelectorAll('text, tspan, foreignObject, h1, h2, h3, h4, p, span, label, button').forEach(el => {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.length > 0 && text.length < 200 && (text.includes(kw) || kw.split(' ').every(w => text.includes(w)))) {
              let target = el;
              if (el instanceof SVGElement && el.parentElement && el.parentElement.tagName.toLowerCase() === 'g') {
                target = el.parentElement;
              }
              if (!isTooLarge(target) && !results.includes(target)) results.push(target);
            }
          });
        }

        results.sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        });

        return results.slice(0, 3);
      };

      if (action === 'highlight_element') {
        const elements = findElements(params.element_id || '');
        const color = params.color || '#3b82f6';
        elements.forEach(el => {
          const prev = el.style.cssText;
          el.style.transition = 'all 0.4s ease';
          el.style.filter = "drop-shadow(0 0 16px " + color + ") drop-shadow(0 0 8px " + color + ")";
          if (el instanceof SVGElement) {
            el.style.transform = 'scale(1.03)';
            el.style.transformOrigin = 'center';
          }
          setTimeout(() => {
            el.style.filter = '';
            el.style.transform = '';
            setTimeout(() => { el.style.cssText = prev; }, 400);
          }, 4000);
        });
        if (elements.length > 0) elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else if (action === 'navigate_to_section') {
        const elements = findElements(params.section || '');
        if (elements.length > 0) elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else if (action === 'zoom_view') {
        const dir = params.direction || 'in';
        const currentScale = parseFloat(svgContainer.dataset.zoomScale || '1');
        let newScale = dir === 'in' ? Math.min(currentScale * 1.4, 3) : Math.max(currentScale / 1.4, 0.5);
        svgContainer.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
        svgContainer.style.transform = 'scale(' + newScale + ')';
        svgContainer.dataset.zoomScale = newScale.toString();
      } else if (action === 'fetch_more_detail') {
        const elements = findElements(params.topic || '');
        elements.forEach(el => {
          const prev = el.style.cssText;
          el.style.transition = 'all 0.3s ease';
          el.style.filter = 'drop-shadow(0 0 12px #fbbf24)';
          setTimeout(() => { el.style.cssText = prev; }, 2000);
        });
      } else if (action === 'modify_element') {
        const elements = findElements(params.element_id || '');
        const prop = params.css_property || '';
        const val = params.value || '';
        elements.forEach(el => {
          el.style.transition = 'all 0.5s ease';
          if (el instanceof SVGElement && ['fill', 'stroke', 'opacity', 'stroke-width', 'r', 'cx', 'cy', 'x', 'y', 'width', 'height', 'transform', 'display'].includes(prop)) {
            el.setAttribute(prop, val);
          } else {
            // For SVG elements with scale, set transform-origin to element center
            // to prevent position shifting
            if (el instanceof SVGElement && (prop === 'scale' || prop === 'transform')) {
              try {
                const bbox = el.getBBox();
                el.style.transformOrigin = (bbox.x + bbox.width / 2) + 'px ' + (bbox.y + bbox.height / 2) + 'px';
                el.style.transformBox = 'fill-box';
              } catch (e) { /* getBBox may fail on hidden elements */ }
            }
            const camelProp = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            el.style[camelProp] = val;
          }
        });
        if (elements.length > 0) {
          const el = elements[0];
          const prevFilter = el.style.filter;
          el.style.filter = 'drop-shadow(0 0 8px #3b82f6)';
          setTimeout(() => { el.style.filter = prevFilter; }, 1500);
        }
      } else if (action === 'click_element') {
        const kw = (params.element_id || '').toLowerCase().trim();
        console.log("[IFRAME TOOL] click_element initiated with kw: '" + kw + "'");
        if (!kw) {
          window.parent.postMessage({ type: 'CLICK_RESULT', success: false, keyword: '', clickedLabel: null }, '*');
          return;
        }
        const containers = document.querySelectorAll('.svg-area, .controls-area');
        let clicked = false;
        let matchedLabel = null;
        containers.forEach(container => {
          if (clicked) return;
          container.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="range"], a, [onclick], [role="button"]').forEach(el => {
            if (clicked) return;
            const text = (el.textContent || '').toLowerCase().trim();
            const id = (el.id || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            
            const matchText = text && (text.includes(kw) || kw.includes(text));
            const matchId = id && (id.includes(kw) || kw.includes(id));
            const matchTitle = title && (title.includes(kw) || kw.includes(title));
            const matchAria = ariaLabel && (ariaLabel.includes(kw) || kw.includes(ariaLabel));
            
            console.log("  -> Checking element: <" + el.tagName + "> id='" + id + "' text='" + text + "'. Match? " + !!(matchText || matchId || matchTitle || matchAria));
            
            if (matchText || matchId || matchTitle || matchAria) {
              matchedLabel = (el.textContent || el.id || '').trim();
              el.style.transition = 'all 0.2s ease';
              el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.5)';
              
              setTimeout(() => {
                el.style.boxShadow = '';
                if (el.tagName.toLowerCase() === 'input' && el.type === 'range') {
                   // For sliders, a raw click does nothing useful. If params.value was passed, use it,
                   // otherwise advance it by roughly 15% of its max.
                   let advanceStr = params.value;
                   if (!advanceStr) {
                       const current = parseFloat(el.value || '0');
                       const max = parseFloat(el.max || '100');
                       const step = parseFloat(el.step || '1');
                       let next = current + (max * 0.15);
                       if (next > max) next = parseFloat(el.min || '0');
                       // snap to step
                       next = Math.round(next / step) * step;
                       advanceStr = next.toString();
                   }
                   el.value = advanceStr;
                   el.dispatchEvent(new Event('input', { bubbles: true }));
                   el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                   // Before clicking, clear any stale intervals to prevent stacking
                   // (generated code's togglePlay may create new intervals without clearing old ones)
                   var btnText = (el.textContent || '').toLowerCase();
                   if (btnText.includes('play') || btnText.includes('pause') || btnText.includes('auto') || btnText.includes('▶') || btnText.includes('⏸')) {
                     if (window.__clearAllIntervals) window.__clearAllIntervals();
                   }
                   el.click();
                }
              }, 300);
              clicked = true;
            }
          });
        });
        // Report click result back to parent
        if (!clicked) {
          console.warn("[IFRAME TOOL] click_element: NO match found for keyword '" + kw + "'");
        }
        window.parent.postMessage({
          type: 'CLICK_RESULT',
          success: clicked,
          keyword: kw,
          clickedLabel: matchedLabel
        }, '*');
      }
    }

    // --- HOVER TRACKING ---
    let debounceTimer = null;
    let lastReport = '';
    let lastMouseX = 0;
    let lastMouseY = 0;

    document.addEventListener('mousemove', (e) => {
      // Only trigger if the mouse actually moved significantly (prevents DOM-update-triggered false movements)
      if (Math.abs(e.clientX - lastMouseX) < 5 && Math.abs(e.clientY - lastMouseY) < 5) return;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      // Skip hover tracking if the visualization is actively animating/playing (e.g. Auto-Orbit)
      // We can detect this if there's a button that says 'Pause' or if there's an active requestAnimationFrame loop
      // but the safest heuristic is to check if any text button says 'Pause' or 'Stop'
      const isAutoPlaying = Array.from(document.querySelectorAll('button')).some(b => 
        (b.innerText || '').toLowerCase().includes('pause') || 
        (b.innerText || '').toLowerCase().includes('stop')
      );
      if (isAutoPlaying) return;

      const svgContainer = document.querySelector('.svg-area');
      if (!svgContainer) return;
      
      const target = e.target;
      if (!svgContainer.contains(target)) return;

      const directLabel = target.getAttribute('data-label') || target.getAttribute('id') || '';
      let nearestLabel = '';
      let nearestDist = 60; 
      
      svgContainer.querySelectorAll('text').forEach(textEl => {
        const content = (textEl.textContent || '').trim();
        if (content.length < 2 || content.length > 60) return;
        const rect = textEl.getBoundingClientRect();
        const textCx = rect.left + rect.width / 2;
        const textCy = rect.top + rect.height / 2;
        const dist = Math.sqrt((e.clientX - textCx) ** 2 + (e.clientY - textCy) ** 2);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestLabel = content;
        }
      });

      const tagName = target.tagName.toLowerCase();
      const fill = target.getAttribute('fill') || '';
      let elementDesc = '';
      if (['rect', 'circle', 'ellipse', 'polygon', 'path', 'line'].includes(tagName)) {
        elementDesc = "a " + (fill ? fill + ' ' : '') + tagName + " shape";
      }

      let report = '';
      if (directLabel && directLabel.length >= 2) {
        report = '"' + directLabel + '"';
      } else if (nearestLabel) {
        report = 'near the "' + nearestLabel + '" label';
        if (elementDesc) report += ' (on ' + elementDesc + ')';
      } else if (elementDesc) {
        report = elementDesc;
      }

      if (!report || report === lastReport) return;
      lastReport = report;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        window.parent.postMessage({ type: 'HOVER_EVENT', payload: report }, '*');
      }, 1500);
    });

    // --- INTERACTION TRACKING ---
    // Automatically tell the parent when the user clicks a button or changes an input
    // For clicks: we defer label capture by 50ms so the button's onclick handler
    // has time to update the text (e.g., "▶ Play" → "⏸ Pause") before we read it.
    document.addEventListener('click', (e) => {
      let target = e.target;
      const interactiveEl = target.closest('button, a, input, select, [role="button"]');
      if (!interactiveEl) return;

      // Capture the BEFORE label immediately
      let beforeLabel = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
      if (!beforeLabel || beforeLabel.length > 50) return;

      // Defer to capture the AFTER label (post-click handler update)
      setTimeout(() => {
        let afterLabel = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
        let actionDesc = '';

        // Detect if this is a toggle button (label changed after click)
        if (afterLabel && afterLabel !== beforeLabel) {
          // Toggle detected — report resulting state
          const afterLower = afterLabel.toLowerCase();
          const isNowPaused = afterLower.includes('play') || afterLower.includes('start') || afterLower.includes('▶');
          const isNowPlaying = afterLower.includes('pause') || afterLower.includes('stop') || afterLower.includes('⏸');
           if (isNowPlaying) {
            actionDesc = 'clicked "' + beforeLabel + '" — animation is now PLAYING (button now shows "' + afterLabel + '")';
          } else if (isNowPaused) {
            actionDesc = 'clicked "' + beforeLabel + '" — animation is now PAUSED (button now shows "' + afterLabel + '")';
            // SAFETY: force-clear ALL intervals to handle generated code's toggle race condition
            if (window.__clearAllIntervals) window.__clearAllIntervals();
          } else {
            actionDesc = 'clicked "' + beforeLabel + '" (button changed to "' + afterLabel + '")';
          }
        } else {
          actionDesc = '"' + (afterLabel || beforeLabel) + '" clicked';
        }

        window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
      }, 50);
    });

    document.addEventListener('change', (e) => {
      let target = e.target;
      const interactiveEl = target.closest('input, select');
      if (!interactiveEl) return;
      let label = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
      if (!label || label.length > 50) return;
      let actionDesc = '"' + label + '" changed to "' + interactiveEl.value + '"';
      window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
    });
  </script>

</head>
<body class="${isSidebarOpen ? 'sidebar-open' : ''}">
  <div class="layout-container">
    <div class="svg-area">
      ${(currentTitle || currentSubtitle) ? `
        <div style="margin-bottom: 24px; width: 100%; flex-shrink: 0;">
          ${currentTitle ? `<h2 style="font-size: 30px; font-weight: 700; color: #1e293b; margin: 0 0 8px 0; letter-spacing: -0.025em;">${currentTitle}</h2>` : ''}
          ${currentSubtitle ? `<p style="font-size: 18px; color: #64748b; margin: 0;">${currentSubtitle}</p>` : ''}
        </div>
      ` : ''}
      <div style="flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; min-height: 0;">
        ${currentSvg}
      </div>
    </div>
    ${currentControls ? `
    <div class="controls-area">
      ${currentControls}
    </div>
    ` : ''}
  </div>
</body>
</html>
    `;
  }, [currentSvg, currentControls, currentTitle, currentSubtitle]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'SIDEBAR_TOGGLE', isOpen: isSidebarOpen }, '*');
    }
  }, [isSidebarOpen]);


  // Get source type icon
  const getSourceIcon = (type: SourceType) => {
    switch (type) {
      case 'youtube': return <YoutubeIcon className="w-4 h-4" />
      case 'url': return <LinkIcon className="w-4 h-4" />
      case 'file': return <FileUploadIcon className="w-4 h-4" />
      case 'text': return <TextIcon className="w-4 h-4" />
    }
  }

  // Phase indicator dot color
  const getPhaseDotClass = () => {
    switch (sessionPhase) {
      case 'analyzing': return 'status-dot analyzing'
      case 'designing': return 'status-dot designing'
      case 'complete': return 'status-dot complete'
      case 'conversation': return 'status-dot conversation'
      default: return 'status-dot idle'
    }
  }

  const isProcessing = sessionPhase === 'analyzing' || sessionPhase === 'designing'

  return (
    <>
      {currentPage === 'gallery' && user && (
        <GraphicsPage
          savedGraphics={savedGraphics}
          galleryLoading={galleryLoading}
          user={user}
          onOpenGraphic={(g) => {
            setCurrentSvg(g.svg_html)
            setCurrentControls(g.controls_html || null)
            setCurrentTitle(g.title)
            setCurrentSubtitle(g.subtitle || null)
            narrationContextRef.current = g.narration_context || ''
            sourceLabelsRef.current = g.source_labels || []
            // Reconstruct sources so the left panel shows the original links
            setSources((g.source_labels || []).map((label, i) => {
              const l = label.toLowerCase()
              const type: SourceType = l.startsWith('youtube:') ? 'youtube'
                : l.startsWith('http') ? 'url'
                  : (l.startsWith('file:') || l.endsWith('.pdf') || l.endsWith('.txt')) ? 'file'
                    : 'text'
              const content = label.replace(/^(youtube|url|file|text):\s*/i, '')
              const displayLabel = type === 'youtube'
                ? `https://youtube.com/watch?v=${content}`
                : content
              return { id: `loaded-${i}`, type, content, label: displayLabel }
            }))
            setSessionPhase('complete')
            setCurrentPage('home')
          }}
          onDeleteGraphic={(id) => setSavedGraphics(prev => prev.filter(x => x.id !== id))}
          onBack={() => setCurrentPage('home')}
        />
      )}
      <div className="app-wrapper" style={{ display: currentPage === 'gallery' ? 'none' : undefined }}>
        <header className="app-header">
          <div className="app-logo flex items-center gap-3">
            <NarlugaLogo className="w-11 h-11 drop-shadow-sm" />
            <span className="text-2xl font-extrabold tracking-tighter text-slate-800">
              Narluga
            </span>
          </div>

          <div className="flex items-center gap-4">
            {sessionPhase === 'conversation' && (
              <div className="live-badge">
                <span className="pulse-dot"></span> Live Chat
              </div>
            )}
            {isFirebaseConfigured && (
              user ? (
                <div className="relative" ref={accountMenuRef}>
                  <button
                    onClick={() => setShowAccountMenu(!showAccountMenu)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-full hover:bg-white/60 transition-all cursor-pointer border border-transparent hover:border-slate-200"
                  >
                    {user.photoURL ? (
                      <img
                        src={user.photoURL}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-8 h-8 rounded-full border border-slate-200"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center text-sm font-semibold">
                        {(user.displayName || user.email || '?')[0].toUpperCase()}
                      </div>
                    )}
                    <span className="text-sm text-slate-600 hidden sm:inline font-medium">{user.displayName?.split(' ')[0]}</span>
                  </button>

                  {/* Account Dropdown */}
                  {showAccountMenu && (
                    <div className="account-dropdown">
                      {/* User Info */}
                      <div className="px-4 py-3 border-b border-slate-100">
                        <p className="text-sm font-semibold text-slate-800">{user.displayName}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{user.email}</p>
                      </div>

                      {/* My Graphics nav link */}
                      <div className="px-2 py-2">
                        <button
                          onClick={() => { setCurrentPage('gallery'); setShowAccountMenu(false) }}
                          className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors text-sm text-slate-700 font-medium group"
                        >
                          <span>My Graphics</span>
                          <span className="flex items-center gap-1.5 text-slate-400 group-hover:text-slate-600 transition-colors">
                            {savedGraphics.length > 0 && <span className="source-count">{savedGraphics.length}</span>}
                            <span className="text-base leading-none">→</span>
                          </span>
                        </button>
                      </div>

                      {/* Sign Out */}
                      <div className="border-t border-slate-100 px-4 py-2">
                        <button
                          onClick={() => { firebaseSignOut(); setShowAccountMenu(false) }}
                          className="w-full text-left text-sm text-slate-500 hover:text-red-500 py-1.5 transition-colors"
                        >
                          Sign out
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={async () => {
                    try { await signInWithGoogle() } catch (e: any) { setError(e.message) }
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all text-sm font-medium text-slate-700"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                  Sign in with Google
                </button>
              )
            )}
          </div>
        </header>

        <main className="app-container">
          <section className="dashboard-layout-nblm">
            {/* LEFT PANEL: Sources */}
            <div
              className="nblm-card flex basis-[320px] max-w-[320px] shrink-0 relative overflow-hidden"
              style={{ display: isSidebarOpen ? 'flex' : 'none' }}
            >
              <div className="nblm-header">
                <span>Sources</span>
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="absolute top-[12px] right-[12px] w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors z-10" style={{ background: '#f1f5f9', color: '#475569' }} title="Collapse sidebar">
                <ChevronLeftIcon className="w-5 h-5" />
              </button>
              <div className="flex-1 overflow-auto flex flex-col p-4 relative">

                {/* Phase: idle or complete — show source manager */}
                {(sessionPhase === 'idle' || sessionPhase === 'complete') && !isProcessing && (
                  <div className="sidebar-input-area">
                    {/* Main input bar */}
                    <form onSubmit={addSource} className="url-form">
                      <div className="url-input-wrapper shadow-none">
                        <input
                          type="text"
                          placeholder="Paste a URL or YouTube video link"
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          className="url-input"
                          disabled={isConnecting}
                        />
                        {inputValue.trim() && (
                          <button type="submit" className="enter-icon-btn" title="Add source">
                            <PlusIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </form>

                    {/* Source type chips */}
                    <div className="source-chips">
                      <button
                        className="source-chip"
                        onClick={() => setShowTextArea(!showTextArea)}
                        title="Add text/notes"
                      >
                        <TextIcon className="w-4 h-4" /> Text
                      </button>
                      <button
                        className="source-chip"
                        onClick={() => fileInputRef.current?.click()}
                        title="Upload a file"
                      >
                        <FileUploadIcon className="w-4 h-4" /> Upload
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".txt,.md,.pdf"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => handleFileUpload(e.target.files)}
                      />
                    </div>

                    {/* Text area (expanded) */}
                    {showTextArea && (
                      <div className="text-source-area">
                        <textarea
                          placeholder="Paste your notes, text content, or describe a topic..."
                          value={textAreaValue}
                          onChange={(e) => setTextAreaValue(e.target.value)}
                          className="text-source-textarea"
                          rows={4}
                        />
                        <div className="flex gap-2 mt-2">
                          <button
                            className="btn-sm-primary"
                            onClick={addTextSource}
                            disabled={!textAreaValue.trim()}
                          >
                            Add Text
                          </button>
                          <button
                            className="btn-sm-secondary"
                            onClick={() => { setShowTextArea(false); setTextAreaValue('') }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Source roster */}
                    {sources.length > 0 && (
                      <div className="source-roster">
                        <div className="source-roster-header">
                          <span className="source-roster-title">Added Sources</span>
                          <span className="source-count">{sources.length}</span>
                        </div>
                        {sources.map(source => {
                          const isEditing = editingSourceId === source.id
                          const href = !isEditing && (source.type === 'youtube' || source.type === 'url')
                            ? source.label
                            : undefined
                          const saveEdit = () => {
                            updateSource(source.id, editingValue)
                            setEditingSourceId(null)
                          }
                          const cancelEdit = () => setEditingSourceId(null)
                          return (
                            <div key={source.id} className={`source-item${isEditing ? ' editing' : ''}`}>
                              <div className="source-item-icon">{getSourceIcon(source.type)}</div>
                              {isEditing ? (
                                <input
                                  className="source-item-edit-input"
                                  value={editingValue}
                                  onChange={e => setEditingValue(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit() }}
                                  onBlur={saveEdit}
                                  autoFocus
                                />
                              ) : href ? (
                                <a href={href} target="_blank" rel="noopener noreferrer" className="source-item-label" style={{ color: 'var(--accent-primary)', textDecoration: 'none' }} onClick={e => e.stopPropagation()}>{source.label}</a>
                              ) : (
                                <span className="source-item-label">{source.label}</span>
                              )}
                              {!isEditing && (
                                <button
                                  className="source-remove-btn"
                                  onClick={() => { setEditingSourceId(source.id); setEditingValue(source.label) }}
                                  title="Edit source"
                                  style={{ marginRight: 2 }}
                                >
                                  <PencilIcon className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                className="source-remove-btn"
                                onClick={() => isEditing ? cancelEdit() : removeSource(source.id)}
                                title={isEditing ? 'Cancel' : 'Remove source'}
                              >
                                <XIcon className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Clear all sources */}
                    {sources.length > 0 && (
                      <button
                        onClick={() => { setSources([]); resetSession() }}
                        className="w-full mt-2 py-1.5 text-xs text-slate-400 hover:text-red-400 border border-dashed border-slate-200 hover:border-red-200 rounded-lg transition-colors"
                      >
                        Clear All Sources
                      </button>
                    )}



                    {/* Generate button */}
                    {sources.length > 0 && sessionPhase === 'idle' && (
                      <div className="button-group w-full mt-4">
                        <button
                          className="btn-primary w-full justify-center"
                          onClick={startSession}
                          disabled={isConnecting}
                        >
                          {isConnecting
                            ? <span className="spinner"></span>
                            : <><SparklesIcon className="w-5 h-5" /> Create Interactive Graphic</>
                          }
                        </button>
                      </div>
                    )}

                    {/* Empty state hint */}
                    {sources.length === 0 && !showTextArea && (
                      <div className="empty-state-hint">
                        <DisplayIcon className="w-10 h-10 mb-3 opacity-20" />
                        <p>Add sources to generate an interactive graphic</p>
                        <p className="text-xs opacity-60 mt-1">URLs, YouTube videos, text, or files</p>
                      </div>
                    )}

                    {error && <p className="text-red-500 mt-4 text-sm text-center">{error}</p>}
                  </div>
                )}

                {/* Phase: analyzing or designing — show progress */}
                {isProcessing && (
                  <div className="sidebar-status-area">
                    <div className="status-indicator">
                      <div className={getPhaseDotClass()}></div>
                      <div className="status-text">
                        <span className="status-phase-label">
                          {sessionPhase === 'analyzing' ? 'Analyzing Sources' : 'Designing Interactive Graphic'}
                        </span>
                        <span className="status-detail">
                          {sessionPhase === 'analyzing'
                            ? `Processing ${sources.length} source${sources.length !== 1 ? 's' : ''}…`
                            : 'Takes ~30–60 seconds'}
                        </span>
                      </div>
                    </div>

                    {/* Source summary during processing */}
                    <div className="source-roster mt-6">
                      <div className="source-roster-header">
                        <span className="source-roster-title">Sources</span>
                        <span className="source-count">{sources.length}</span>
                      </div>
                      {sources.map(source => (
                        <div key={source.id} className="source-item processing">
                          <div className="source-item-icon">{getSourceIcon(source.type)}</div>
                          <span className="source-item-label">{source.label}</span>
                          {sessionPhase === 'designing' && (
                            <CheckCircleIcon className="w-4 h-4 text-emerald-500 ml-auto shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => { disconnect(); setSessionPhase('idle'); }}
                      className="w-full mt-4 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-all duration-200 text-sm font-medium"
                    >
                      Cancel Generation
                    </button>
                  </div>
                )}

                {/* Phase: complete — show action buttons */}
                {sessionPhase === 'complete' && (
                  <div className="sidebar-actions-area">
                    <div className="status-indicator mb-6">
                      <div className={getPhaseDotClass()}></div>
                      <div className="status-text">
                        <span className="status-phase-label">Graphic Ready!</span>
                        <span className="status-detail">Your interactive graphic is ready to explore</span>
                      </div>
                    </div>

                    {!hasStarted && (
                      <button
                        onClick={startPresentation}
                        className="w-full py-3 px-6 bg-[var(--accent-primary)] hover:bg-[#0a48ad] text-white rounded-full font-semibold transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
                      >
                        <MicIcon className="w-5 h-5" /> Start Live Conversation
                      </button>
                    )}

                    <button
                      onClick={resetSession}
                      className="w-full py-2.5 px-6 mt-3 bg-white border border-slate-200 text-slate-600 rounded-full font-medium transition-all flex items-center justify-center gap-2 hover:bg-slate-50 hover:border-slate-300"
                    >
                      <RefreshIcon className="w-4 h-4" /> New Graphic
                    </button>

                  </div>
                )}

                {/* Phase: conversation — show live indicator */}
                {sessionPhase === 'conversation' && (
                  <div className="sidebar-actions-area">
                    <div className="status-indicator mb-6">
                      <div className={getPhaseDotClass()}></div>
                      <div className="status-text">
                        <span className="status-phase-label">Live Conversation</span>
                        <span className="status-detail">Ask questions about the graphic</span>
                      </div>
                    </div>

                    <div className="conversation-hint">
                      <MicIcon className="w-8 h-8 opacity-30 mb-3" />
                      <p>Speak to ask questions about any part of the graphic</p>
                      <p className="text-xs opacity-60 mt-1">Click on elements in the graphic to explore</p>
                    </div>

                    <button
                      onClick={disconnect}
                      className="w-full py-2.5 px-6 mt-3 bg-red-50 border border-red-200 text-red-500 rounded-full font-medium transition-all flex items-center justify-center gap-2 hover:bg-red-100 hover:border-red-300"
                    >
                      <StopIcon className="w-4 h-4" /> End Conversation
                    </button>

                  </div>
                )}
              </div>
            </div>

            {/* MIDDLE PANEL: Interactive Graphic */}
            <div className="nblm-card flex-1 flex flex-col relative w-full h-full">
              {!isSidebarOpen && (
                <button onClick={() => setIsSidebarOpen(true)} className="absolute top-[12px] left-[12px] w-8 h-8 bg-slate-100 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors text-slate-600 z-10" title="Expand sidebar">
                  <ChevronRightIcon className="w-5 h-5" />
                </button>
              )}
              <div className="nblm-header flex items-center">
                <span className={`flex items-center gap-2 text-[var(--accent-primary)] transition-all ${!isSidebarOpen ? 'ml-8' : ''}`}>
                  <SparklesIcon className="w-5 h-5" /> Interactive Graphic
                </span>
              </div>

              {currentSvg ? (
                <div className="flex-1 overflow-hidden bg-transparent relative w-full h-full">
                  <iframe
                    ref={iframeRef}
                    srcDoc={iframeSrcDoc}
                    title="Interactive Graphic"
                    className="w-full h-full border-none"
                    sandbox="allow-scripts allow-same-origin"
                  />
                </div>
              ) : (
                <div className="flex-1 bg-transparent flex items-center justify-center">
                  <div className="bg-white p-12 flex flex-col items-center justify-center text-center max-w-[400px]">
                    {isProcessing ? (
                      <>
                        <div className="processing-spinner mb-6"></div>
                        <h3 className="text-xl font-medium text-[var(--text-primary)] mb-2">
                          {sessionPhase === 'analyzing' ? 'Analyzing Sources...' : 'Designing Interactive Graphic...'}
                        </h3>
                        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                          {sessionPhase === 'analyzing'
                            ? 'Reading and understanding your sources...'
                            : 'This usually takes 30–60 seconds'}
                        </p>
                      </>
                    ) : (
                      <>
                        <DisplayIcon className="w-16 h-16 mb-6 opacity-20 text-[var(--accent-primary)]" />
                        <h3 className="text-xl font-medium text-[var(--text-primary)] mb-2">Interactive Graphic</h3>
                        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                          Add sources in the sidebar and click Generate. Interactive graphics will appear here.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
    </>
  )
}

export default App
