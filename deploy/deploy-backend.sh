#!/usr/bin/env bash
# deploy/deploy-backend.sh — Build and deploy the backend to the VM
# Copies source, builds Docker image on-VM, and starts the container.
#
# Usage:  ./deploy/deploy-backend.sh <PROJECT_ID> [DOMAIN]
# Env:    Reads API keys from backend/.env

set -euo pipefail

PROJECT="${1:?Usage: $0 <PROJECT_ID> [DOMAIN]}"
DOMAIN="${2:-narluga.duckdns.org}"
ZONE="us-central1-a"
VM_NAME="narluga-vm"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

echo "🚀 Deploying backend to ${VM_NAME}..."

# ── 1. Read env vars from backend/.env ───────────────────────────────────────
ENV_FILE="${REPO_ROOT}/backend/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "❌ Error: ${ENV_FILE} not found. Create it with your API keys."
  exit 1
fi

GEMINI_KEY=$(grep '^GEMINI_API_KEY=' "${ENV_FILE}" | cut -d= -f2)
SUPADATA_KEY=$(grep '^SUPADATA_API_KEY=' "${ENV_FILE}" | cut -d= -f2 || echo "")
GITHUB_TOK=$(grep '^GITHUB_TOKEN=' "${ENV_FILE}" | head -1 | cut -d= -f2 || echo "")
DISABLE_AUTH=$(grep '^DISABLE_AUTH=' "${ENV_FILE}" | cut -d= -f2 || echo "true")

if [[ -z "${GEMINI_KEY}" ]]; then
  echo "❌ Error: GEMINI_API_KEY not found in ${ENV_FILE}"
  exit 1
fi

# ── 2. Copy backend source to VM ────────────────────────────────────────────
echo "📦 Copying backend source to VM..."
gcloud compute scp --recurse \
  "${REPO_ROOT}/backend/" \
  "${VM_NAME}:~/backend" \
  --zone "${ZONE}" \
  --project "${PROJECT}"

# ── 3. Copy Caddyfile ───────────────────────────────────────────────────────
echo "📋 Copying Caddyfile..."
gcloud compute scp \
  "${SCRIPT_DIR}/Caddyfile" \
  "${VM_NAME}:~/Caddyfile" \
  --zone "${ZONE}" \
  --project "${PROJECT}"

# ── 4. Build Docker image + start container ─────────────────────────────────
ALLOWED_ORIGINS="https://${DOMAIN},https://narluga.web.app,https://narluga.firebaseapp.com,https://${PROJECT}.web.app,https://${PROJECT}.firebaseapp.com,http://localhost:5173"

echo "🐳 Building Docker image and starting container..."
gcloud compute ssh "${VM_NAME}" \
  --zone "${ZONE}" \
  --project "${PROJECT}" \
  --command "
set -e

cd ~/backend

echo '--- Building Docker image ---'
sudo docker build -t narluga-api .

echo '--- Stopping old container (if any) ---'
sudo docker rm -f narluga-api 2>/dev/null || true

echo '--- Starting new container ---'
sudo docker run -d --name narluga-api --restart always \
  -p 8080:8080 \
  -e PORT=8080 \
  -e GEMINI_API_KEY='${GEMINI_KEY}' \
  -e SUPADATA_API_KEY='${SUPADATA_KEY}' \
  -e GITHUB_TOKEN='${GITHUB_TOK}' \
  -e DISABLE_AUTH='${DISABLE_AUTH}' \
  -e ALLOWED_ORIGINS='${ALLOWED_ORIGINS}' \
  narluga-api

echo '--- Configuring Caddy ---'
sudo cp ~/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy

echo '--- Waiting for startup ---'
sleep 5

echo '--- Health check ---'
curl -sf http://localhost:8080/health && echo '' || echo 'WARNING: Health check failed, container may still be starting'

echo '--- Container status ---'
sudo docker ps --filter name=narluga-api --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
"

echo ""
echo "✅ Backend deployed to https://${DOMAIN}"
echo "   Health: https://${DOMAIN}/health"
