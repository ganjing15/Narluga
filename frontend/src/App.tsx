import { useState, useRef, type FormEvent, useEffect, useCallback, useMemo } from 'react'
import './App.css'
import { GraphicsPage, SvgThumbnail } from './GraphicsPage'
import {
  MicIcon, StopIcon, DisplayIcon, SparklesIcon,
  ChevronLeftIcon, ChevronRightIcon,
  LinkIcon, YoutubeIcon, FileUploadIcon, TextIcon, SearchIcon,
  CheckCircleIcon, XIcon, RefreshIcon, PlusIcon, PencilIcon, NarlugaLogo
} from './Icons'
import {
  signInWithGoogle, firebaseSignOut, getIdToken, onAuthChange,
  isFirebaseConfigured, saveGraphic, listGraphics, patchGraphicsSvg,
  listPublicExamples, publishToExamples, clearPublicExamples, patchPublicExamplesSvg, inspectPublicExampleSvg,
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
type SourceType = 'url' | 'youtube' | 'text' | 'file' | 'search'
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

// Reconstruct a Source from a saved label string.
// Labels are stored as the display label (e.g. "wikipedia.org", "The Solar System",
// "https://example.com", "youtube:abc123", "file:report.pdf").
function sourceFromLabel(rawLabel: string, index: number): Source {
  // Strip leading emoji (e.g. "🔍 The Solar System" → "The Solar System")
  const label = rawLabel.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '')
  const l = label.toLowerCase()
  let type: SourceType
  let content: string
  let displayLabel: string

  if (l.startsWith('youtube:')) {
    type = 'youtube'
    content = label.replace(/^youtube:\s*/i, '')
    displayLabel = `https://youtube.com/watch?v=${content}`
  } else if (l.startsWith('http://') || l.startsWith('https://')) {
    type = 'url'
    content = label
    displayLabel = label
  } else if (l.startsWith('file:') || l.endsWith('.pdf') || l.endsWith('.txt')) {
    type = 'file'
    content = label.replace(/^file:\s*/i, '')
    displayLabel = content
  } else if (/^[a-z0-9-]+\.[a-z]{2,}(\.[a-z]{2,})*(\/|$)/i.test(label) || /^[a-z0-9-]+\.[a-z]{2,}$/i.test(label)) {
    // Bare domain like "wikipedia.org", "study.com", "cnes.fr"
    type = 'url'
    content = `https://${label}`
    displayLabel = label
  } else {
    // Plain text label → likely a search query
    type = 'search'
    content = `Web Search Query: ${label}`
    displayLabel = label
  }

  return { id: `loaded-${index}`, type, content, label: displayLabel }
}

// Module-level guard to prevent duplicate preconnect (survives hot-reload)
let _preConnectInFlight = false

