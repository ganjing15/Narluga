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
| **Firebase SDK** | Authentication (Google Sign-In) and Firestore database interactions |
| **Web Audio API** | Real-time audio playback from Gemini Live API |
| **AudioWorklet** | Mic capture → PCM encoding for Gemini |

### Backend
| Technology | Purpose |
|---|---|
| **FastAPI** | REST + WebSocket server |
| **Python 3** | Runtime |
| **google-genai** | Gemini SDK (standard + Live API) |
| **firebase-admin** | Firebase Admin SDK for auth token verification |
| **Gemini 3.1 Pro Preview** | Interactive graphic generation (SVG + controls) |
| **Gemini 2.5 Flash Native Audio Preview** | Live voice conversation (`gemini-2.5-flash-native-audio-preview-12-2025`) |
| **aiohttp** + **BeautifulSoup** | Website scraping |
| **Supadata API** | YouTube transcript extraction (falls back to Gemini audio transcription) |
| **uvicorn** | ASGI server |

### Infrastructure
| Service | Purpose |
|---|---|
| **GCP e2-micro VM** | Always-on, free-tier Debian VM hosting the backend |
| **Docker** | Containerizing the FastAPI backend application |
| **Caddy** | Reverse proxy on the VM providing auto-SSL (Let's Encrypt) |
| **Firebase Hosting** | Static file hosting and global CDN for the frontend SPA |
| **Cloud Firestore** | NoSQL database storing user-generated graphics and metadata |
| **DuckDNS** | Free dynamic DNS providing the backend domain (`narluga.duckdns.org`) |

---

## Architecture

```
┌─────────────────┐      WebSocket / HTTPS   ┌──────────────────┐
│                 │  ◄─────────────────────► │                  │
│   React SPA     │   init_sources →         │   FastAPI Server │
│ (Firebase Host) │   ← phase/status         │  (GCP e2-micro VM)│
│                 │   ← interactive_svg      │                  │
│                 │   ← audio chunks         │                  │
└────────┬────────┘                          └────────┬─────────┘
         │                                            │
  Firebase Auth                               ┌───────▼──────────┐
  (Google Auth)                               │  Gemini API      │
         │                                    │  3.1 Pro Preview │
         ▼                                    │  (graphic gen)   │
  Cloud Firestore                             │                  │
  (Saved Graphics)                            │  2.5 Flash Audio │
         ▲                                    │  (live voice)    │
         │                                    └──────────────────┘
         └────────────────────────────────────────────┘
         (Auto-saves graphics when generated)
```

### Communication Flow
1. **Frontend** sends `init_sources` message over WebSocket with an array of `{ type, content, label }` objects and an optional auth token.
2. **Backend** authenticates the user (if token provided) and aggregates content from all sources (scraping URLs, fetching YouTube transcripts, reading uploaded files).
3. **Backend** sends `phase` messages (`analyzing` → `designing` → `complete`).
4. **Backend** calls Gemini Pro to generate the interactive SVG + controls.
5. **Backend** sends `interactive_svg` message with `svg_html`, `controls_html`, `title`, `subtitle`.
6. **Frontend** automatically saves the received graphic payload to **Cloud Firestore** if the user is signed in.
7. When the user starts a live conversation, frontend sends `start_live_session`. Backend immediately sends `phase:conversation` back (before Gemini connects), then connects to Gemini Live API.
8. Audio streams bidirectionally via the WebSocket (PCM ↔ base64).
9. When the user ends the conversation, frontend sends `end_live_session`. The **WebSocket stays open** — backend closes only the Gemini session and loops back to waiting for the next `start_live_session`. This allows fast reconnect on subsequent starts without WS/auth overhead.

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
│
├── deploy/
│   ├── README.md                  # Deployment documentation
│   ├── provision.sh               # Create GCP VM, static IP, firewall
│   ├── setup-vm.sh                # Install Docker + Caddy on VM
│   ├── deploy-backend.sh          # Build & deploy backend container
│   ├── deploy-frontend.sh         # Build & deploy frontend to Firebase
│   ├── teardown.sh                # Delete all GCP resources
│   └── Caddyfile                  # Caddy reverse proxy config
│
├── firebase.json                  # Firebase Hosting config
├── firestore.rules                # Firestore security rules
├── .firebaserc                    # Firebase project alias
└── CONTEXT.md                     # This file
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
- An intermediate tracking script is dynamically injected into the iframe to restore telemetry and fix common generation bugs:
  - **Hover Tracking**: 1500ms debounced cursor position tracking that pauses during CSS animations. Distinguishes between SVG area and controls panel — reports the actual control name (e.g. `"Play" button in the controls panel`) when cursor is over controls, not a stale SVG label. Nearest-label proximity radius is **20px** (down from 60-150px) to prevent false "you're pointing at X" reports when the cursor is just passing through. Stale timers are cancelled when cursor leaves the SVG area.
  - **Interaction Tracking**: Uses `{capture: true}` on the click listener so `beforeLabel` is captured *before* any button's own `onclick` updates the DOM (fixes systematic play/pause state inversion). 50ms debounce. Calls `clearAudioNow()` immediately on click so AI audio stops at the moment of interaction rather than after a Gemini round-trip.
  - **`sendEventToAI` Rate Limiting**: Generated graphics call `window.sendEventToAI()` for both user actions and auto-play animation milestones. Uses semantic click detection via `lastClickTriggeredAtRef` (set when `INTERACTION_EVENT` or `CLICK_RESULT` fires) to distinguish the two: click-triggered events send in 150ms; automatic animation steps are throttled to at most one per 2.5s so the AI has time to finish narrating each point.
  - **Interval Stacking Protection**: A `setInterval`/`clearInterval` monkey-patch prevents a common AI generation bug where toggle buttons create new intervals without clearing old ones. All intervals are tracked and force-cleared when a pause state is detected.
  - Telemetry is sent via `postMessage` to the parent window and forwarded to the AI.
- Each graphic is auto-saved to `backend/generated_graphics/` as a standalone HTML file.

### Live Voice Conversation
- Uses Gemini Live API (`gemini-2.5-flash-native-audio-preview`)
- Bidirectional audio: mic → PCM 16kHz → Gemini → 24kHz audio → speaker
- AI is contextually aware of the graphic via narration context
- Supports interruptions and event-driven context updates
  - *Note*: The native-audio model handles Voice Activity Detection (VAD) automatically. Custom `RealtimeInputConfig` settings are not supported (causes 1008 API error).
  - During a voice interruption, **actionable tools** (`click_element`, `modify_element`, `fetch_more_detail`) are always executed to ensure responsiveness, while cosmetic tools (`highlight_element`, `zoom_view`) are skipped.
- **Fast connection**: `phase:conversation` is sent to the frontend immediately upon receiving `start_live_session` (before Gemini connects), so the UI transitions instantly. The Gemini handshake (~0.3s) and initial prompt happen in parallel. No audio wait before sending the initial prompt — mic audio is already flowing from the frontend.
- **Multi-session WebSocket**: The WebSocket between frontend and backend stays open after "End Conversation". The frontend sends `end_live_session` (instead of closing the WS), which closes the Gemini session but keeps the WS alive. The backend loops back to waiting for the next `start_live_session`. This means the second and subsequent conversations use the same fast path as the first (~3s to first AI audio), with no reconnect overhead.
- **Mic prefetch removed**: The `onMouseEnter` hover prefetch on the "Start Live Conversation" button was removed. It caused the browser mic indicator to reappear after ending a conversation (the button re-rendered under the cursor, triggering mic re-acquisition). Mic is now acquired on-demand when the user clicks.
- **Language lock**: The system instruction begins with an explicit `LANGUAGE RULE` — respond in the user's spoken language, never switch based on diagram content or source material. This prevents the AI from drifting into the language of the source content mid-conversation.

#### Connection Timing (measured)
| Step | Duration |
|------|----------|
| `start_live_session` received → `phase:conversation` sent | ~0ms |
| Gemini `live.connect()` | ~0.2–0.3s |
| Initial prompt sent | ~0ms |
| First AI audio chunk arrives | ~2.5–3.2s total |

#### WebSocket Message Protocol (live session)
| Direction | Message type | Description |
|-----------|-------------|-------------|
| Frontend → Backend | `start_live_session` | User clicked Start; includes `pre_events` array |
| Frontend → Backend | `end_live_session` | User clicked End; Gemini closes, WS stays open |
| Frontend → Backend | `realtimeInput` | PCM audio chunk (base64) |
| Frontend → Backend | `clientContent` | Text event (cursor position, interaction) |
| Backend → Frontend | `phase` | Session phase change (`conversation`, `complete`, etc.) |
| Backend → Frontend | `ready` | Gemini connected and ready |
| Backend → Frontend | `audio` | 24kHz PCM audio chunk from Gemini |
| Backend → Frontend | `tool_action` | AI tool call to execute in iframe |
| Backend → Frontend | `clear` | Interrupt — stop playing queued audio |

### Agentic Tool Use (Live Session)
The AI ("Narluga") proactively uses tools to manipulate the diagram inside the iframe sandbox while speaking:
- **`highlight_element`** — Pulse/glow a diagram element with colored drop-shadow animation
- **`modify_element`** — Dynamically updates CSS properties in real-time. Explicitly supports `scale`, `fill`, `opacity`, `display`, and `filter`. The `element_id` must be a human-readable keyword, not a CSS selector. Includes special handling for SVG `transform-origin` to prevent position shifting when scaling.
- **`click_element`** — Programmatically triggers a click on buttons or inputs in the controls panel. Automatically force-clears existing intervals before clicking play/toggle buttons to prevent stacking.
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
| `GITHUB_TOKEN` | Optional | GitHub API token for extending limits when scraping GitHub |
| `DISABLE_AUTH` | Optional | Set to `true` to disable Firebase Auth verification on the backend (useful for local dev or public demos) |
| `ALLOWED_ORIGINS` | Optional | Comma-separated list of allowed CORS origins. Defaults to `*`. |

Set in `backend/.env`.

### Frontend (.env and .env.production)

| Variable | Requirement | Description |
|---|---|---|
| `VITE_BACKEND_URL` | Local dev | Usually `http://localhost:8000` |
| `VITE_FIREBASE_API_KEY` | Production | Firebase configuration |
| `VITE_FIREBASE_AUTH_DOMAIN` | Production | Firebase configuration |
| `VITE_FIREBASE_PROJECT_ID` | Production | Firebase configuration |
| `VITE_FIREBASE_STORAGE_BUCKET`| Production | Firebase configuration |
| `VITE_FIREBASE_MESSAGING_SENDER_ID`| Production | Firebase configuration |
| `VITE_FIREBASE_APP_ID` | Production | Firebase configuration |
| `VITE_FIREBASE_MEASUREMENT_ID`| Production | Firebase configuration |

---

## Cloud Deployment

Narluga includes fully automated deployment scripts in `deploy/`. Deploy the entire stack from scratch:

```bash
./deploy/provision.sh <PROJECT_ID> <DOMAIN>      # GCP VM + IP + firewall
./deploy/setup-vm.sh <PROJECT_ID>                 # Install Docker + Caddy
./deploy/deploy-backend.sh <PROJECT_ID> <DOMAIN>  # Build & run backend
./deploy/deploy-frontend.sh <PROJECT_ID>           # Build & deploy frontend
```

All scripts are **idempotent** — safe to re-run. See [`deploy/README.md`](deploy/README.md) for full documentation.

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

## What Requires a Restart After Code Changes

| Changed file | What to do | Generate new graphic? |
|---|---|---|
| `frontend/src/App.tsx` or any frontend file | Vite HMR usually hot-reloads, but **refresh the browser (Cmd+R)** for changes involving refs, WebSocket state, or audio nodes | No |
| `backend/google_genai_service.py` or `backend/main.py` | **Restart the backend** (`Ctrl+C` then re-run `./venv/bin/python main.py`) | No (existing graphic stays loaded in the browser) |
| Changes to the **iframe injection script** (the large template literal in `App.tsx`) | Browser refresh is enough — the script is re-injected each time the graphic renders | No, but the new script only applies the **next time** a graphic is loaded into the iframe |
| Changes to the **Gemini prompt / SVG generation logic** | Backend restart + generate a new graphic | Yes |

> **Claude should always mention which of the above applies whenever making code changes.**

---

## Key Design Decisions

1. **WebSocket-first architecture** — All session state flows through a single WebSocket connection, enabling real-time phase updates and bidirectional audio streaming without polling.

2. **Persistent WebSocket for live sessions** — The WebSocket between frontend and backend is kept alive across multiple start/end conversation cycles. Only the Gemini session is torn down on "End Conversation"; the WS loops back to waiting for the next `start_live_session`. This avoids the ~5-7s reconnect overhead (new WS + auth token + restart context) on the second and subsequent sessions.

3. **Source aggregation before generation** — All sources are concatenated with labeled sections before being sent to Gemini, allowing the model to synthesize across multiple inputs.

4. **Embedded interactivity** — SVG graphics include inline `<script>` and `<style>` tags, making each generated graphic a self-contained interactive widget that also works as a standalone HTML file.

4. **No transcript log** — The sidebar intentionally omits verbose AI response logs, showing only phase-based status indicators for a cleaner UX.
