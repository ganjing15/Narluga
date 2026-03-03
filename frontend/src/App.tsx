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

// PCM worklet code extracted so it can be pre-loaded before the user clicks Start
const PCM_WORKLET_CODE = `
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
`

// Source types
type SourceType = 'url' | 'youtube' | 'text' | 'file'
type Source = {
  id: string
  type: SourceType
  content: string
  label: string
}
type SearchResult = {
  title: string
  url: string
  snippet: string
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

  // Web search panel
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedSearchUrls, setSelectedSearchUrls] = useState<Set<string>>(new Set())
  const [showSearchPanel, setShowSearchPanel] = useState(false)

  // Session state
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('idle')
  const [, setStatusMessage] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [isStartingConversation, setIsStartingConversation] = useState(false)
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
    // Reset iframe ready state when loading new graphic
    iframeReadyRef.current = false
    pendingToolActionsRef.current = []
  }
  const [currentControls, _setCurrentControls] = useState<string | null>(null)
  const currentControlsRef = useRef<string | null>(null)
  const setCurrentControls = (controls: string | null) => {
    currentControlsRef.current = controls
    _setCurrentControls(controls)
  }
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null)
  const [groundingSources, setGroundingSources] = useState<{ title: string, url: string }[]>([])
  const [researchMode, setResearchMode] = useState<'off' | 'fast' | 'deep'>('fast')
  const narrationContextRef = useRef<string>('')
  const sourceLabelsRef = useRef<string[]>([])
  const controlsInventoryRef = useRef<string>('')

  // Refs
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null)
  const micAudioCtxRef = useRef<AudioContext | null>(null)
  const micReadyRef = useRef<boolean>(false)
  const workletPreloadedRef = useRef<boolean>(false)
  const hasStartedRef = useRef<boolean>(false)
  const eventQueueRef = useRef<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingToolActionsRef = useRef<Array<{action: string, params: any}>>([])
  const iframeReadyRef = useRef<boolean>(false)
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

  // Web search: find sources by query
  const performSearch = useCallback(async (query: string) => {
    if (!query.trim()) return
    setIsSearching(true)
    setSearchResults([])
    setSelectedSearchUrls(new Set())
    setShowSearchPanel(true)
    try {
      const token = await getIdToken()
      const res = await fetch(`${BACKEND_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ query: query.trim(), depth: researchMode === 'deep' ? 'deep' : 'fast' })
      })
      if (!res.ok) {
        const errText = await res.text()
        console.error('Search HTTP error', res.status, errText)
        return
      }
      const data = await res.json()
      setSearchResults(data.results || [])
    } catch (e) {
      console.error('Search failed', e)
    } finally {
      setIsSearching(false)
    }
  }, [researchMode])

  // Add selected search results as URL sources
  const addSelectedSearchSources = useCallback(() => {
    const toAdd = searchResults.filter(r => selectedSearchUrls.has(r.url))
    if (toAdd.length === 0) return

    // Create URL sources for the selected search results
    const newSources: Source[] = toAdd.map(r => ({
      id: crypto.randomUUID(),
      type: is_youtube_url_ts(r.url) ? 'youtube' : 'url',
      content: r.url,
      label: r.title || r.url
    }))

    // Also add the original search query as a text source so the AI knows the intent
    if (searchQuery.trim()) {
      newSources.unshift({
        id: crypto.randomUUID(),
        type: 'text',
        content: `Web Search Query: ${searchQuery.trim()}`,
        label: `🔍 ${searchQuery.trim()}`
      });
    }

    setSources(prev => [...prev, ...newSources])
    setShowSearchPanel(false)
    setSearchResults([])
    setSelectedSearchUrls(new Set())
    setSearchQuery('')
  }, [searchResults, selectedSearchUrls, searchQuery])

  // Simple YouTube URL check (mirrors backend)
  function is_youtube_url_ts(url: string): boolean {
    return /youtube\.com\/watch|youtu\.be\//.test(url)
  }

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
    workletPreloadedRef.current = false
    hasStartedRef.current = false
    // Tell backend to end Gemini session, but keep WS alive for fast reconnect
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end_live_session" }))
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
    setIsStartingConversation(false)
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
    setIsStartingConversation(true)

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Fast path: WS already open (from graphic generation)
      // Need mic before we can proceed
      if (!streamRef.current) {
        try {
          streamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (err: any) {
          setIsStartingConversation(false)
          setError("Microphone permission is required to converse with the AI.");
          return;
        }
      }
      if (!audioCtxRef.current) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AC({ sampleRate: 24000 });
        nextPlayTimeRef.current = audioCtxRef.current.currentTime;
      }
      wsRef.current.send(JSON.stringify({
        type: "start_live_session",
        pre_events: eventQueueRef.current
      }))
      setHasStarted(true)
      setIsStartingConversation(false)
      hasStartedRef.current = true
      micReadyRef.current = true
      eventQueueRef.current = []
      if (audioCtxRef.current.state === 'suspended') {
        try { audioCtxRef.current.resume(); } catch (err) { }
      }
      setupMic()
    } else if (narrationContextRef.current) {
      // Reconnect path: no WS open (loaded graphic from gallery)
      // Run getUserMedia + getIdToken in PARALLEL to save ~500-800ms
      setIsConnecting(true)
      setError('')
      setStatusMessage('Connecting...')

      let stream: MediaStream
      let token: string | null
      try {
        [stream, token] = await Promise.all([
          streamRef.current
            ? Promise.resolve(streamRef.current)
            : navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
              }),
          getIdToken()
        ])
        streamRef.current = stream
      } catch (err: any) {
        setIsStartingConversation(false)
        setIsConnecting(false)
        setError("Microphone permission is required to converse with the AI.");
        return;
      }

      if (!audioCtxRef.current) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new AC({ sampleRate: 24000 });
        nextPlayTimeRef.current = audioCtxRef.current.currentTime;
      }

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
          controls_html: currentControlsRef.current || "",
          controls_inventory: controlsInventoryRef.current || ""
        }))
        // Set up mic BEFORE sending start_live_session so audio flows to Gemini
        // before the backend sends the initial prompt
        setHasStarted(true)
        setIsStartingConversation(false)
        hasStartedRef.current = true
        micReadyRef.current = true
        eventQueueRef.current = []

        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
          try { audioCtxRef.current.resume(); } catch (err) { }
        }

        setupMic()

        // Send start_live_session AFTER mic setup so backend waits for audio before prompting
        ws.send(JSON.stringify({
          type: "start_live_session",
          pre_events: eventQueueRef.current
        }))
      }

      // Reuse the same message/close/error handlers
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type !== 'audio') console.log('[WebSocket] Received message:', data.type, data);

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
        } else if (data.type === 'tool_action') {
          const { action, params } = data
          console.log('[Parent] Received tool_action:', action, params);

          // Handle fetch_more_detail indicator in the parent
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
          if (iframeRef.current && iframeRef.current.contentWindow && iframeReadyRef.current) {
            console.log('[Parent] Forwarding to iframe:', iframeRef.current.contentWindow);
            iframeRef.current.contentWindow.postMessage(
              { type: 'TOOL_ACTION', action, params }, '*'
            )
          } else {
            console.warn('[Parent] Iframe not ready, queuing tool_action:', action);
            pendingToolActionsRef.current.push({ action, params })
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

  // Helper: attach mic stream to the AudioWorklet processor and start streaming.
  // Fast path: AudioContext + module pre-loaded in the background → just create the node.
  // Slow path: full initialization (addModule) if pre-load didn't happen in time.
  const setupMic = () => {
    if (!streamRef.current) return

    const attachStream = async (micAudioCtx: AudioContext) => {
      try {
        if (micAudioCtx.state === 'suspended') await micAudioCtx.resume()
        const source = micAudioCtx.createMediaStreamSource(streamRef.current!)
        const processorNode = new AudioWorkletNode(micAudioCtx, 'pcm-processor')
        processorNode.port.onmessage = (e) => {
          const uint8Array = new Uint8Array(e.data)
          let binary = ''
          for (let i = 0; i < uint8Array.byteLength; i++) binary += String.fromCharCode(uint8Array[i])
          const base64Data = btoa(binary)
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && micReadyRef.current) {
            wsRef.current.send(JSON.stringify({
              realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Data }] }
            }))
          }
        }
        source.connect(processorNode)
        processorNode.connect(micAudioCtx.destination)
        audioWorkletNodeRef.current = processorNode
        micAudioCtxRef.current = micAudioCtx
      } catch (err) {
        console.error('Failed to connect mic to AudioWorklet:', err)
      }
    }

    if (micAudioCtxRef.current && workletPreloadedRef.current && !audioWorkletNodeRef.current) {
      // Fast path: worklet module already loaded — skip addModule entirely
      attachStream(micAudioCtxRef.current)
    } else if (!micAudioCtxRef.current) {
      // Slow path: pre-load didn't finish in time, do full init now
      ;(async () => {
        try {
          const micAudioCtx = new AudioContext({ sampleRate: 16000 })
          const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
          const url = URL.createObjectURL(blob)
          await micAudioCtx.audioWorklet.addModule(url)
          URL.revokeObjectURL(url)
          await attachStream(micAudioCtx)
        } catch (err) {
          console.error('Failed to start mic audio context:', err)
        }
      })()
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
      let serverErrorReceived = false  // track if backend sent a typed error

      ws.onopen = async () => {
        setIsConnecting(false)
        setStatusMessage('Sending sources...')

        // Send the sources array as the first message
        ws.send(JSON.stringify({
          type: "init_sources",
          research_mode: researchMode,
          sources: sources.map(s => ({
            type: s.type,
            content: s.content,
            label: s.label
          }))
        }))
      }

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.type !== 'audio') console.log('[WebSocket] Received message:', data.type, data);

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
          if (data.controls_inventory) controlsInventoryRef.current = data.controls_inventory
          // Improvement C: store generation-time grounding citations
          setGroundingSources(data.grounding_sources || [])

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
                created_at: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } as any,
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

          // Handle fetch_more_detail indicator in the parent
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
          if (iframeRef.current && iframeRef.current.contentWindow && iframeReadyRef.current) {
            console.log('[Parent] Forwarding to iframe:', action);
            iframeRef.current.contentWindow.postMessage(
              { type: 'TOOL_ACTION', action, params }, '*'
            )
          } else {
            console.warn('[Parent] Iframe not ready, queuing tool_action:', action);
            pendingToolActionsRef.current.push({ action, params })
          }
        } else if (data.type === 'grounding_sources') {
          // Improvement B: live fetch_more_detail citations — append to existing set
          if (data.sources && data.sources.length > 0) {
            setGroundingSources(prev => {
              const existing = new Set(prev.map((s: { url: string }) => s.url))
              const newSources = data.sources.filter((s: { url: string }) => !existing.has(s.url))
              return newSources.length > 0 ? [...prev, ...newSources] : prev
            })
          }
        } else if (data.type === 'error') {
          serverErrorReceived = true
          setError(data.message)
          disconnect()
        }
      }

      ws.onclose = (event) => {
        if (event.code === 1000 && event.reason) {
          setStatusMessage(event.reason)
        } else if (!serverErrorReceived && !event.wasClean && event.code !== 1000 && event.code !== 1005) {
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
    setGroundingSources([])
    narrationContextRef.current = ''
    sourceLabelsRef.current = []
    setSessionPhase('idle')
    setStatusMessage('')
    setError('')
  }, [disconnect])

  // Pre-load AudioWorklet module early (during designing phase) so it's ready
  // well before the user clicks "Start Live Conversation".
  useEffect(() => {
    if ((sessionPhase !== 'designing' && sessionPhase !== 'complete') || workletPreloadedRef.current || micAudioCtxRef.current) return
    ;(async () => {
      try {
        const micAudioCtx = new AudioContext({ sampleRate: 16000 })
        const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        await micAudioCtx.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        micAudioCtxRef.current = micAudioCtx
        workletPreloadedRef.current = true
        console.log('[Preload] AudioWorklet pre-loaded')
      } catch (err) {
        console.warn('[Preload] AudioWorklet pre-load failed:', err)
      }
      // Also pre-create playback AudioContext (will be suspended until user gesture)
      if (!audioCtxRef.current) {
        const AC = window.AudioContext || (window as any).webkitAudioContext
        audioCtxRef.current = new AC({ sampleRate: 24000 })
        nextPlayTimeRef.current = audioCtxRef.current.currentTime
      }
    })()
  }, [sessionPhase])

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

      // 2. Find the nearest <text> label — tight 20px radius only.
      // 150px was far too loose; 20px covers hovering near small/thin elements
      // without falsely reporting labels the cursor isn't actually close to.
      let nearestLabel = ''
      let nearestDist = 20
      container.querySelectorAll('text').forEach(textEl => {
        const content = (textEl.textContent || '').trim()
        if (content.length < 2 || content.length > 60) return
        const rect = textEl.getBoundingClientRect()
        const textCx = rect.left + rect.width / 2
        const textCy = rect.top + rect.height / 2
        const dist = Math.sqrt((cx - textCx) ** 2 + (cy - textCy) ** 2)
        if (dist < nearestDist) { nearestDist = dist; nearestLabel = content }
      })

      // Build the report — only direct hits and genuinely close labels
      let report = ''
      if (directLabel && directLabel.length >= 2) {
        report = `"${directLabel}"`
      } else if (nearestLabel) {
        report = `"${nearestLabel}"`
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
      // Allow CLICK_RESULT (sent by iframe after AI executes click_element)
      if (event.data?.type === 'CLICK_RESULT') {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && hasStartedRef.current) {
          if (!event.data.success) {
            wsRef.current.send(JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: `[Tool execution failed: The 'click_element' tool could not find any button matching "${event.data.keyword}". Tell the user you couldn't find the button, or try again with a different exact button name from the controls panel.]` }] }],
                turnComplete: true
              }
            }));
          } else {
            // Build explicit feedback about what action was performed
            let feedbackMsg = `[Tool execution success: `;

            if (event.data.newLabel && event.data.newLabel !== event.data.clickedLabel) {
              const newLabelLower = event.data.newLabel.toLowerCase();
              
              // Determine what action was actually performed based on the result
              if (newLabelLower.includes('pause') || newLabelLower.includes('stop') || newLabelLower.includes('⏸')) {
                // Button now says "Pause" = animation is playing = user clicked Play
                feedbackMsg += `You clicked "${event.data.clickedLabel}" and STARTED the animation. It is now PLAYING. Don't re-explain what you already said - just briefly confirm it's running.`;
              } else if (newLabelLower.includes('play') || newLabelLower.includes('start') || newLabelLower.includes('▶')) {
                // Button now says "Play" = animation is paused = user clicked Pause
                feedbackMsg += `You clicked "${event.data.clickedLabel}" and PAUSED the animation. It is now STOPPED.`;
                
                // Include current slider values when paused
                if (event.data.sliderValues && event.data.sliderValues.length > 0) {
                  const sliderInfo = event.data.sliderValues.map((s: any) => `${s.label}: ${s.value}`).join(', ');
                  feedbackMsg += ` Current position: ${sliderInfo}.`;
                }
              } else {
                feedbackMsg += `You clicked "${event.data.clickedLabel}". The button changed to "${event.data.newLabel}".`;
              }
            } else {
              feedbackMsg += `You clicked "${event.data.clickedLabel}".`;
            }
            feedbackMsg += `]`;

            wsRef.current.send(JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: feedbackMsg }] }],
                turnComplete: false
              }
            }));
          }
        }
      }
      // Handle iframe ready signal and replay queued tool actions
      else if (event.data?.type === 'IFRAME_READY') {
        console.log('[Parent] Iframe is ready, replaying', pendingToolActionsRef.current.length, 'queued actions');
        iframeReadyRef.current = true;
        
        // Replay all queued tool actions
        if (iframeRef.current && iframeRef.current.contentWindow) {
          pendingToolActionsRef.current.forEach(({ action, params }) => {
            console.log('[Parent] Replaying queued action:', action);
            iframeRef.current!.contentWindow!.postMessage(
              { type: 'TOOL_ACTION', action, params }, '*'
            );
          });
          pendingToolActionsRef.current = [];
        }
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, []);

  // Security: Sanitize SVG content to remove scripts and event handlers
  const sanitizeSvg = useCallback((svgHtml: string): string => {
    // Remove script tags
    let sanitized = svgHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove event handler attributes (onclick, onload, etc.)
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');
    
    // Remove javascript: URLs
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // Remove data: URLs (can contain scripts)
    sanitized = sanitized.replace(/href\s*=\s*["']data:[^"']*["']/gi, 'href="#"');
    sanitized = sanitized.replace(/src\s*=\s*["']data:[^"']*["']/gi, 'src=""');
    
    return sanitized;
  }, []);

  // Security: Sanitize controls HTML
  const sanitizeControls = useCallback((controlsHtml: string): string => {
    // NOTE: We allow <script> tags, onclick/oninput handlers in controls because:
    // 1. They're essential for interactivity (togglePlay, updateState functions)
    // 2. CSP already prevents malicious inline scripts from doing harm
    // 3. User only sees their own graphics (no cross-user attacks)
    // 4. AI-generated code needs to run for graphics to be interactive
    
    // Only remove javascript: URLs (minimal sanitization)
    let sanitized = controlsHtml.replace(/javascript:/gi, '');
    
    return sanitized;
  }, []);

  // Construct a secure, isolated HTML document for the graphic and controls
  const iframeSrcDoc = useMemo(() => {
    if (!currentSvg) return '';
    
    // Sanitize SVG and controls before embedding
    const safeSvg = sanitizeSvg(currentSvg);
    const safeControls = currentControls ? sanitizeControls(currentControls) : '';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
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
    /* Fix: CSS animations that set 'transform' override SVG transform attributes,
       causing positioned elements to snap to the origin. animation-composition: add
       makes animations ADD to the base SVG transform instead of replacing it. */
    svg [transform] {
      animation-composition: add;
    }
  </style>
  
  <script>
    // --- INTERVAL TRACKING ---
    // Monkey-patch setInterval/clearInterval to track all intervals created by generated code.
    // This prevents the interval-stacking bug where multiple setIntervals accumulate
    // because generated togglePlay()/stopAutoPlay() has a race condition.
    // Store Intervals globally so we can wipe them on AI commands
    window.__trackedIntervals = new Set();
    const originalSetInterval = window.setInterval;
    window.setInterval = function(handler, timeout, ...args) {
      const id = originalSetInterval(handler, timeout, ...args);
      window.__trackedIntervals.add(id);
      return id;
    };
    
    // Bubble up iframe script errors so the AI and developer can see them
    window.onerror = function(msg, url, lineNo, columnNo, error) {
      console.error("[IFRAME ERROR]", msg, "at line", lineNo, ":", columnNo);
      return false; // let default handler run too
    };

    window.__clearAllIntervals = function() {
      window.__trackedIntervals.forEach(id => clearInterval(id));
      window.__trackedIntervals.clear();
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

        // Score matches: exact match > starts with > word boundary > contains
        const scoreMatch = (str, keyword) => {
          if (!str) return 0;
          const s = str.toLowerCase().replace(/[-_]/g, ' ').trim();
          if (s === keyword) return 100; // exact match
          if (s.startsWith(keyword + ' ') || s === keyword) return 90; // starts with word boundary
          if (s.startsWith(keyword)) return 50; // starts with
          if (s.includes(' ' + keyword + ' ') || s.endsWith(' ' + keyword)) return 40; // word boundary
          if (s.includes(keyword)) return 25; // contains
          return 0;
        };

        // First pass: look for elements with id/label/section attributes
        svgContainer.querySelectorAll('[id], [data-label], [data-section]').forEach(el => {
          const id = (el.id || '').toLowerCase().replace(/[-_]/g, ' ');
          const label = (el.getAttribute('data-label') || '').toLowerCase();
          const section = (el.getAttribute('data-section') || '').toLowerCase();
          
          const idScore = scoreMatch(id, kw);
          const labelScore = scoreMatch(label, kw);
          const sectionScore = scoreMatch(section, kw);
          const maxScore = Math.max(idScore, labelScore, sectionScore);
          
          if (maxScore > 0 && !isTooLarge(el)) {
            // Boost score for visual elements (shapes) vs text/labels
            const isVisualElement = ['circle', 'ellipse', 'rect', 'path', 'polygon', 'line'].includes(el.tagName.toLowerCase());
            const isGroup = el.tagName.toLowerCase() === 'g';
            
            // Prefer actual shapes over groups (groups might contain multiple things)
            let finalScore = maxScore;
            if (isVisualElement) {
              finalScore = maxScore * 3; // Highest priority for actual shapes
            } else if (isGroup) {
              finalScore = maxScore * 1; // Lowest priority for groups
            } else {
              finalScore = maxScore * 2; // Medium priority for other elements
            }
            
            results.push({ el, score: finalScore });
          }
        });

        // Second pass: if no good matches, search text content
        if (results.length === 0) {
          svgContainer.querySelectorAll('text, tspan, foreignObject, h1, h2, h3, h4, p, span, label, button').forEach(el => {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.length > 0 && text.length < 200) {
              const textScore = scoreMatch(text, kw);
              if (textScore > 0) {
                let target = el;
                if (el instanceof SVGElement && el.parentElement && el.parentElement.tagName.toLowerCase() === 'g') {
                  target = el.parentElement;
                }
                if (!isTooLarge(target) && !results.find(r => r.el === target)) {
                  results.push({ el: target, score: textScore * 0.5 }); // Lower priority for text matches
                }
              }
            }
          });
        }

        // Sort by score (highest first), then by size (smallest first for same score)
        results.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          // For same score, prefer shorter element IDs (more specific)
          const aId = (a.el.id || a.el.getAttribute('data-label') || '').length;
          const bId = (b.el.id || b.el.getAttribute('data-label') || '').length;
          if (aId !== bId) return aId - bId;
          // Then prefer smaller visual size
          const aRect = a.el.getBoundingClientRect();
          const bRect = b.el.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        });

        return results.slice(0, 3).map(r => r.el);
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
        
        // Security: Whitelist of safe CSS properties
        const safeCssProperties = [
          'fill', 'stroke', 'opacity', 'stroke-width', 'r', 'cx', 'cy', 'x', 'y', 
          'width', 'height', 'display', 'scale', 'transform', 'filter', 
          'color', 'background-color', 'font-size', 'font-weight'
        ];
        
        // Security: Block dangerous CSS values
        const isDangerousValue = (value) => {
          const dangerous = [
            /javascript:/i,
            /data:/i,
            /<script/i,
            /expression\\(/i,  // Escape the parenthesis
            /import\\s/i,
            /url\\(/i  // Block external resources
          ];
          return dangerous.some(pattern => pattern.test(value));
        };
        
        if (!safeCssProperties.includes(prop)) {
          console.warn('[Security] Blocked unsafe CSS property:', prop);
          return;
        }
        
        if (isDangerousValue(val)) {
          console.warn('[Security] Blocked dangerous CSS value:', val);
          return;
        }
        
        elements.forEach(el => {
          el.style.transition = 'all 0.5s ease';
          if (el instanceof SVGElement && ['fill', 'stroke', 'opacity', 'stroke-width', 'r', 'cx', 'cy', 'x', 'y', 'width', 'height', 'display'].includes(prop)) {
            // Direct SVG attribute modification
            el.setAttribute(prop, val);
          } else if (prop === 'scale' && el instanceof SVGElement) {
            // Special handling for scale: use SVG transform attribute to avoid position shift
            try {
              const bbox = el.getBBox();
              const cx = bbox.x + bbox.width / 2;
              const cy = bbox.y + bbox.height / 2;
              
              // Get existing transform or create new one
              const existingTransform = el.getAttribute('transform') || '';
              // Remove any existing scale transforms
              const withoutScale = existingTransform.replace(/scale\\([^)]*\\)/g, '').trim();
              // Add new scale transform centered on element
              const newTransform = (withoutScale + ' translate(' + cx + ', ' + cy + ') scale(' + val + ') translate(' + (-cx) + ', ' + (-cy) + ')').trim();
              el.setAttribute('transform', newTransform);
            } catch (e) {
              // Fallback to CSS if getBBox fails
              el.style.transform = 'scale(' + val + ')';
              el.style.transformOrigin = 'center';
              el.style.transformBox = 'fill-box';
            }
          } else {
            // CSS property modification
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
          window.parent.postMessage({ type: 'CLICK_RESULT', success: false, keyword: '', clickedLabel: null, newLabel: null }, '*');
          return;
        }
        // FIX: The AI often sends tool commands immediately after generating the graphic,
        // arriving via WebSocket BEFORE the browser has actually finished parsing and rendering
        // the iframe's srcdoc HTML. We must poll the DOM for readiness.
        let attempts = 0;
        const maxAttempts = 15; // 1.5 seconds max wait
        
        const tryClick = () => {
          attempts++;
          const containers = [document.body];
          let clicked = false;
          let matchedLabel = null;
          let clickedElement = null;
          
          // Check if DOM actually has content yet by looking for ANY element
          const domReady = document.querySelectorAll('*').length > 10;
          
          if (!domReady && attempts < maxAttempts) {
              console.log("[IFRAME TOOL] DOM not ready yet (attempt " + attempts + "), waiting 100ms...");
              setTimeout(tryClick, 100);
              return;
          }

          containers.forEach(container => {
            if (clicked) return;
            const candidates = container.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="range"], a, [onclick], [role="button"]');
            console.log("[IFRAME TOOL] Number of clickable candidates found in document (attempt " + attempts + "): " + candidates.length);
            
            // If no buttons exist AND we haven't timed out, wait for React/iframe to render
            if (candidates.length === 0 && attempts < maxAttempts) {
                setTimeout(tryClick, 100);
                return; // Break out of this specific container loop attempt
            }

            candidates.forEach(el => {
              if (clicked) return;
              const text = (el.textContent || '').toLowerCase().trim();
              const id = (el.id || '').toLowerCase();
              const title = (el.getAttribute('title') || '').toLowerCase();
              const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
              const matchText = text && (text.includes(kw) || kw.includes(text));
              const matchId = id && (id === kw || id.includes(kw) || kw.includes(id));
              const matchTitle = title && (title.includes(kw) || kw.includes(title));
              const matchAria = ariaLabel && (ariaLabel.includes(kw) || kw.includes(ariaLabel));
              
              // Allow loose matching for play/pause intents since button text varies widely
              const isPlayPauseKw = ['play', 'pause', 'start', 'stop', 'resume', 'auto'].some(w => kw.includes(w));
              const isPlayPauseBtn = text && ['play', 'pause', 'start', 'stop', 'resume', 'auto', '▶', '⏸'].some(w => text.includes(w));
              const semanticMatch = isPlayPauseKw && isPlayPauseBtn;
              
              // Exact ID match is the strongest signal
              const exactIdMatch = id === kw;
              
              console.log("  -> Checking element: <" + el.tagName + "> id='" + id + "' text='" + text + "'. Match? " + !!(exactIdMatch || matchText || matchId || matchTitle || matchAria || semanticMatch));
              
              if (exactIdMatch || matchText || matchId || matchTitle || matchAria || semanticMatch) {
                matchedLabel = (el.textContent || el.id || '').trim();
                clickedElement = el;
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
                     
                     // Set flag to prevent duplicate INTERACTION_EVENT
                     window.__aiClickInProgress = true;
                     
                     // Use native click to try triggering event listeners
                     el.click();
                     
                     // After clicking, wait a moment for the button text to update, then report the new state
                     setTimeout(() => {
                       const newLabel = (el.textContent || '').trim();
                       
                       // Capture current slider values
                       const sliders = document.querySelectorAll('input[type="range"]');
                       const sliderValues = [];
                       sliders.forEach(slider => {
                         const sliderLabel = slider.getAttribute('aria-label') || slider.getAttribute('title') || slider.id || 'slider';
                         sliderValues.push({ label: sliderLabel, value: slider.value });
                       });
                       
                       window.parent.postMessage({
                         type: 'CLICK_RESULT',
                         success: true,
                         keyword: kw,
                         clickedLabel: matchedLabel,
                         newLabel: newLabel,
                         sliderValues: sliderValues
                       }, '*');
                       
                       // Clear the flag after reporting
                       window.__aiClickInProgress = false;
                     }, 100);
                     return; // Exit early since we're handling the postMessage in the timeout
                  }
                }, 300);
                clicked = true;
              }
            });
          });

          // Report click result back to parent only if we actually finished searching (and matched or timed out)
          if (clicked || attempts >= maxAttempts) {
              if (!clicked) {
                console.warn("[IFRAME TOOL] click_element: NO match found for keyword '" + kw + "' after " + attempts + " attempts.");
                window.parent.postMessage({
                  type: 'CLICK_RESULT',
                  success: false,
                  keyword: kw,
                  clickedLabel: null,
                  newLabel: null
                }, '*');
              }
              // For non-button clicks (sliders, etc), send result immediately
              else if (clickedElement && clickedElement.tagName.toLowerCase() === 'input' && clickedElement.type === 'range') {
                window.parent.postMessage({
                  type: 'CLICK_RESULT',
                  success: true,
                  keyword: kw,
                  clickedLabel: matchedLabel,
                  newLabel: matchedLabel
                }, '*');
              }
          }
        };

        // Start the polling cycle
        tryClick();
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

      // --- Controls panel hover ---
      const controlsContainer = document.querySelector('.controls-area');
      if (controlsContainer && controlsContainer.contains(target)) {
        // Cursor is on the controls panel — describe the control element, not the SVG graphic.
        // Cancel any pending SVG hover report so the stale graphic description doesn't fire.
        if (debounceTimer) clearTimeout(debounceTimer);
        const interactiveEl = target.closest('button, input, select, label, [role="button"]');
        let controlReport = '';
        if (interactiveEl) {
          const label = (interactiveEl.innerText || interactiveEl.getAttribute('aria-label') || interactiveEl.getAttribute('title') || interactiveEl.id || '').trim();
          const kind = interactiveEl.tagName.toLowerCase() === 'input' && interactiveEl.type === 'range' ? 'slider'
            : interactiveEl.tagName.toLowerCase() === 'select' ? 'dropdown'
            : 'button';
          if (label && label.length >= 2 && label.length <= 60) {
            controlReport = 'the "' + label + '" ' + kind + ' in the controls panel';
          }
        }
        if (!controlReport) controlReport = 'the controls panel';
        if (controlReport === lastReport) return;
        lastReport = controlReport;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          window.parent.postMessage({ type: 'HOVER_EVENT', payload: controlReport }, '*');
        }, 1500);
        return;
      }

      // --- SVG graphic hover ---
      if (!svgContainer.contains(target)) {
        // Cursor left both areas — cancel stale pending report
        if (debounceTimer) clearTimeout(debounceTimer);
        lastReport = '';
        return;
      }

      // Priority 1: Direct label attributes
      const directLabel = target.getAttribute('data-label') || target.getAttribute('id') || '';
      
      // Priority 2: Check for <title> element inside the target (SVG accessibility)
      let titleText = '';
      if (target.querySelector) {
        const titleEl = target.querySelector('title');
        if (titleEl) titleText = (titleEl.textContent || '').trim();
      }
      
      // Priority 3: Check parent group's id or class
      let parentLabel = '';
      const parentGroup = target.closest('g[id], g[class]');
      if (parentGroup) {
        parentLabel = parentGroup.getAttribute('id') || parentGroup.getAttribute('class') || '';
        // Clean up class names (remove technical prefixes)
        parentLabel = parentLabel.replace(/^(svg-|graphic-|element-)/, '');
      }
      
      // Priority 4: nearest text label — but only within a tight 20px radius.
      // 60px was too loose and caused the AI to report labels the cursor wasn't near.
      let nearestLabel = '';
      let nearestDist = 20;
      if (!directLabel && !titleText && !parentLabel) {
        svgContainer.querySelectorAll('text').forEach(textEl => {
          const content = (textEl.textContent || '').trim();
          if (content.length < 2 || content.length > 60) return;
          const rect = textEl.getBoundingClientRect();
          const textCx = rect.left + rect.width / 2;
          const textCy = rect.top + rect.height / 2;
          const dist = Math.sqrt((e.clientX - textCx) ** 2 + (e.clientY - textCy) ** 2);
          if (dist < nearestDist) { nearestDist = dist; nearestLabel = content; }
        });
      }

      let report = '';
      if (directLabel && directLabel.length >= 2) {
        report = '"' + directLabel + '"';
      } else if (titleText && titleText.length >= 2) {
        report = '"' + titleText + '"';
      } else if (parentLabel && parentLabel.length >= 2) {
        report = '"' + parentLabel + '"';
      } else if (nearestLabel) {
        report = '"' + nearestLabel + '"';
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
    
    // Track AI-triggered clicks to avoid duplicate event reporting
    window.__aiClickInProgress = false;
    
    // IMPORTANT: {capture: true} so this fires BEFORE any button's own click handler runs.
    // Without it, the listener fires in the bubbling phase — AFTER the button may have
    // already synchronously updated its own text (e.g. "▶ Play" → "⏸ Pause"), which
    // causes beforeLabel to capture the POST-click label and inverts the reported state.
    document.addEventListener('click', (e) => {
      // Skip non-trusted (programmatic) clicks — these come from animation code resetting
      // its own button state (e.g., auto-play cycle end) and must not be reported as user actions.
      if (!e.isTrusted) return;
      // Skip if this click was triggered by the AI's click_element tool
      if (window.__aiClickInProgress) {
        return;
      }

      let target = e.target;
      const interactiveEl = target.closest('button, a, input, select, [role="button"]');
      if (!interactiveEl) return;

      // Capture the BEFORE label immediately (capture phase guarantees this is pre-click)
      let beforeLabel = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
      if (!beforeLabel || beforeLabel.length > 50) return;

      // Defer to capture the AFTER label (post-click handler update)
      setTimeout(() => {
        let afterLabel = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
        let actionDesc = '';

        // Detect if this is a toggle button (label changed after click)
        if (afterLabel && afterLabel !== beforeLabel) {
          // For toggle buttons, explicitly state what action was performed
          const afterLabelLower = afterLabel.toLowerCase();
          
          if (afterLabelLower.includes('pause') || afterLabelLower.includes('stop') || afterLabelLower.includes('⏸')) {
            // Button now says "Pause" = animation is playing
            actionDesc = 'clicked "' + beforeLabel + '" and STARTED the animation. It is now PLAYING (button shows "' + afterLabel + '")';
          } else if (afterLabelLower.includes('play') || afterLabelLower.includes('start') || afterLabelLower.includes('▶')) {
            // Button now says "Play" = animation is paused
            actionDesc = 'clicked "' + beforeLabel + '" and PAUSED the animation. It is now STOPPED (button shows "' + afterLabel + '")';
          } else {
            // Generic toggle
            actionDesc = 'clicked "' + beforeLabel + '" — button turned into a "' + afterLabel + '" toggle';
          }
        } else {
          // Button label didn't change - infer action from button text
          // Button text shows the NEXT action (what will happen when you click)
          const beforeLabelLower = beforeLabel.toLowerCase();
          const isPlayButton = beforeLabelLower.includes('play') || beforeLabelLower.includes('start') || beforeLabelLower.includes('▶');
          const isPauseButton = beforeLabelLower.includes('pause') || beforeLabelLower.includes('stop') || beforeLabelLower.includes('⏸');
          
          if (isPauseButton) {
            // Button says "Pause" -> clicking it will pause -> animation is now stopped
            actionDesc = 'clicked "' + beforeLabel + '" and PAUSED the animation. It is now STOPPED';
          } else if (isPlayButton) {
            // Button says "Play" -> clicking it will play -> animation is now playing
            actionDesc = 'clicked "' + beforeLabel + '" and STARTED the animation. It is now PLAYING';
          } else {
            actionDesc = '"' + (afterLabel || beforeLabel) + '" clicked';
          }
        }

        window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
      }, 50);
    }, {capture: true});

    document.addEventListener('change', (e) => {
      // Only report user-initiated changes, not programmatic ones
      if (!e.isTrusted) return;
      
      let target = e.target;
      const interactiveEl = target.closest('input, select');
      if (!interactiveEl) return;
      
      // For sliders, get a descriptive label (not the value itself)
      let label = '';
      if (interactiveEl.tagName.toLowerCase() === 'input' && interactiveEl.type === 'range') {
        // Try to find a descriptive label for the slider
        label = interactiveEl.getAttribute('aria-label') || 
                interactiveEl.getAttribute('title') || 
                interactiveEl.id || 
                'slider';
        
        // Also try to find nearby text that describes the slider
        if (label === 'slider' || label === interactiveEl.id) {
          const parent = interactiveEl.parentElement;
          if (parent) {
            const labelEl = parent.querySelector('label');
            if (labelEl) {
              label = labelEl.textContent.trim();
            }
          }
        }
        
        let actionDesc = 'adjusted "' + label + '" slider to ' + interactiveEl.value;
        
        // Add context about min/max if available
        if (interactiveEl.min && interactiveEl.max) {
          const min = parseFloat(interactiveEl.min);
          const max = parseFloat(interactiveEl.max);
          const val = parseFloat(interactiveEl.value);
          const percent = Math.round(((val - min) / (max - min)) * 100);
          actionDesc += ' (' + percent + '% of range ' + min + '-' + max + ')';
        }
        
        window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
      } else {
        // For other inputs/selects, use the original logic
        label = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
        if (!label || label.length > 50) return;
        let actionDesc = '"' + label + '" changed to "' + interactiveEl.value + '"';
        window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
      }
    });

    // --- PROGRAMMATIC STATE TRACKING ---
    // Track animation state transitions (playing ↔ paused) via button label changes
    // Ignore transient changes within the same state to avoid false positives
    document.addEventListener('DOMContentLoaded', () => {
      // Signal to parent that iframe is ready to receive tool actions
      window.parent.postMessage({ type: 'IFRAME_READY' }, '*');
      
      let buttonStates = new Map(); // button -> 'playing' | 'paused'
      let clickTriggeredButtons = new Set();
      let lastSliderChangeTime = 0;

      const getState = (label) => {
        const lower = label.toLowerCase();
        if (lower.includes('pause') || lower.includes('stop') || lower.includes('⏸')) return 'playing';
        if (lower.includes('play') || lower.includes('start') || lower.includes('▶') || lower.includes('resume')) return 'paused';
        return null;
      };

      document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, [role="button"]');
        if (btn) {
          clickTriggeredButtons.add(btn);
          setTimeout(() => clickTriggeredButtons.delete(btn), 500);
        }
      }, true);

      // Track slider changes to suppress programmatic reports that are consequences of slider interaction
      document.addEventListener('change', (e) => {
        const slider = e.target.closest('input[type="range"]');
        if (slider) {
          lastSliderChangeTime = Date.now();
        }
      }, true);

      // DISABLED: Programmatic button state tracking (TASK 6)
      // Rationale: AI generated the code so it knows animation behavior
      // User interactions are already tracked separately via click/change handlers
      // This was causing false reports like "animation automatically started" after user clicks
      
      /*
      const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => {
          let target = m.target;
          if (target.nodeType === Node.TEXT_NODE) target = target.parentNode;
          const btn = target.closest && target.closest('button, [role="button"]');
          if (!btn) return;

          const label = (btn.innerText || btn.value || btn.id || btn.getAttribute('aria-label') || '').trim();
          if (!label || label.length > 50) return;

          const newState = getState(label);
          if (!newState) return;

          const wasClickTriggered = clickTriggeredButtons.has(btn);
          const previousState = buttonStates.get(btn);
          
          // Suppress reports within 500ms of slider changes - animation state changes
          // are often a direct consequence of slider interaction, not "automatic"
          const timeSinceSliderChange = Date.now() - lastSliderChangeTime;
          const isSliderConsequence = timeSinceSliderChange < 500;

          console.log('[Programmatic] Button mutation detected:', {
            label,
            previousState,
            newState,
            wasClickTriggered,
            timeSinceSliderChange,
            isSliderConsequence,
            willReport: previousState && previousState !== newState && !wasClickTriggered && !isSliderConsequence
          });

          if (previousState && previousState !== newState && !wasClickTriggered && !isSliderConsequence) {
            const stateDesc = newState === 'playing' ? 'started' : 'stopped';
            console.log('[Programmatic] State transition:', previousState, '→', newState);
            
            let payload = 'animation automatically ' + stateDesc + ' (button changed to "' + label + '")';
            
            // When animation stops, also report current slider values
            if (newState === 'paused') {
              const sliders = document.querySelectorAll('input[type="range"]');
              if (sliders.length > 0) {
                const sliderInfo = [];
                sliders.forEach(slider => {
                  const sliderLabel = slider.getAttribute('aria-label') || slider.getAttribute('title') || slider.id || 'slider';
                  const val = slider.value;
                  if (val) {
                    sliderInfo.push(sliderLabel + ': ' + val);
                  }
                });
                if (sliderInfo.length > 0) {
                  payload += '. Current position: ' + sliderInfo.join(', ');
                }
              }
            }
            
            window.parent.postMessage({ 
              type: 'INTERACTION_EVENT', 
              payload: payload
            }, '*');
          }

          buttonStates.set(btn, newState);
        });
      });
      
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      
      setTimeout(() => {
        document.querySelectorAll('button, [role="button"]').forEach(btn => {
          const label = (btn.innerText || btn.value || btn.id || btn.getAttribute('aria-label') || '').trim();
          const state = getState(label);
          if (state) buttonStates.set(btn, state);
        });
      }, 500);
      */
    });
  </script>