function App() {
  // Source management
  const [sources, setSources] = useState<Source[]>([])
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [showTextArea, setShowTextArea] = useState(false)
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [textAreaValue, setTextAreaValue] = useState('')
  const [editingTextSourceId, setEditingTextSourceId] = useState<string | null>(null)

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
  const [eagerAudioReady, setEagerAudioReady] = useState(false)
  const isPreConnectRef = useRef(false)  // true while WS is a background pre-connect (suppress errors)
  const prepareLiveSentRef = useRef(false)  // true once prepare_live sent (deferred eager connect)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [currentPage, setCurrentPage] = useState<'home' | 'gallery'>('home')
  const accountMenuRef = useRef<HTMLDivElement>(null)

  // Auth state
  const [user, setUser] = useState<User | null>(null)

  // Saved graphics gallery
  const [savedGraphics, setSavedGraphics] = useState<SavedGraphic[]>([])
  const [galleryLoading, setGalleryLoading] = useState(false)

  // Public curated examples (visible to all users including non-logged-in)
  const [publicExamples, setPublicExamples] = useState<SavedGraphic[]>([])

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
  const [researchMode, setResearchMode] = useState<'fast' | 'deep'>('fast')
  const narrationContextRef = useRef<string>('')
  const sourceLabelsRef = useRef<string[]>([])
  const controlsInventoryRef = useRef<string>('')

  // Session duration tracking (uttered_reference pattern)
  const sessionStartTimeRef = useRef<number | null>(null)
  const durationCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [sessionDuration, setSessionDuration] = useState(0) // seconds elapsed
  const [showDurationWarning, setShowDurationWarning] = useState(false)

  const MAX_SESSION_SECONDS = 20 * 60   // 20 minutes hard limit
  const WARN_SESSION_SECONDS = 15 * 60  // 15 minutes → show warning banner

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
  const pendingToolActionsRef = useRef<Array<{ action: string, params: any }>>([])
  const iframeReadyRef = useRef<boolean>(false)
  const nextPlayTimeRef = useRef<number>(0)
  const activeAudioNodesRef = useRef<AudioBufferSourceNode[]>([])
  const audioMutedUntilRef = useRef<number>(0)


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
            label: data.filename
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
      // For file sources, only update the label (preserve content and type)
      if (s.type === 'file') return { ...s, label: trimmed }
      // Re-detect type from new value
      const { type } = detectInputType(trimmed)
      return { ...s, type, content: trimmed, label: trimmed }
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
        type: 'search',
        content: `Web Search Query: ${searchQuery.trim()}`,
        label: searchQuery.trim()
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

  // Fetch public curated examples on mount (no auth required)
  useEffect(() => {
    if (!isFirebaseConfigured) return
    listPublicExamples().then(setPublicExamples).catch(e =>
      console.warn('[Examples] Failed to load public examples:', e)
    )
  }, [])

  // Expose admin utilities on window for console use
  useEffect(() => {
    (window as any)._patchGraphics = (title: string, find: string, replace: string) => {
      if (!user) { console.error('Not signed in'); return }
      return patchGraphicsSvg(user.uid, title, find, replace)
    }
    ;(window as any)._publishExample = (graphicId: string, order: number) => {
      if (!user) { console.error('Not signed in'); return }
      return publishToExamples(user.uid, graphicId, order)
    }
    ;(window as any)._clearExamples = () => clearPublicExamples()
    ;(window as any)._patchPublicExamples = (title: string, find: string, replace: string) =>
      patchPublicExamplesSvg(title, find, replace)
    ;(window as any)._inspectPublicExample = (title: string, keyword: string) =>
      inspectPublicExampleSvg(title, keyword)
    ;(window as any)._listGraphicIds = () => {
      savedGraphics.forEach((g, i) => console.log(`${i}: ${g.id} — "${g.title}"`))
    }
  }, [user, savedGraphics])

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
          console.log(`[LATENCY] sendToVoiceAI at T=${Date.now()}: ${textPayload.slice(0, 80)}...`);
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

    let buttonClickInProgress = false;
    let aiEventDebounceTimer: ReturnType<typeof setTimeout>;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'CLEAR_AUDIO') {
        // A button was clicked — suppress AI_EVENTs and cancel any pending ones
        buttonClickInProgress = true;
        clearTimeout(debounceTimer);
        clearTimeout(aiEventDebounceTimer);
        console.log(`[LATENCY] CLEAR_AUDIO received at T=${Date.now()}`);
        setTimeout(() => { buttonClickInProgress = false; }, 500);
      } else if (data && data.type === 'HOVER_EVENT') {
        if (buttonClickInProgress) return;
        clearTimeout(hoverDebounceTimer);
        hoverDebounceTimer = setTimeout(() => {
          sendToVoiceAI(`[Cursor position: ${data.payload}]`);
        }, 3000); // 3s debounce — active but limited to reduce context noise
      } else if (data && data.type === 'AI_EVENT') {
        // Auto-play phase change — very long debounce (10s) since these flood context fast.
        // Button clicks cancel these entirely (INTERACTION_EVENT covers the click action).
        if (buttonClickInProgress) return;
        clearTimeout(aiEventDebounceTimer);
        aiEventDebounceTimer = setTimeout(() => {
          sendToVoiceAI(`[System Status: The user just interacted with the dashboard UI. Action: ${data.payload}]`);
        }, 10000);
      } else if (data && data.type === 'INTERACTION_EVENT') {
        // Button click — HIGH PRIORITY, cancel any pending AI_EVENT
        clearTimeout(debounceTimer);
        clearTimeout(aiEventDebounceTimer);
        debounceTimer = setTimeout(() => {
          sendToVoiceAI(`[System Status: The user just interacted with the dashboard UI. Action: ${data.payload}]`);
        }, 100);
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

  // Stop the session duration timer
  const stopDurationTimer = useCallback(() => {
    if (durationCheckIntervalRef.current) {
      clearInterval(durationCheckIntervalRef.current)
      durationCheckIntervalRef.current = null
    }
  }, [])

  // Start the session duration timer.
  // If sessionStartTimeRef is already set (GoAway reconnect path), we keep the
  // original start time so the 20-min wall clock is not reset by reconnections.
  const startDurationTimer = useCallback(() => {
    stopDurationTimer()
    // Only record start time for brand-new sessions, not GoAway reconnects
    if (!sessionStartTimeRef.current) {
      sessionStartTimeRef.current = Date.now()
      setSessionDuration(0)
      setShowDurationWarning(false)
    }
    durationCheckIntervalRef.current = setInterval(() => {
      if (!sessionStartTimeRef.current) return
      const elapsed = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
      setSessionDuration(elapsed)
      if (elapsed >= WARN_SESSION_SECONDS && elapsed < MAX_SESSION_SECONDS) {
        setShowDurationWarning(true)
      }
      if (elapsed >= MAX_SESSION_SECONDS) {
        // Hard limit reached — close the WS cleanly (prevents reconnection)
        console.log('[SessionTimer] 20-min limit reached — closing session')
        if (wsRef.current) {
          wsRef.current.close(1000, 'Maximum session duration reached')
        }
      }
    }, 1000)
  }, [stopDurationTimer, WARN_SESSION_SECONDS, MAX_SESSION_SECONDS])

  // Disconnect cleanup
  const disconnect = useCallback(() => {
    micReadyRef.current = false
    hasStartedRef.current = false
    // Stop and reset duration timer
    stopDurationTimer()
    sessionStartTimeRef.current = null
    setSessionDuration(0)
    setShowDurationWarning(false)
    // Note: don't reset _preConnectInFlight here — it's managed by preConnectForGalleryGraphic only
    // Tell backend to end Gemini session, but keep WS alive for fast reconnect
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end_live_session" }))
    }
    if (audioWorkletNodeRef.current) {
      audioWorkletNodeRef.current.disconnect()
      audioWorkletNodeRef.current = null
    }
    // Keep micAudioCtxRef alive with worklet loaded — setupMic() reuses it (fast path)
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
    setEagerAudioReady(false)
    prepareLiveSentRef.current = false
    // If we're ending a conversation and have a graphic, go back to 'complete'
    setSessionPhase(prev => {
      if ((prev === 'conversation' || prev === 'complete') && currentSvgRef.current) {
        return 'complete'
      }
      return 'idle'
    })
    setStatusMessage('')
  }, [stopDurationTimer])

  // Attach onmessage/onclose/onerror to a live-restart WebSocket.
  // Extracted so both startPresentation (Path B) and preConnectForGalleryGraphic can reuse it.
  const attachRestartHandlers = (ws: WebSocket) => {
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type !== 'audio') console.log('[WebSocket] Received message:', data.type, data);

      if (data.type === 'phase') {
        setSessionPhase(data.phase as SessionPhase)
      } else if (data.type === 'ready') {
        micReadyRef.current = true
        startDurationTimer()  // Session is live — start 20-min wall clock
        setupMic()
      } else if (data.type === 'clear') {
        if (audioCtxRef.current) {
          activeAudioNodesRef.current.forEach(node => { try { node.stop() } catch (e) { } })
          activeAudioNodesRef.current = []
          nextPlayTimeRef.current = audioCtxRef.current.currentTime
        }
        // Backend confirmed interruption — allow new audio through immediately
        audioMutedUntilRef.current = 0
      } else if (data.type === 'audio') {
        if (Date.now() < audioMutedUntilRef.current) return;
        const base64Data = data.data
        const binaryStr = window.atob(base64Data)
        const len = binaryStr.length
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) { bytes[i] = binaryStr.charCodeAt(i) }
        const int16Array = new Int16Array(bytes.buffer)
        const float32Array = new Float32Array(int16Array.length)
        for (let i = 0; i < int16Array.length; i++) { float32Array[i] = int16Array[i] / 32768.0 }
        if (audioCtxRef.current) {
          const audioBuffer = audioCtxRef.current.createBuffer(1, float32Array.length, 24000)
          audioBuffer.getChannelData(0).set(float32Array)
          const source = audioCtxRef.current.createBufferSource()
          source.buffer = audioBuffer
          source.connect(audioCtxRef.current.destination)
          const startTime = Math.max(audioCtxRef.current.currentTime, nextPlayTimeRef.current)
          source.start(startTime)
          nextPlayTimeRef.current = startTime + audioBuffer.duration
          activeAudioNodesRef.current.push(source)
          source.onended = () => { activeAudioNodesRef.current = activeAudioNodesRef.current.filter(n => n !== source) }
        }
      } else if (data.type === 'tool_action') {
        const { action, params } = data
        console.log('[Parent] Received tool_action:', action, params);
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
        if (iframeRef.current && iframeRef.current.contentWindow && iframeReadyRef.current) {
          console.log('[Parent] Forwarding to iframe:', iframeRef.current.contentWindow);
          iframeRef.current.contentWindow.postMessage({ type: 'TOOL_ACTION', action, params }, '*')
        } else {
          console.warn('[Parent] Iframe not ready, queuing tool_action:', action);
          pendingToolActionsRef.current.push({ action, params })
        }
      } else if (data.type === 'eager_audio_ready') {
        setEagerAudioReady(true)
        console.log('[PreConnect] AI audio ready — click Start for instant playback')
      } else if (data.type === 'error') {
        if (isPreConnectRef.current) {
          // Pre-connect failed silently (e.g. rate limit) — user didn't ask for this
          console.log('[PreConnect] Suppressed error:', data.message)
          wsRef.current = null
        } else {
          setError(data.message)
          disconnect()
        }
      }
    }
    ws.onclose = (event) => {
      if (isPreConnectRef.current) {
        // Pre-connect closed silently — don't show errors to user
        console.log('[PreConnect] Connection closed:', event.code)
        wsRef.current = null
        return
      }
      if (event.code === 1000 && event.reason) {
        setStatusMessage(event.reason)
      } else if (!event.wasClean && event.code !== 1000 && event.code !== 1005) {
        setError(`Connection lost (${event.code}). Click 'Start Live Conversation' to reconnect.`)
      }
      disconnect()
    }
    ws.onerror = () => {
      if (isPreConnectRef.current) {
        console.log('[PreConnect] Connection error suppressed')
        wsRef.current = null
        return
      }
      setError('WebSocket connection error.')
      disconnect()
    }
  }

  // Pre-connect WebSocket when a gallery graphic is opened so the first click
  // on "Start Live Conversation" takes Path A (fast) instead of Path B (slow).
  const preConnectForGalleryGraphic = async () => {
    // Prevent duplicate preconnect (module-level flag survives hot-reload)
    if (_preConnectInFlight) {
      console.log('[PreConnect] Already preconnecting — skipping duplicate')
      return
    }
    _preConnectInFlight = true
    isPreConnectRef.current = true
    // Always close old WS — it may be from /ws/live (graphic generation) not /ws/live-restart
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      // Detach handlers so stale onclose doesn't call disconnect()
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }

    // Pre-acquire mic if permission was already granted (no surprise dialog)
    if (!streamRef.current && navigator.permissions) {
      navigator.permissions.query({ name: 'microphone' as PermissionName }).then(status => {
        if (status.state === 'granted') {
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          }).then(stream => {
            streamRef.current = stream
            console.log('[PreConnect] Mic stream pre-acquired (permission was granted)')
          }).catch(() => { })
        }
      }).catch(() => { })
    }

    try {
      const token = await getIdToken()
      const wsUrl = token
        ? `${WS_BACKEND_URL}/ws/live-restart?token=${encodeURIComponent(token)}`
        : `${WS_BACKEND_URL}/ws/live-restart`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onopen = () => {
        _preConnectInFlight = false
        ws.send(JSON.stringify({
          type: "restart_live",
          narration_context: narrationContextRef.current,
          source_labels: sourceLabelsRef.current,
          svg_html: currentSvgRef.current || "",
          controls_html: currentControlsRef.current || "",
          controls_inventory: controlsInventoryRef.current || ""
        }))
        console.log('[PreConnect] Gallery graphic WS ready — next click will use fast path')
      }
      attachRestartHandlers(ws)
    } catch (err) {
      // Pre-connect failed silently — startPresentation will fall back to Path B on click
      _preConnectInFlight = false
      wsRef.current = null
    }
  }

  // Signal backend to eagerly connect to Gemini Live API (deferred pre-connect).
  // Called on hover/pointerdown of the Start button — the WS is already open but
  // Gemini isn't connected yet (saving cost while user is just browsing).
  const prepareLive = () => {
    if (prepareLiveSentRef.current) return  // Already sent
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN && !hasStartedRef.current) {
      prepareLiveSentRef.current = true
      ws.send(JSON.stringify({ type: "prepare_live" }))
      console.log('[PrepareLive] Sent prepare_live — Gemini will connect eagerly')
    }
  }

  // Start live conversation (mic + audio)
  const startPresentation = async () => {
    setIsStartingConversation(true)
    setSessionPhase('conversation')  // Transition UI immediately on ALL paths
    setStatusMessage('Connecting to AI...')

    // Ensure mic is acquired (parallel with WS wait)
    const micPromise = streamRef.current
      ? Promise.resolve(streamRef.current)
      : navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      }).catch((err: any) => {
        setIsStartingConversation(false)
        setSessionPhase('complete')
        setError("Microphone permission is required to converse with the AI.")
        return null
      })

    // Ensure playback AudioContext exists
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      audioCtxRef.current = new AC({ sampleRate: 24000 })
      nextPlayTimeRef.current = audioCtxRef.current.currentTime
    }

    // --- WS readiness: wait for preconnect WS or create a new one ---
    let ws = wsRef.current

    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      // Preconnect WS exists — wait for it to open (no timeout, it WILL complete)
      if (ws.readyState === WebSocket.CONNECTING) {
        console.log('[startPresentation] Waiting for preconnect WS to open...')
        await new Promise<void>((resolve) => {
          const check = () => {
            if (ws!.readyState === WebSocket.OPEN) { resolve(); return }
            if (ws!.readyState === WebSocket.CLOSED || ws!.readyState === WebSocket.CLOSING) { resolve(); return }
            setTimeout(check, 50)
          }
          check()
        })
      }
      ws = wsRef.current  // re-read in case it changed
    }

    // Wait for mic (parallel)
    const stream = await micPromise
    if (!stream) return  // mic was denied, error already set
    streamRef.current = stream

    if (ws && ws.readyState === WebSocket.OPEN) {
      // ===== FAST PATH: preconnect WS is OPEN =====
      isPreConnectRef.current = false  // User clicked Start — show errors from now on
      console.log('[startPresentation] Using fast path (preconnect WS)')
      ws.send(JSON.stringify({
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
      startDurationTimer()  // Fast path: session live on click
    } else if (narrationContextRef.current) {
      // ===== SLOW PATH: no preconnect WS — create one fresh =====
      isPreConnectRef.current = false  // User-initiated — show errors
      console.log('[startPresentation] No preconnect WS available — creating new connection')
      setIsConnecting(true)
      setError('')

      let token: string | null
      try {
        token = await getIdToken()
      } catch {
        token = null
      }

      const wsUrl = token ? `${WS_BACKEND_URL}/ws/live-restart?token=${encodeURIComponent(token)}` : `${WS_BACKEND_URL}/ws/live-restart`
      const newWs = new WebSocket(wsUrl)
      wsRef.current = newWs

      newWs.onopen = () => {
        setIsConnecting(false)
        newWs.send(JSON.stringify({
          type: "restart_live",
          narration_context: narrationContextRef.current,
          source_labels: sourceLabelsRef.current,
          svg_html: currentSvgRef.current || "",
          controls_html: currentControlsRef.current || "",
          controls_inventory: controlsInventoryRef.current || ""
        }))
        setHasStarted(true)
        setIsStartingConversation(false)
        hasStartedRef.current = true
        micReadyRef.current = true
        eventQueueRef.current = []

        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
          try { audioCtxRef.current.resume(); } catch (err) { }
        }

        setupMic()
        startDurationTimer()  // Slow path: session live on WS open

        newWs.send(JSON.stringify({
          type: "start_live_session",
          pre_events: eventQueueRef.current
        }))
      }

      attachRestartHandlers(newWs)
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
      ; (async () => {
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
          research_mode: 'fast',  // Always use fast grounding for generation
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
          startDurationTimer()  // Session is live — start 20-min wall clock
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
          if (Date.now() < audioMutedUntilRef.current) return; // discard in-flight old-response chunks
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
    // Clear SVG ref BEFORE disconnect so disconnect doesn't revert phase to 'complete'
    currentSvgRef.current = null
    disconnect()
    _preConnectInFlight = false  // Allow preconnect for next gallery graphic
    // Close preconnect WS so stale phase messages don't override idle state
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.onmessage = null
      wsRef.current.close()
      wsRef.current = null
    }
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

  // Load a saved graphic as an example (same logic as opening from gallery)
  const loadExample = useCallback((g: SavedGraphic) => {
    setCurrentSvg(g.svg_html)
    setCurrentControls(g.controls_html || null)
    setCurrentTitle(g.title)
    setCurrentSubtitle(g.subtitle || null)
    narrationContextRef.current = g.narration_context || ''
    sourceLabelsRef.current = g.source_labels || []
    controlsInventoryRef.current = ''
    setSources((g.source_labels || []).map((label, i) => sourceFromLabel(label, i)))
    setSessionPhase('complete')
    _preConnectInFlight = false
    preConnectForGalleryGraphic()
  }, [])

  // Pre-load AudioWorklet module early (during designing phase) so it's ready
  // well before the user clicks "Start Live Conversation".
  useEffect(() => {
    if ((sessionPhase !== 'designing' && sessionPhase !== 'complete') || workletPreloadedRef.current || micAudioCtxRef.current) return
      ; (async () => {
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
      } else if (event.data?.type === 'CLEAR_AUDIO') {
        // User clicked something in the iframe — immediately stop queued AI audio
        if (audioCtxRef.current) {
          activeAudioNodesRef.current.forEach(node => { try { node.stop() } catch (_) { } });
          activeAudioNodesRef.current = [];
          nextPlayTimeRef.current = audioCtxRef.current.currentTime;
        }
        // Mute incoming WebSocket chunks briefly to discard in-flight old-response audio.
        // The backend's 'clear' response resets this to 0 almost immediately (~10ms);
        // 400ms is just a fallback in case 'clear' is delayed.
        audioMutedUntilRef.current = Date.now() + 400;
        // Tell backend immediately so it can send 'clear' back and reset the muting
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "user_interrupt" }));
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
          const classStr = (el.getAttribute('class') || '').toLowerCase().replace(/[-_]/g, ' ');

          const idScore = scoreMatch(id, kw);
          const labelScore = scoreMatch(label, kw);
          const sectionScore = scoreMatch(section, kw);
          const classScore = scoreMatch(classStr, kw);
          const maxScore = Math.max(idScore, labelScore, sectionScore, classScore);
          
          if (maxScore > 0 && !isTooLarge(el)) {
            // For animated SVGs, prefer groups over bare shapes.
            // Groups carry the animation transform (e.g., translate(x,y)) and contain
            // the full visual unit (planet dot + label). Highlighting a bare <circle>
            // at its local (0,0) position can cause the glow to appear at the wrong spot.
            const isVisualElement = ['circle', 'ellipse', 'rect', 'path', 'polygon', 'line'].includes(el.tagName.toLowerCase());
            const isGroup = el.tagName.toLowerCase() === 'g';
            let finalScore = maxScore;
            if (isGroup) {
              finalScore = maxScore * 3; // Highest priority — logical animation unit
            } else if (isVisualElement) {
              finalScore = maxScore * 1; // Lowest — positioned relative to parent group
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
        // Only highlight the single best match — multiple matches cause
        // false positives (orbit circles, legend entries near the Sun, etc.)
        const elements = findElements(params.element_id || '').slice(0, 1);
        const color = params.color || '#3b82f6';
        elements.forEach(el => {
          const prev = el.style.cssText;
          // IMPORTANT: Only transition 'filter', not 'all'. 'transition: all' causes
          // the browser to transition the 'transform' property between frames, which
          // fights with the animation loop's setAttribute('transform', ...) updates
          // and makes elements drift to stale positions.
          el.style.transition = 'filter 0.4s ease';
          el.style.filter = "drop-shadow(0 0 16px " + color + ") drop-shadow(0 0 8px " + color + ")";
          // NOTE: Do NOT set el.style.transform here. For SVG elements whose position
          // is set via setAttribute('transform', 'translate(...)') by animation code,
          // any CSS style.transform overrides the SVG transform attribute entirely,
          // snapping the element to the origin and causing the "label drift" bug.
          // The drop-shadow glow alone is a clear, sufficient highlight effect.
          setTimeout(() => {
            el.style.transition = 'filter 0.4s ease';
            el.style.filter = '';
            setTimeout(() => { el.style.cssText = prev; }, 400);
          }, 4000);
        });
        // NOTE: Removed scrollIntoView — for animated SVG elements, it scrolls to
        // the element's layout-box position which may not match its visual position.
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
          el.style.transition = 'filter 0.3s ease';
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
          // Use specific property transitions to avoid interfering with animated SVG transforms
          el.style.transition = 'filter 0.5s ease, fill 0.5s ease, stroke 0.5s ease, opacity 0.5s ease';
          if (el instanceof SVGElement && ['fill', 'stroke', 'opacity', 'stroke-width', 'r', 'cx', 'cy', 'x', 'y', 'width', 'height', 'display'].includes(prop)) {
            // Direct SVG attribute modification
            el.setAttribute(prop, val);
          } else if (prop === 'scale' && el instanceof SVGElement) {
            // Special handling for scale: use SVG transform attribute to avoid position shift
            try {
              const bbox = el.getBBox();
              const cx = bbox.x + bbox.width / 2;
              const cy = bbox.y + bbox.height / 2;

              // Store the original transform on first scale, then always rebuild from it
              // (regex-stripping scale() left orphaned translate() wrappers causing drift)
              if (!el.dataset.originalTransform && el.dataset.originalTransform !== '') {
                el.dataset.originalTransform = el.getAttribute('transform') || '';
              }
              const baseTransform = el.dataset.originalTransform;

              // Build new scale transform from the clean base
              const newTransform = (baseTransform + ' translate(' + cx + ', ' + cy + ') scale(' + val + ') translate(' + (-cx) + ', ' + (-cy) + ')').trim();
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
                }, 100);
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

      // Immediately interrupt AI audio — fires in capture phase before the button's own
      // onclick, so audio stops at the moment of the click rather than after a Gemini round-trip.
      window.parent.postMessage({ type: 'CLEAR_AUDIO' }, '*');

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

      // Fix: range inputs default to step="1", which rounds fractional values like 0.4 back to 0.
      // Generated animation code often uses sub-integer increments (e.g. slider.value += 0.4).
      // Setting step="any" allows the DOM to store any numeric value without rounding.
      document.querySelectorAll('input[type="range"]').forEach(slider => {
        const step = slider.getAttribute('step');
        if (!step || step === '1') {
          slider.setAttribute('step', 'any');
        }
      });
      
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
      case 'search': return <SearchIcon className="w-4 h-4" />
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
            setSources((g.source_labels || []).map((label, i) => sourceFromLabel(label, i)))
            setSessionPhase('complete')
            setCurrentPage('home')
            // Reset guard so preconnect always fires for each gallery load
            _preConnectInFlight = false
            // Pre-connect WS so the first "Start Live Conversation" click uses the fast path
            preConnectForGalleryGraphic()
          }}
          onDeleteGraphic={(id) => setSavedGraphics(prev => prev.filter(x => x.id !== id))}
          onBack={() => setCurrentPage('home')}
        />
      )}
      <div className="app-wrapper" style={{ display: currentPage === 'gallery' ? 'none' : undefined }}>
        <header className="app-header">
          <div
            className="app-logo flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => { setSources([]); resetSession() }}
          >
            <NarlugaLogo className="w-11 h-11 drop-shadow-sm" />
            <span className="text-2xl font-extrabold tracking-tighter text-slate-800">
              Narluga
            </span>
          </div>

          <div className="flex items-center gap-4">
            {sessionPhase === 'conversation' && (
              <div className="live-badge">
                <span className="pulse-dot"></span>
                {showDurationWarning
                  ? `⚠️ ${Math.floor((MAX_SESSION_SECONDS - sessionDuration) / 60)}m left`
                  : 'Live Chat'}
              </div>
            )}
            {showDurationWarning && sessionPhase === 'conversation' && (
              <div
                style={{
                  background: 'rgba(245,158,11,0.15)',
                  border: '1px solid rgba(245,158,11,0.4)',
                  borderRadius: '12px',
                  padding: '4px 12px',
                  fontSize: '12px',
                  color: '#92400e',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                Session ends in {Math.ceil((MAX_SESSION_SECONDS - sessionDuration) / 60)} min
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
              <div className="flex-1 flex flex-col relative" style={{ minHeight: 0 }}>
                <div className="flex-1 overflow-auto flex flex-col p-4 pb-0">

                  {/* Phase: idle or complete — show source manager */}
                  {(sessionPhase === 'idle' || sessionPhase === 'complete') && !isProcessing && (
                    <div className="sidebar-input-area">
                      {/* Web search input — always visible */}
                      <form
                        onSubmit={(e) => { e.preventDefault(); if (searchQuery.trim()) performSearch(searchQuery) }}
                        className="url-form"
                      >
                        <div className="url-input-wrapper shadow-none" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                          <textarea
                            placeholder="Search the web for sources"
                            value={searchQuery}
                            onChange={(e) => {
                              setSearchQuery(e.target.value)
                              // Auto-resize
                              e.target.style.height = 'auto'
                              e.target.style.height = e.target.scrollHeight + 'px'
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                if (searchQuery.trim()) performSearch(searchQuery)
                              }
                            }}
                            className="url-input"
                            style={{ paddingLeft: 40, paddingBottom: 38, resize: 'none', overflow: 'hidden', minHeight: 52 }}
                            disabled={isConnecting || isSearching}
                            rows={1}
                          />
                          <span style={{ position: 'absolute', left: 13, top: 18, color: 'var(--text-tertiary)', pointerEvents: 'none', display: 'flex' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                          </span>
                          {isSearching ? (
                            <span className="spinner" style={{ position: 'absolute', right: 14, top: 18 }} />
                          ) : (
                            <button type="submit" className="enter-icon-btn" title="Search" disabled={!searchQuery.trim()} style={!searchQuery.trim() ? { background: '#c4c7cc', boxShadow: 'none' } : undefined}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                            </button>
                          )}
                          {/* Search depth toggle — inside input */}
                          <div style={{ position: 'absolute', left: 8, bottom: 6, display: 'flex', gap: 2 }}>
                            {(['fast', 'deep'] as const).map(mode => (
                              <button
                                key={mode}
                                type="button"
                                title={mode === 'fast' ? 'Quick search' : 'Thorough search with enrichment'}
                                onClick={() => setResearchMode(mode)}
                                style={{
                                  padding: '2px 10px',
                                  fontSize: '11px',
                                  fontWeight: researchMode === mode ? 600 : 400,
                                  color: researchMode === mode ? 'var(--accent-primary)' : '#64748b',
                                  background: researchMode === mode ? 'rgba(11, 87, 208, 0.08)' : 'transparent',
                                  border: 'none',
                                  borderRadius: 'var(--radius-pill)',
                                  cursor: 'pointer',
                                  transition: 'all 0.15s ease',
                                  lineHeight: '20px',
                                }}
                              >
                                {mode === 'fast' ? 'Fast Research' : 'Deep Research'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </form>

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
                                    <div key={result.url} className={`search-result-item${isSelected ? ' selected' : ''}`}>
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
                                          <a href={result.url} target="_blank" rel="noopener noreferrer" className="search-result-title" style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}>{result.title}</a>
                                        </div>
                                        {result.snippet && (
                                          <p className="search-result-snippet">{result.snippet}</p>
                                        )}
                                        <a href={result.url} target="_blank" rel="noopener noreferrer" className="search-result-url" style={{ textDecoration: 'none' }}>{result.url.replace(/^https?:\/\//, '').slice(0, 60)}</a>
                                      </div>
                                    </div>
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
                          onClick={() => { setShowUrlInput(!showUrlInput); setShowTextArea(false) }}
                          title="Add a URL or YouTube link"
                        >
                          <LinkIcon className="w-4 h-4" /> URL
                        </button>
                        <button
                          className="source-chip"
                          onClick={() => { setShowTextArea(!showTextArea); setShowUrlInput(false) }}
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

                      {/* URL input (expanded) */}
                      {showUrlInput && (
                        <div className="text-source-area">
                          <form onSubmit={(e) => { addSource(e); setShowUrlInput(false) }} className="url-form">
                            <div className="url-input-wrapper shadow-none">
                              <input
                                type="text"
                                placeholder="Paste a website/YouTube link"
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                className="url-input"
                                disabled={isConnecting}
                                autoFocus
                              />
                              {inputValue.trim() && (
                                <button type="submit" className="enter-icon-btn" title="Add source">
                                  <PlusIcon className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </form>
                          <button
                            className="btn-sm-secondary mt-2"
                            onClick={() => { setShowUrlInput(false); setInputValue('') }}
                            style={{ alignSelf: 'flex-start' }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}

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
                              onClick={() => {
                                if (editingTextSourceId) {
                                  const trimmed = textAreaValue.trim()
                                  if (!trimmed) return
                                  setSources(prev => prev.map(s =>
                                    s.id === editingTextSourceId
                                      ? { ...s, content: trimmed, label: trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '') }
                                      : s
                                  ))
                                  setEditingTextSourceId(null)
                                  setShowTextArea(false)
                                  setTextAreaValue('')
                                } else {
                                  addTextSource()
                                }
                              }}
                              disabled={!textAreaValue.trim()}
                            >
                              {editingTextSourceId ? 'Save' : 'Add Text'}
                            </button>
                            <button
                              className="btn-sm-secondary"
                              onClick={() => { setShowTextArea(false); setTextAreaValue(''); setEditingTextSourceId(null) }}
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
                            <span className="source-roster-title-group">
                              <span className="source-roster-title">Added Sources</span>
                              <span className="source-count">{sources.length}</span>
                            </span>
                            <button
                              onClick={() => { setSources([]); resetSession() }}
                              className="clear-all-sources-btn"
                            >
                              Clear All
                            </button>
                          </div>
                          {sources.map(source => {
                            const isEditing = editingSourceId === source.id
                            const href = !isEditing && (source.type === 'youtube' || source.type === 'url')
                              ? source.content
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
                                  <a href={href} target="_blank" rel="noopener noreferrer" className="source-item-label" title={source.content} style={{ color: 'var(--accent-primary)', textDecoration: 'none' }} onClick={e => e.stopPropagation()}>{source.label}</a>
                                ) : (
                                  <span className="source-item-label" title={source.content || source.label}>{source.label}</span>
                                )}
                                {!isEditing && (source.type === 'text' || source.type === 'file') && (
                                  <button
                                    className="source-remove-btn"
                                    onClick={() => {
                                      if (source.type === 'text') {
                                        setEditingTextSourceId(source.id)
                                        setTextAreaValue(source.content)
                                        setShowTextArea(true)
                                        setShowUrlInput(false)
                                      } else {
                                        setEditingSourceId(source.id)
                                        setEditingValue(source.label)
                                      }
                                    }}
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





                      {/* Empty state hint */}
                      {sources.length === 0 && !showTextArea && !showUrlInput && (
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
                              : 'Takes a couple minutes'}
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
                    </div>
                  )}

                  {/* Conversation phase: show sources in the empty area */}
                  {(sessionPhase === 'conversation' || (sessionPhase === 'complete' && hasStarted)) && (
                    <div className="flex flex-col gap-4">
                      {/* Grounding sources from the AI */}
                      {groundingSources.length > 0 && (
                        <div className="source-roster">
                          <div className="source-roster-header">
                            <span className="source-roster-title">References</span>
                            <span className="source-count">{groundingSources.length}</span>
                          </div>
                          {groundingSources.slice(0, 12).map((s, i) => (
                            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="source-item" style={{ textDecoration: 'none', cursor: 'pointer' }}>
                              <div className="source-item-icon"><LinkIcon className="w-4 h-4" /></div>
                              <span className="source-item-label" style={{ color: 'var(--accent-primary)' }}>{s.title.length > 45 ? s.title.slice(0, 43) + '…' : s.title}</span>
                            </a>
                          ))}
                        </div>
                      )}

                      {/* Original sources */}
                      {sources.length > 0 && (
                        <div className="source-roster">
                          <div className="source-roster-header">
                            <span className="source-roster-title">Your Sources</span>
                            <span className="source-count">{sources.length}</span>
                          </div>
                          {sources.map(source => (
                            <div key={source.id} className="source-item">
                              <div className="source-item-icon">{getSourceIcon(source.type)}</div>
                              <span className="source-item-label">{source.label}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ===== Pinned bottom actions ===== */}
                <div className="sidebar-pinned-bottom">
                  {/* Idle: Create button (always visible) */}
                  {sessionPhase === 'idle' && (
                    <div className="w-full flex flex-col gap-4">
                      <div className="button-group w-full">
                        <button
                          className="w-full py-3 px-6 bg-[var(--accent-primary)] hover:bg-[#0a48ad] text-white rounded-full font-semibold transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
                          onClick={() => {
                            if (sources.length === 0) {
                              setError('Add at least one source first.')
                              return
                            }
                            startSession()
                          }}
                          disabled={isConnecting}
                          style={isConnecting ? { opacity: 0.8 } : undefined}
                        >
                          {isConnecting
                            ? <span className="spinner" style={{ width: 18, height: 18 }}></span>
                            : <><SparklesIcon className="w-5 h-5" /> Create Interactive Graphic</>
                          }
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Processing: Cancel button */}
                  {isProcessing && (
                    <button
                      onClick={() => { disconnect(); setSessionPhase('idle'); }}
                      className="w-full py-2.5 px-4 rounded-xl border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-all duration-200 text-sm font-medium"
                    >
                      Cancel Generation
                    </button>
                  )}

                  {/* Complete: Graphic Ready + Start Live + New Graphic */}
                  {sessionPhase === 'complete' && !hasStarted && (
                    <div className="sidebar-actions-area">
                      <div className="status-indicator mb-4">
                        <div className={getPhaseDotClass()}></div>
                        <div className="status-text">
                          <span className="status-phase-label">Graphic Ready!</span>
                          <span className="status-detail">Your interactive graphic is ready to explore</span>
                        </div>
                      </div>

                      <button
                        onClick={startPresentation}
                        onPointerEnter={prepareLive}
                        onPointerDown={prepareLive}
                        disabled={isStartingConversation}
                        className={`w-full py-3 px-6 ${isStartingConversation ? 'bg-[#0a48ad] opacity-80' : 'bg-[var(--accent-primary)] hover:bg-[#0a48ad]'} text-white rounded-full font-semibold transition-all flex items-center justify-center gap-2 shadow-sm hover:shadow-md`}
                      >
                        {isStartingConversation ? (
                          <><span className="spinner" style={{ width: 18, height: 18 }} /> Connecting...</>
                        ) : (
                          <><MicIcon className="w-5 h-5" /> Start Live Conversation</>
                        )}
                      </button>

                      <button
                        onClick={resetSession}
                        className="w-full py-2.5 px-6 mt-3 bg-white border border-slate-200 text-slate-600 rounded-full font-medium transition-all flex items-center justify-center gap-2 hover:bg-slate-50 hover:border-slate-300"
                      >
                        <RefreshIcon className="w-4 h-4" /> New Graphic
                      </button>
                    </div>
                  )}

                  {/* Conversation: Live indicator + End button */}
                  {(sessionPhase === 'conversation' || (sessionPhase === 'complete' && hasStarted)) && (
                    <div className="sidebar-actions-area">
                      <div className="status-indicator mb-4">
                        <div className={getPhaseDotClass()}></div>
                        <div className="status-text">
                          <span className="status-phase-label">Live Conversation</span>
                          <span className="status-detail">Use a mic for smoother experience</span>
                        </div>
                      </div>

                      <div className="conversation-hint">
                        <MicIcon className="w-8 h-8 opacity-30 mb-3" />
                        <p>Speak to ask questions about any part of the graphic, or ask Narluga to control interactions for you</p>
                        <p className="text-xs opacity-60 mt-1">Click/hover on elements in the graphic to explore and listen to explanations</p>
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
            </div>

            {/* MIDDLE PANEL: Interactive Graphic */}
            <div className={`flex-1 flex flex-col relative w-full h-full${(currentSvg || isProcessing) ? ' nblm-card' : ''}`}>
              {!isSidebarOpen && (
                <button onClick={() => setIsSidebarOpen(true)} className="absolute top-[12px] left-[12px] w-8 h-8 bg-slate-100 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors text-slate-600 z-10" title="Expand sidebar">
                  <ChevronRightIcon className="w-5 h-5" />
                </button>
              )}
              {(currentSvg || isProcessing) && (
                <div className="nblm-header flex items-center">
                  <span className={`flex items-center gap-2 text-[var(--accent-primary)] transition-all ${!isSidebarOpen ? 'ml-8' : ''}`}>
                    <SparklesIcon className="w-5 h-5" /> Interactive Graphic
                  </span>
                </div>
              )}

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
              ) : isProcessing ? (
                <div className="flex-1 bg-transparent flex items-center justify-center p-8">
                  <div className="bg-white p-12 flex flex-col items-center justify-center text-center max-w-[400px]">
                    <div className="processing-spinner mb-6"></div>
                    <h3 className="text-xl font-medium text-[var(--text-primary)] mb-2">
                      {sessionPhase === 'analyzing' ? 'Analyzing Sources...' : 'Designing Interactive Graphic...'}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                      {sessionPhase === 'analyzing'
                        ? 'Reading and understanding your sources...'
                        : 'This usually takes 30–60 seconds'}
                    </p>
                  </div>
                </div>
              ) : (() => {
                const userSlice = savedGraphics.slice(0, 9)
                const filler = userSlice.length < 9 && userSlice.length > 0
                  ? publicExamples.filter(pe => !userSlice.some(u => u.id === pe.id)).slice(0, 9 - userSlice.length)
                  : []
                const examples = userSlice.length > 0 ? [...userSlice, ...filler] : publicExamples
                return examples.length > 0 ? (
                  <div className="example-container">
                    <div className="example-grid">
                      {examples.map(g => (
                        <div
                          key={g.id}
                          className="example-card"
                          onClick={() => loadExample(g)}
                        >
                          <div className="example-card-preview">
                            <SvgThumbnail svgHtml={g.svg_html} />
                          </div>
                          <div className="example-card-info">
                            <h3 className="example-card-title">{g.title}</h3>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 bg-transparent flex items-center justify-center p-8">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="w-12 h-12 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center">
                        <SparklesIcon className="w-6 h-6 text-[var(--text-tertiary)]" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[var(--text-secondary)]">Add sources to generate an interactive graphic</p>
                        <p className="text-xs text-[var(--text-tertiary)] mt-1">URLs, YouTube videos, text, or files</p>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          </section>
        </main>
      </div>
    </>
  )
}

export default App
