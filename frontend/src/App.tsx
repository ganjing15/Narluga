import { useState, useRef, type FormEvent, useEffect, useCallback } from 'react'
import './App.css'
import {
  MicIcon, StopIcon, DisplayIcon, SparklesIcon,
  ChevronLeftIcon, ChevronRightIcon,
  LinkIcon, YoutubeIcon, FileUploadIcon, TextIcon,
  CheckCircleIcon, XIcon, RefreshIcon, PlusIcon, NarlugaLogo
} from './Icons'

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
  const [inputValue, setInputValue] = useState('')
  const [showTextArea, setShowTextArea] = useState(false)
  const [textAreaValue, setTextAreaValue] = useState('')

  // Session state
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)

  // SVG display state
  const [currentSvg, _setCurrentSvg] = useState<string | null>(null)
  const currentSvgRef = useRef<string | null>(null)
  const setCurrentSvg = (svg: string | null) => {
    currentSvgRef.current = svg
    _setCurrentSvg(svg)
  }
  const [currentControls, setCurrentControls] = useState<string | null>(null)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null)

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

  // Detect input type from text
  const detectInputType = useCallback((text: string): { type: SourceType, label: string } => {
    const trimmed = text.trim()

    // YouTube detection
    if (/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)/.test(trimmed)) {
      const match = trimmed.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/)
      return { type: 'youtube', label: `YouTube: ${match ? match[1] : trimmed.slice(0, 40)}` }
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
        const response = await fetch('http://localhost:8000/upload', {
          method: 'POST',
          body: formData
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
  }, [])

  // Attach a global function so the generated SVG's <script> can send events to the Voice AI
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout>;

    (window as any).sendEventToAI = (textMessage: string) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const textPayload = `[System Status: The user just interacted with the dashboard UI. Action: ${textMessage}]`;
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
      }, 1000);
    };

    return () => {
      clearTimeout(debounceTimer);
      delete (window as any).sendEventToAI;
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
  }

  // Start session: connect WebSocket and send sources
  const startSession = async () => {
    if (sources.length === 0) return

    setIsConnecting(true)
    setError('')
    setSessionPhase('analyzing')
    setStatusMessage('Connecting...')

    try {
      const wsUrl = `ws://localhost:8000/ws/live`
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
          const svgContainer = document.querySelector('.w-full.flex-1.relative') as HTMLElement
          if (!svgContainer) return

          // Helper: find SVG elements by fuzzy text/ID match
          const findElements = (keyword: string): Element[] => {
            const kw = keyword.toLowerCase().replace(/[-_]/g, ' ')
            const results: Element[] = []
            // Match by id or data attributes
            svgContainer.querySelectorAll('[id], [data-label], [data-section]').forEach(el => {
              const id = (el.id || '').toLowerCase().replace(/[-_]/g, ' ')
              const label = (el.getAttribute('data-label') || '').toLowerCase()
              const section = (el.getAttribute('data-section') || '').toLowerCase()
              if (id.includes(kw) || kw.includes(id) || label.includes(kw) || section.includes(kw)) {
                results.push(el)
              }
            })
            // Match by visible text content in text/tspan/foreignObject elements
            if (results.length === 0) {
              svgContainer.querySelectorAll('text, tspan, foreignObject, h1, h2, h3, h4, p, span, div').forEach(el => {
                const text = (el.textContent || '').toLowerCase()
                if (text.includes(kw) || kw.split(' ').every(w => text.includes(w))) {
                  // Prefer the closest group parent (g, rect, circle) for visual highlighting
                  const parent = el.closest('g, [id]') || el
                  if (!results.includes(parent)) results.push(parent)
                }
              })
            }
            return results.slice(0, 5) // Cap at 5 matches
          }

          if (action === 'highlight_element') {
            const elements = findElements(params.element_id || '')
            const color = params.color || '#3b82f6'
            elements.forEach(el => {
              const htmlEl = el as HTMLElement | SVGElement
              const prev = htmlEl.style.cssText
              htmlEl.style.transition = 'all 0.4s ease'
              htmlEl.style.filter = `drop-shadow(0 0 16px ${color}) drop-shadow(0 0 8px ${color})`
              if (htmlEl instanceof SVGElement) {
                htmlEl.style.transform = 'scale(1.03)'
                htmlEl.style.transformOrigin = 'center'
              }
              setTimeout(() => {
                htmlEl.style.filter = ''
                htmlEl.style.transform = ''
                setTimeout(() => { htmlEl.style.cssText = prev }, 400)
              }, 4000)
            })
            if (elements.length > 0) {
              elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
            }
          } else if (action === 'navigate_to_section') {
            const elements = findElements(params.section || '')
            if (elements.length > 0) {
              elements[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
            }
          } else if (action === 'zoom_view') {
            const dir = params.direction || 'in'
            const currentScale = parseFloat(svgContainer.dataset.zoomScale || '1')
            let newScale: number
            if (dir === 'in') newScale = Math.min(currentScale * 1.4, 3)
            else if (dir === 'out') newScale = Math.max(currentScale / 1.4, 0.5)
            else newScale = 1 // reset
            svgContainer.style.transition = 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)'
            svgContainer.style.transform = `scale(${newScale})`
            svgContainer.style.transformOrigin = 'center center'
            svgContainer.dataset.zoomScale = newScale.toString()
          } else if (action === 'fetch_more_detail') {
            // Show a brief search indicator
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
        } else if (data.type === 'error') {
          setError(data.message)
          disconnect()
        }
      }

      ws.onclose = (event) => {
        if (!event.wasClean && event.code !== 1000 && event.code !== 1005) {
          setError(`Connection lost (${event.code}).`)
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
    setSources([])
    setCurrentSvg(null)
    setCurrentControls(null)
    setCurrentTitle(null)
    setCurrentSubtitle(null)
    setSessionPhase('idle')
    setStatusMessage('')
    setError('')
  }, [disconnect])

  const executeScripts = (node: HTMLDivElement | null) => {
    if (node) {
      const scripts = node.querySelectorAll('script');
      scripts.forEach(oldScript => {
        if (oldScript.getAttribute('data-executed')) return;
        try {
          const newScript = document.createElement('script');
          Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
          const scriptContent = oldScript.textContent || '';
          const scopedContent = `(function() {\n${scriptContent}\n})();`;
          newScript.appendChild(document.createTextNode(scopedContent));
          oldScript.setAttribute('data-executed', 'true');
          oldScript.parentNode?.replaceChild(newScript, oldScript);
        } catch (err) {
          console.error("Failed to execute SVG script:", err);
        }
      });
    }
  };

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
    <div className="app-wrapper">
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
            <button onClick={() => setIsSidebarOpen(false)} className="absolute top-[12px] right-[12px] w-8 h-8 bg-slate-100 flex items-center justify-center rounded-full hover:bg-slate-200 transition-colors text-slate-600 z-10" title="Collapse sidebar">
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
                        placeholder="Paste a URL, YouTube link, or topic..."
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
                      {sources.map(source => (
                        <div key={source.id} className="source-item">
                          <div className="source-item-icon">{getSourceIcon(source.type)}</div>
                          <span className="source-item-label">{source.label}</span>
                          <button
                            className="source-remove-btn"
                            onClick={() => removeSource(source.id)}
                            title="Remove source"
                          >
                            <XIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
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
                        {sessionPhase === 'analyzing' ? 'Analyzing Sources' : 'Designing Graphic'}
                      </span>
                      <span className="status-detail">{statusMessage}</span>
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

                  {/* Source summary */}
                  <div className="source-roster mt-6">
                    <div className="source-roster-header">
                      <span className="source-roster-title">Sources Used</span>
                    </div>
                    {sources.map(source => (
                      <div key={source.id} className="source-item">
                        <div className="source-item-icon">{getSourceIcon(source.type)}</div>
                        <span className="source-item-label">{source.label}</span>
                        <CheckCircleIcon className="w-4 h-4 text-emerald-500 ml-auto shrink-0" />
                      </div>
                    ))}
                  </div>
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

                  <button
                    onClick={resetSession}
                    className="w-full py-2.5 px-6 mt-3 bg-white border border-slate-200 text-slate-600 rounded-full font-medium transition-all flex items-center justify-center gap-2 hover:bg-slate-50 hover:border-slate-300"
                  >
                    <RefreshIcon className="w-4 h-4" /> New Graphic
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
              <div className="flex-1 overflow-hidden bg-transparent relative flex flex-row w-full h-full">
                {/* SVG Visual Area */}
                <div className="flex-1 h-full p-8 box-border flex flex-col">
                  {(currentTitle || currentSubtitle) && (
                    <div className="mb-6 flex-shrink-0">
                      {currentTitle && <h2 className="text-3xl font-bold text-slate-800 tracking-tight mb-2">{currentTitle}</h2>}
                      {currentSubtitle && <p className="text-lg text-slate-500">{currentSubtitle}</p>}
                    </div>
                  )}
                  <div
                    className="w-full flex-1 p-0 box-border flex items-center justify-center min-h-0 relative"
                    dangerouslySetInnerHTML={{ __html: currentSvg }}
                    ref={executeScripts}
                  />
                </div>
                {/* Embedded Studio Controls */}
                {currentControls && (
                  <div className={`shrink-0 h-full p-6 overflow-y-auto bg-white border-l border-slate-100 transition-all duration-300 ease-in-out ${isSidebarOpen ? 'basis-[380px]' : 'flex-[0.4] min-w-[420px] max-w-[500px]'}`}>
                    <div
                      className="w-full min-h-full p-0 box-border"
                      dangerouslySetInnerHTML={{ __html: currentControls }}
                      ref={executeScripts}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 bg-transparent flex items-center justify-center">
                <div className="bg-white p-12 flex flex-col items-center justify-center text-center max-w-[400px]">
                  {isProcessing ? (
                    <>
                      <div className="processing-spinner mb-6"></div>
                      <h3 className="text-xl font-medium text-[var(--text-primary)] mb-2">
                        {sessionPhase === 'analyzing' ? 'Analyzing Sources...' : 'Designing Graphic...'}
                      </h3>
                      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                        {statusMessage}
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
  )
}

export default App
