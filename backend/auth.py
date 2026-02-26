"""
Firebase Auth middleware for FastAPI.
Verifies Firebase ID tokens on HTTP and WebSocket requests.
"""
import os
import firebase_admin
from firebase_admin import auth, credentials
from fastapi import Request, HTTPException, WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# Initialize Firebase Admin SDK
# On Cloud Run, uses Application Default Credentials automatically.
# Locally, set FIREBASE_SERVICE_ACCOUNT_PATH env var or use `gcloud auth application-default login`.
_firebase_app = None

def init_firebase():
    """Initialize the Firebase Admin SDK (idempotent)."""
    global _firebase_app
    if _firebase_app is not None:
        return

    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
    if sa_path:
        cred = credentials.Certificate(sa_path)
        _firebase_app = firebase_admin.initialize_app(cred)
    else:
        # Application Default Credentials (works on Cloud Run automatically)
        _firebase_app = firebase_admin.initialize_app()


async def verify_firebase_token(token: str) -> dict:
    """Verify a Firebase ID token and return the decoded claims."""
    try:
        decoded = auth.verify_id_token(token)
        return decoded
    except Exception as e:
        raise ValueError(f"Invalid Firebase token: {e}")


# Paths that don't require authentication
PUBLIC_PATHS = {"/", "/health"}


class FirebaseAuthMiddleware(BaseHTTPMiddleware):
    """
    HTTP middleware that checks for a valid Firebase ID token
    in the Authorization header (Bearer <token>).
    Skips public paths and WebSocket upgrades (handled separately).
    """

    async def dispatch(self, request: Request, call_next):
        # Skip public paths
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        # Skip WebSocket upgrade requests (handled in the endpoint)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # Check Authorization header
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid Authorization header"}
            )

        token = auth_header[7:]  # Strip "Bearer "
        try:
            decoded = await verify_firebase_token(token)
            # Attach user info to request state
            request.state.user = decoded
        except ValueError as e:
            return JSONResponse(
                status_code=401,
                content={"detail": str(e)}
            )

        return await call_next(request)


async def verify_ws_token(websocket: WebSocket) -> dict | None:
    """
    Verify Firebase token from WebSocket query parameter or first message.
    Returns decoded token claims or None if auth is disabled.
    
    Usage in endpoint:
        user = await verify_ws_token(websocket)
    """
    # Check for token in query params: ws://host/ws/live?token=xxx
    token = websocket.query_params.get("token")
    if not token:
        # No token provided — reject connection
        await websocket.close(code=4001, reason="Authentication required")
        return None

    try:
        decoded = await verify_firebase_token(token)
        return decoded
    except ValueError as e:
        await websocket.close(code=4001, reason=str(e))
        return None