</head>
<body class="${isSidebarOpen ? 'sidebar-open' : ''}">
  <div class="layout-container">
    <div class="svg-area">
      ${(currentTitle || currentSubtitle) ? `
        <div style="margin-bottom: 24px; width: 100%; flex-shrink: 0;">
          ${currentTitle ? `<h2 style="font-size: 30px; font-weight: 700; color: #1e293b; margin: 0 0 8px 0; letter-spacing: -0.025em;">${currentTitle}</h2>` : ''}
          ${currentSubtitle ? `<p style="font-size: 18px; color: #64748b; margin: 0 0 10px 0;">${currentSubtitle}</p>` : ''}
          ${groundingSources.length > 0 ? `
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">
              <span style="font-size:11px; color:#94a3b8; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; align-self:center;">Sources</span>
              ${groundingSources.slice(0, 8).map(s =>
      `<a href="${s.url}" target="_blank" rel="noopener noreferrer"
                  style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#3b82f6; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.2); border-radius:20px; padding:3px 10px; text-decoration:none; white-space:nowrap; transition:background 0.2s;"
                  onmouseover="this.style.background='rgba(59,130,246,0.16)'"
                  onmouseout="this.style.background='rgba(59,130,246,0.08)'">
                  🔗 ${s.title.length > 40 ? s.title.slice(0, 38) + '…' : s.title}
                </a>`
    ).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
      <div style="flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; min-height: 0;">
        ${safeSvg}
      </div>
    </div>
    ${safeControls ? `
    <div class="controls-area">
      ${safeControls}
    </div>
    ` : ''}
  </div>
</body>
</html>
    `;
  }, [currentSvg, currentControls, currentTitle, currentSubtitle, groundingSources, sanitizeSvg, sanitizeControls]);


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
            controlsInventoryRef.current = ''
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
                    {/* Main URL input bar */}
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

                    {/* Web search input — only shown for Fast / Deep research modes */}
                    {researchMode !== 'off' && (
                      <form
                        onSubmit={(e) => { e.preventDefault(); performSearch(searchQuery) }}
                        className="url-form"
                        style={{ marginTop: 8 }}
                      >
                        <div className="url-input-wrapper shadow-none">
                          <input
                            type="text"
                            placeholder="Search the web for sources…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="url-input"
                            style={{ paddingLeft: 40 }}
                            disabled={isSearching}
                          />
                          {/* Search icon on the left */}
                          <span style={{ position: 'absolute', left: 13, color: 'var(--text-tertiary)', pointerEvents: 'none', display: 'flex' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                          </span>
                          {isSearching ? (
                            <span className="spinner" style={{ position: 'absolute', right: 14 }} />
                          ) : searchQuery.trim() ? (
                            <button type="submit" className="enter-icon-btn" title="Search">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                            </button>
                          ) : null}
                        </div>
                      </form>
                    )}

                    {/* Search results panel */}
                    {showSearchPanel && (
                      <div className="search-results-panel">
                        <div className="search-results-header">
                          <span className="search-results-title">
                            {isSearching
                              ? `${researchMode === 'deep' ? 'Deep' : 'Fast'} Research…`
                              : `${researchMode === 'deep' ? 'Deep' : 'Fast'} Research · ${searchResults.length} source${searchResults.length !== 1 ? 's' : ''}`
                            }
                          </span>
                          <button
                            className="search-results-close"
                            onClick={() => { setShowSearchPanel(false); setSearchResults([]); setSelectedSearchUrls(new Set()) }}
                            title="Close"
                          >
                            <XIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {isSearching ? (
                          <div className="search-results-loading">
                            <span className="spinner" />
                            <span>Searching with Gemini…</span>
                          </div>
                        ) : searchResults.length === 0 ? (
                          <div className="search-results-empty">No results found. Try a different query.</div>
                        ) : (
                          <>
                            <div className="search-results-list">
                              {searchResults.map((result) => {
                                const isSelected = selectedSearchUrls.has(result.url)
                                // Derive favicon from URL
                                let favicon = ''
                                try { favicon = `https://www.google.com/s2/favicons?domain=${new URL(result.url).hostname}&sz=32` } catch { }
                                return (
                                  <label key={result.url} className={`search-result-item${isSelected ? ' selected' : ''}`}>
                                    <input
                                      type="checkbox"
                                      className="search-result-checkbox"
                                      checked={isSelected}
                                      onChange={() => {
                                        setSelectedSearchUrls(prev => {
                                          const next = new Set(prev)
                                          if (next.has(result.url)) next.delete(result.url)
                                          else next.add(result.url)
                                          return next
                                        })
                                      }}
                                    />
                                    <div className="search-result-body">
                                      <div className="search-result-title-row">
                                        {favicon && <img src={favicon} className="search-result-favicon" alt="" />}
                                        <span className="search-result-title">{result.title}</span>
                                      </div>
                                      {result.snippet && (
                                        <p className="search-result-snippet">{result.snippet}</p>
                                      )}
                                      <span className="search-result-url">{result.url.replace(/^https?:\/\//, '').slice(0, 60)}</span>
                                    </div>
                                  </label>
                                )
                              })}
                            </div>

                            {/* Footer actions */}
                            <div className="search-results-footer">
                              <button
                                className="search-select-all-btn"
                                onClick={() => {
                                  if (selectedSearchUrls.size === searchResults.length) {
                                    setSelectedSearchUrls(new Set())
                                  } else {
                                    setSelectedSearchUrls(new Set(searchResults.map(r => r.url)))
                                  }
                                }}
                              >
                                {selectedSearchUrls.size === searchResults.length ? 'Deselect all' : 'Select all'}
                              </button>
                              <button
                                className="btn-sm-primary"
                                onClick={addSelectedSearchSources}
                                disabled={selectedSearchUrls.size === 0}
                              >
                                + Add {selectedSearchUrls.size > 0 ? selectedSearchUrls.size : ''} source{selectedSearchUrls.size !== 1 ? 's' : ''}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}

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



                    {/* Research mode toggle + Generate button */}
                    {sources.length > 0 && sessionPhase === 'idle' && (
                      <div className="w-full mt-4 flex flex-col gap-4">
                        {/* Research mode segmented control */}
                        <div className="research-mode-row">
                          <span className="research-mode-label">Research</span>
                          <div className="research-mode-track">
                            {(['off', 'fast', 'deep'] as const).map(mode => {
                              const labels: Record<string, string> = { off: 'Off', fast: 'Fast', deep: 'Deep' }
                              const tips: Record<string, string> = {
                                off: 'Source-only — no web search. Strict fidelity to your sources.',
                                fast: 'Google Search grounding during graphic generation.',
                                deep: 'URL sources get a Gemini+Search enrichment pass before generation. Slower but more thorough.',
                              }
                              return (
                                <button
                                  key={mode}
                                  title={tips[mode]}
                                  onClick={() => setResearchMode(mode)}
                                  className={`research-mode-btn mode-${mode}${researchMode === mode ? ' active' : ''}`}
                                >
                                  {labels[mode]}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        <div className="button-group w-full">
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
                        disabled={isStartingConversation}
                        className={`w-full py-3 px-6 ${isStartingConversation ? 'bg-[#0a48ad] opacity-80' : 'bg-[var(--accent-primary)] hover:bg-[#0a48ad]'} text-white rounded-full font-semibold transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow-md`}
                      >
                        {isStartingConversation ? (
                          <><span className="spinner" style={{ width: 18, height: 18 }} /> Connecting...</>
                        ) : (
                          <><MicIcon className="w-5 h-5" /> Start Live Conversation</>
                        )}
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
