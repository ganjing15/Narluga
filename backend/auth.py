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
    project_id = os.getenv("FIREBASE_PROJECT_ID", "gen-lang-client-0129909190")
    
    if sa_path:
        cred = credentials.Certificate(sa_path)
        _firebase_app = firebase_admin.initialize_app(cred, options={'projectId': project_id})
    else:
        # Application Default Credentials (works on Cloud Run automatically)
        _firebase_app = firebase_admin.initialize_app(options={'projectId': project_id})


async def verify_firebase_token(token: str) -> dict:
    """Verify a Firebase ID token and return the decoded claims."""
    try:
        decoded = auth.verify_id_token(token)
        return decoded
    except Exception as e:
        # Check both ValueError and DefaultCredentialsError cases
        if "default credentials" in str(e).lower() or "project id" in str(e).lower():
            # Fallback for local testing without ADC: use google.oauth2
            from google.oauth2 import id_token
            from google.auth.transport import requests
            try:
                project_id = os.getenv("FIREBASE_PROJECT_ID", "gen-lang-client-0129909190")
                request = requests.Request()
                decoded = id_token.verify_firebase_token(token, request, audience=project_id)
                return decoded
            except Exception as inner_e:
                raise ValueError(f"Invalid Firebase token (local fallback): {inner_e}")
        raise ValueError(f"Invalid Firebase token: {e}")


# Paths that don't require authentication
PUBLIC_PATHS = {"/", "/health", "/search"}


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

        # Skip OPTIONS preflight requests (handled by CORSMiddleware)
        if request.method == "OPTIONS":
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
        print("[Auth] No Firebase token provided in query params 'token'. Rejecting WebSocket connection.")
        # No token provided — reject connection
        await websocket.close(code=4001, reason="Authentication required")
        return None

    try:
        decoded = await verify_firebase_token(token)
        return decoded
    except ValueError as e:
        print(f"[Auth] Firebase WebSocket token validation failed: {str(e)}")
        reason_str = str(e)
        if len(reason_str) > 120:
            reason_str = reason_str[:117] + "..."
        await websocket.close(code=4001, reason=reason_str)
        return None
