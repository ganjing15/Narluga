from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import os
import json
from dotenv import load_dotenv
from google_genai_service import handle_live_session

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Lumina Live API is running"}

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

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(f"[WebSocket] Connected. Waiting for sources...")
    try:
        # Wait for the init_sources message with the array of sources
        init_data = await websocket.receive_text()
        payload = json.loads(init_data)
        
        if payload.get("type") != "init_sources":
            await websocket.send_json({"type": "error", "message": "Expected init_sources message"})
            await websocket.close()
            return
        
        sources = payload.get("sources", [])
        if not sources:
            await websocket.send_json({"type": "error", "message": "No sources provided"})
            await websocket.close()
            return
        
        print(f"[WebSocket] Received {len(sources)} source(s)")
        for s in sources:
            print(f"  - [{s.get('type', '?')}] {s.get('label', 'untitled')[:60]}")
        
        # Hand off to the Live Session Manager with sources array
        await handle_live_session(websocket, sources)
        
    except WebSocketDisconnect:
        print("[WebSocket] Client disconnected")
    except Exception as e:
        print(f"[WebSocket] Error: {e}")
        try:
           await websocket.send_json({"type": "error", "message": str(e)})
           await websocket.close()
        except:
           pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
