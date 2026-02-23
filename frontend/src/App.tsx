import { useState, useRef, type FormEvent, useEffect, useCallback, useMemo } from 'react'
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
  const [, setStatusMessage] = useState('')
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

      const wsUrl = `ws://localhost:8000/ws/live-restart`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setIsConnecting(false)
        // Send restart context
        ws.send(JSON.stringify({
          type: "restart_live",
          narration_context: narrationContextRef.current,
          source_labels: sourceLabelsRef.current
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
          // Store narration context for conversation restart
          if (data.narration_context) narrationContextRef.current = data.narration_context
          if (data.source_labels) sourceLabelsRef.current = data.source_labels
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
          const svgContainer = document.querySelector('[data-svg-container]') as HTMLElement
          if (!svgContainer) return

          // Helper: find SVG elements by fuzzy text/ID match
          const findElements = (keyword: string): Element[] => {
            const kw = keyword.toLowerCase().replace(/[-_]/g, ' ').trim()
            if (!kw) return []
            const results: Element[] = []
            const containerRect = svgContainer.getBoundingClientRect()

            // Skip elements that are too large (>60% of container = probably a wrapper)
            const isTooLarge = (el: Element): boolean => {
              const rect = el.getBoundingClientRect()
              return rect.width > containerRect.width * 0.6 && rect.height > containerRect.height * 0.6
            }

            // 1. Match by id or data attributes (exact-ish match)
            svgContainer.querySelectorAll('[id], [data-label], [data-section]').forEach(el => {
              const id = (el.id || '').toLowerCase().replace(/[-_]/g, ' ')
              const label = (el.getAttribute('data-label') || '').toLowerCase()
              const section = (el.getAttribute('data-section') || '').toLowerCase()
              // Only match if id is meaningful (3+ chars) and keyword is contained in it
              if ((id.length >= 3 && id.includes(kw)) || label.includes(kw) || section.includes(kw)) {
                if (!isTooLarge(el)) results.push(el)
              }
            })

            // 2. Match by visible text content — target the text element itself, not a parent
            if (results.length === 0) {
              svgContainer.querySelectorAll('text, tspan, foreignObject, h1, h2, h3, h4, p, span, label, button').forEach(el => {
                const text = (el.textContent || '').toLowerCase().trim()
                if (text.length > 0 && text.length < 200 && (text.includes(kw) || kw.split(' ').every(w => text.includes(w)))) {
                  // For SVG text elements, go up ONE level to the immediate parent <g> only
                  let target: Element = el
                  if (el instanceof SVGElement && el.parentElement && el.parentElement.tagName.toLowerCase() === 'g') {
                    target = el.parentElement
                  }
                  if (!isTooLarge(target) && !results.includes(target)) results.push(target)
                }
              })
            }

            // Sort by size (smaller = more specific = better)
            results.sort((a, b) => {
              const aRect = a.getBoundingClientRect()
              const bRect = b.getBoundingClientRect()
              return (aRect.width * aRect.height) - (bRect.width * bRect.height)
            })

            return results.slice(0, 3) // Cap at 3 best matches
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
          } else if (action === 'modify_element') {
            const elements = findElements(params.element_id || '')
            const prop = params.css_property || ''
            const val = params.value || ''
            elements.forEach(el => {
              const htmlEl = el as HTMLElement | SVGElement
              htmlEl.style.transition = 'all 0.5s ease'
              // Handle SVG-specific attributes that work better as attributes than CSS
              if (htmlEl instanceof SVGElement && ['fill', 'stroke', 'opacity', 'stroke-width'].includes(prop)) {
                htmlEl.setAttribute(prop, val)
              } else {
                // Convert kebab-case to camelCase for style property
                const camelProp = prop.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
                  ; (htmlEl.style as any)[camelProp] = val
              }
            })
            if (elements.length > 0) {
              // Brief highlight to show what changed
              const el = elements[0] as HTMLElement | SVGElement
              const prevFilter = el.style.filter
              el.style.filter = 'drop-shadow(0 0 8px #3b82f6)'
              setTimeout(() => { el.style.filter = prevFilter }, 1500)
            }
          } else if (action === 'click_element') {
            // Search both SVG container and controls panel for clickable elements
            const kw = (params.element_id || '').toLowerCase().trim()
            if (!kw) return
            const containers = document.querySelectorAll('[data-svg-container], [data-controls-container]')
            let clicked = false
            containers.forEach(container => {
              if (clicked) return
              // Search buttons, inputs, and anything with onclick
              container.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="range"], a, [onclick], [role="button"]').forEach(el => {
                if (clicked) return
                const text = (el.textContent || '').toLowerCase().trim()
                const id = (el.id || '').toLowerCase()
                const title = (el.getAttribute('title') || '').toLowerCase()
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase()
                if (text.includes(kw) || kw.includes(text) || id.includes(kw) || title.includes(kw) || ariaLabel.includes(kw)) {
                  // Visual flash before clicking
                  const htmlEl = el as HTMLElement
                  htmlEl.style.transition = 'all 0.2s ease'
                  htmlEl.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.5)'
                  setTimeout(() => {
                    htmlEl.style.boxShadow = ''
                    htmlEl.click()
                  }, 300)
                  clicked = true
                }
              })
            })
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
        if (!kw) return;
        const containers = document.querySelectorAll('.svg-area, .controls-area');
        let clicked = false;
        containers.forEach(container => {
          if (clicked) return;
          container.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="checkbox"], input[type="range"], a, [onclick], [role="button"]').forEach(el => {
            if (clicked) return;
            const text = (el.textContent || '').toLowerCase().trim();
            const id = (el.id || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            if (text.includes(kw) || kw.includes(text) || id.includes(kw) || title.includes(kw) || ariaLabel.includes(kw)) {
              el.style.transition = 'all 0.2s ease';
              el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.5)';
              setTimeout(() => {
                el.style.boxShadow = '';
                el.click();
              }, 300);
              clicked = true;
            }
          });
        });
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

      if (!report || report === report) return;
      lastReport = report;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        window.parent.postMessage({ type: 'HOVER_EVENT', payload: report }, '*');
      }, 1500);
    });

    // --- INTERACTION TRACKING ---
    // Automatically tell the parent when the user clicks a button or changes an input
    ['click', 'change'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        let target = e.target;
        // Find the closest interactive element (button, a, input, select)
        const interactiveEl = target.closest('button, a, input, select, [role="button"]');
        if (!interactiveEl) return;
        
        let label = (interactiveEl.innerText || interactiveEl.value || interactiveEl.id || interactiveEl.getAttribute('aria-label') || '').trim();
        // If it's a structural click that happened to hit a giant container without a specific label, ignore it
        if (!label || label.length > 50) return;
        
        let actionDesc = eventType === 'click' ? '"' + label + '" clicked' : '"' + label + '" changed to "' + interactiveEl.value + '"';
        window.parent.postMessage({ type: 'INTERACTION_EVENT', payload: actionDesc }, '*');
      });
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
  )
}

export default App
