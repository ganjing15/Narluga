# CONTEXT.md — Narluga

## Overview

**Narluga** is a web application that transforms any content source (websites, YouTube videos, text notes, or uploaded files) into an interactive, animated SVG graphic with an optional live AI voice conversation. It is inspired by Google's NotebookLM.

The user adds one or more sources in the sidebar, and the app:
1. Fetches and aggregates content from all sources
2. Uses **Gemini** to generate an interactive SVG diagram with UI controls
3. Optionally starts a **live voice conversation** where the user can ask the AI to explain parts of the graphic in real time

---

## Tech Stack

### Frontend
| Technology | Purpose |
|---|---|
| **React 19** + **TypeScript** | UI framework |
| **Vite 7** | Dev server and bundler |
| **Tailwind CSS 4** | Utility-first CSS (used alongside vanilla CSS) |
| **Web Audio API** | Real-time audio playback from Gemini Live API |
| **AudioWorklet** | Mic capture → PCM encoding for Gemini |

### Backend
| Technology | Purpose |
|---|---|
| **FastAPI** | REST + WebSocket server |
| **Python 3** | Runtime |
| **google-genai** | Gemini SDK (standard + Live API) |
| **Gemini 3.1 Pro Preview** | Interactive graphic generation (SVG + controls) |
| **Gemini 2.5 Flash Native Audio Preview** | Live voice conversation (`gemini-2.5-flash-native-audio-preview-12-2025`) |
| **aiohttp** + **BeautifulSoup** | Website scraping |
| **Supadata API** | YouTube transcript extraction (falls back to Gemini audio transcription) |
| **uvicorn** | ASGI server |

---

## Architecture

```
┌─────────────────┐      WebSocket       ┌──────────────────┐
│                 │  ◄──────────────────► │                  │
│   React SPA     │   init_sources →      │   FastAPI Server │
│   (Vite dev)    │   ← phase/status      │   (Python)       │
│   Port 5173     │   ← interactive_svg   │   Port 8000      │
│                 │   ← audio chunks      │                  │
└─────────────────┘                       └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  Gemini API      │
                                          │  3.1 Pro Preview │
                                          │  (graphic gen)   │
                                          │                  │
                                          │  2.5 Flash Audio │
                                          │  (live voice)    │
                                          └──────────────────┘
```

### Communication Flow
1. **Frontend** sends `init_sources` message over WebSocket with an array of `{ type, content, label }` objects
2. **Backend** aggregates content from all sources (scraping URLs, fetching YouTube transcripts, reading uploaded files)
3. **Backend** sends `phase` messages (`analyzing` → `designing` → `complete`)
4. **Backend** calls Gemini Pro to generate the interactive SVG + controls
5. **Backend** sends `interactive_svg` message with `svg_html`, `controls_html`, `title`, `subtitle`
6. When the user starts a live conversation, frontend sends `start_live_session`
7. **Backend** connects to Gemini Live API for real-time voice interaction
8. Audio streams bidirectionally via the WebSocket (PCM ↔ base64)

---

## Project Structure

```
Gemini Live Agent Challenge/
├── backend/
│   ├── main.py                    # FastAPI server, WebSocket + /upload endpoint
│   ├── google_genai_service.py    # Core logic: source aggregation, Gemini calls, Live session
│   ├── requirements.txt           # Python dependencies
│   ├── generated_graphics/        # Saved HTML files of generated graphics
│   └── .env                       # GEMINI_API_KEY, SUPADATA_API_KEY
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                # Main React component (sidebar + graphic display)
│   │   ├── App.css                # All application styles
│   │   ├── Icons.tsx              # SVG icon components
│   │   ├── index.css              # Base/reset styles
│   │   └── main.tsx               # React entry point
│   ├── index.html                 # HTML shell
│   ├── package.json               # Node dependencies
│   ├── vite.config.ts             # Vite configuration
│   └── tailwind.config.js         # Tailwind configuration
```

---

## Features

### Multi-Source Input
- **Website URLs** — Scraped via aiohttp + BeautifulSoup, images converted to markers
- **YouTube URLs** — Transcript extracted via Supadata API (falls back to scraping)
- **Text Notes** — Pasted directly; short inputs (<100 words) activate Google Search grounding
- **File Upload** — `.txt`, `.md` parsed as UTF-8; `.pdf` via PyPDF2 (optional)

### Interactive Graphic Generation
- Gemini Pro generates a complete SVG animation and HTML controls panel.
- To prevent CSS/JS conflicts with the main React app, the generated graphic is securely isolated inside a **sandboxed iframe**.
- An intermediate tracking script is dynamically injected into the iframe to restore telemetry:
  - **Hover Tracking**: Debounced cursor position tracking that pauses during CSS animations.
  - **Interaction Tracking**: Global listeners that capture slider drags and button clicks in the controls pane.
  - Telemetry is sent via `postMessage` to the parent window and forwarded to the AI.
- Each graphic is auto-saved to `backend/generated_graphics/` as a standalone HTML file.

### Live Voice Conversation
- Uses Gemini Live API (`gemini-2.5-flash-native-audio-preview`)
- Bidirectional audio: mic → PCM 16kHz → Gemini → 24kHz audio → speaker
- AI is contextually aware of the graphic via narration context
- Supports interruptions and event-driven context updates

### Agentic Tool Use (Live Session)
The AI ("Narluga") proactively uses tools to manipulate the diagram inside the iframe sandbox while speaking:
- **`highlight_element`** — Pulse/glow a diagram element with colored drop-shadow animation
- **`modify_element`** — Dynamically updates SVG attributes (`r`, `cx`, `width`, `fill`, etc.) or CSS properties in real-time, allowing for structural resizing or color changes.
- **`click_element`** — Programmatically triggers a click on buttons or inputs in the controls panel.
- **`navigate_to_section`** — Smooth scroll the viewport to focus on a section
- **`zoom_view`** — Zoom in for details, zoom out for overview, or reset
- **`fetch_more_detail`** — Query Google Search for supplementary info when the user asks beyond the diagram's scope

Tools are called autonomously by Gemini during conversation — the AI decides when to highlight, navigate, change attributes, or click controls as it explains concepts.

### Sidebar UI
- Phase-based status indicators: `Analyzing` → `Designing` → `Complete` → `Conversation`
- Source roster with type icons and remove functionality
- Collapsible sidebar with smooth transitions

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `SUPADATA_API_KEY` | Optional | Supadata API key for YouTube transcript extraction |

Set in `backend/.env`.

---

## Running Locally

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
./venv/bin/python main.py          # Starts on port 8000

# Frontend
cd frontend
npm install
npm run dev                        # Starts on port 5173
```

---

## Key Design Decisions

1. **WebSocket-first architecture** — All session state flows through a single WebSocket connection, enabling real-time phase updates and bidirectional audio streaming without polling.

2. **Source aggregation before generation** — All sources are concatenated with labeled sections before being sent to Gemini, allowing the model to synthesize across multiple inputs.

3. **Embedded interactivity** — SVG graphics include inline `<script>` and `<style>` tags, making each generated graphic a self-contained interactive widget that also works as a standalone HTML file.

4. **No transcript log** — The sidebar intentionally omits verbose AI response logs, showing only phase-based status indicators for a cleaner UX.
