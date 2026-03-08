from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import os
import json
import time
from collections import defaultdict
from dotenv import load_dotenv
from google_genai_service import handle_live_session, handle_live_restart, web_search_sources
from auth import init_firebase, FirebaseAuthMiddleware, verify_ws_token

# ---------------------------------------------------------------------------
# Per-UID rate limiter (in-memory, resets on server restart)
# Protects against public abuse while keeping costs bounded for the contest.
# Judges can always get a fresh count if needed (just restart the backend).
# ---------------------------------------------------------------------------
_uid_session_timestamps: dict[str, list[float]] = defaultdict(list)
SESSION_LIMIT_PER_UID_PER_DAY = 5   # max live sessions per user per 24h
_SECONDS_IN_DAY = 86400

def _check_rate_limit(uid: str) -> bool:
    """Return True if user is within their daily session limit, False if exceeded."""
    now = time.time()
    cutoff = now - _SECONDS_IN_DAY
    # Remove timestamps older than 24 h
    _uid_session_timestamps[uid] = [t for t in _uid_session_timestamps[uid] if t > cutoff]
    if len(_uid_session_timestamps[uid]) >= SESSION_LIMIT_PER_UID_PER_DAY:
        return False
    # Record this session start
    _uid_session_timestamps[uid].append(now)
    return True

load_dotenv()

# Initialize Firebase Admin SDK
init_firebase()

app = FastAPI()

# CORS: allow frontend origins
# In production, set ALLOWED_ORIGINS env var to your Firebase Hosting domain
allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Firebase Auth middleware for HTTP routes
# Set DISABLE_AUTH=true for local development without Firebase
if os.getenv("DISABLE_AUTH", "").lower() != "true":
    app.add_middleware(FirebaseAuthMiddleware)

@app.get("/")
def read_root():
    return {"message": "Narluga API is running"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Extract text content from an uploaded file (.txt, .md, .pdf)."""
    try:
        filename = file.filename or "unknown"
        ext = os.path.splitext(filename)[1].lower()
        
        content_bytes = await file.read()
        
        if ext in [".txt", ".md"]:
            text_content = content_bytes.decode("utf-8", errors="replace")
        elif ext == ".pdf":
            try:
                import PyPDF2
                import io
                reader = PyPDF2.PdfReader(io.BytesIO(content_bytes))
                pages = []
                for page in reader.pages:
                    pages.append(page.extract_text() or "")
                text_content = "\n\n".join(pages)
            except ImportError:
                text_content = "[PDF parsing requires PyPDF2. Install with: pip install PyPDF2]"
        else:
            text_content = content_bytes.decode("utf-8", errors="replace")
        
        return {
            "status": "success",
            "filename": filename,
            "content": text_content[:50000],  # Cap at 50k chars
            "length": len(text_content)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


from pydantic import BaseModel

class SearchRequest(BaseModel):
    query: str
    depth: str = "fast"   # "fast" | "deep"

@app.post("/search")
async def search_web(req: SearchRequest):
    """Search the web for relevant sources using Gemini + Google Search grounding.
    Returns a list of {title, url, snippet} result objects."""
    try:
        results = await web_search_sources(req.query, req.depth)
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    print("[WebSocket] Received connection request!")
    await websocket.accept()
    print("[WebSocket] Connection accepted.")

    try:
        # Verify Firebase token for WebSocket connections
        if os.getenv("DISABLE_AUTH", "").lower() != "true":
            print("[WebSocket] Verifying Firebase token...")
            user = await verify_ws_token(websocket)
            if user is None:
                print("[WebSocket] User is None, token verification failed. Returning.")
                return  # Connection was closed by verify_ws_token
            print(f"[WebSocket] Authenticated user: {user.get('email', user.get('uid', 'unknown'))}")
            # --- Per-UID rate limit check ---
            uid = user.get('uid', 'anonymous')
            if not _check_rate_limit(uid):
                print(f"[WebSocket] Rate limit exceeded for uid={uid}")
                await websocket.send_json({"type": "error", "message": "Daily session limit reached (5 sessions/24h). Please try again tomorrow, or ask an admin to restart the server."})
                await websocket.close()
                return
        else:
            print("[WebSocket] Auth disabled.")

        
        print(f"[WebSocket] Connected. Waiting for sources...")
        # Wait for the init_sources message with the array of sources
        init_data = await websocket.receive_text()
        payload = json.loads(init_data)
        
        if payload.get("type") != "init_sources":
            await websocket.send_json({"type": "error", "message": "Expected init_sources message"})
            await websocket.close()
            return
        
        sources = payload.get("sources", [])
        research_mode = payload.get("research_mode", "fast")  # 'off' | 'fast' | 'deep'
        if not sources:
            await websocket.send_json({"type": "error", "message": "No sources provided"})
            await websocket.close()
            return
        
        print(f"[WebSocket] Received {len(sources)} source(s) | research_mode={research_mode}")
        for s in sources:
            print(f"  - [{s.get('type', '?')}] {s.get('label', 'untitled')[:60]}")
        
        # Hand off to the Live Session Manager with sources array
        await handle_live_session(websocket, sources, research_mode=research_mode)
        
    except WebSocketDisconnect:
        print("[WebSocket] Client disconnected")
    except Exception as e:
        print(f"[WebSocket] Error: {e}")
        try:
           await websocket.send_json({"type": "error", "message": str(e)})
           await websocket.close()
        except:
           pass

@app.websocket("/ws/live-restart")
async def websocket_restart_endpoint(websocket: WebSocket):
    """Restart a live conversation on an existing graphic (skip graphic generation)."""
    await websocket.accept()

    try:
        # Verify Firebase token for WebSocket connections
        if os.getenv("DISABLE_AUTH", "").lower() != "true":
            user = await verify_ws_token(websocket)
            if user is None:
                return
            print(f"[WebSocket Restart] Authenticated user: {user.get('email', user.get('uid', 'unknown'))}")
            # --- Per-UID rate limit check ---
            uid = user.get('uid', 'anonymous')
            if not _check_rate_limit(uid):
                print(f"[WebSocket Restart] Rate limit exceeded for uid={uid}")
                await websocket.send_json({"type": "error", "message": "Daily session limit reached (5 sessions/24h). Please try again tomorrow."})
                await websocket.close()
                return
        
        print(f"[WebSocket Restart] Connected. Waiting for restart context...")
        init_data = await websocket.receive_text()
        payload = json.loads(init_data)
        
        if payload.get("type") != "restart_live":
            await websocket.send_json({"type": "error", "message": "Expected restart_live message"})
            await websocket.close()
            return
        
        narration_context = payload.get("narration_context", "")
        source_labels = payload.get("source_labels", [])
        svg_html = payload.get("svg_html", "")
        controls_html = payload.get("controls_html", "")
        controls_inventory = payload.get("controls_inventory", "")

        print(f"[WebSocket Restart] Restarting with {len(source_labels)} source label(s)")

        # Go straight to the Live API — no graphic generation
        await handle_live_restart(websocket, narration_context, source_labels, svg_html, controls_html, controls_inventory)
        
    except WebSocketDisconnect:
        print("[WebSocket Restart] Client disconnected")
    except Exception as e:
        print(f"[WebSocket Restart] Error: {e}")
        try:
           await websocket.send_json({"type": "error", "message": str(e)})
           await websocket.close()
        except:
           pass

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
