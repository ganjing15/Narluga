#!/usr/bin/env bash
# deploy/deploy-frontend.sh — Build and deploy frontend to Firebase Hosting
#
# Usage:  ./deploy/deploy-frontend.sh [PROJECT_ID]
# Prerequisites: Firebase CLI authenticated (run `npx firebase-tools login`)

set -euo pipefail

PROJECT="${1:-gen-lang-client-0129909190}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

echo "🚀 Deploying frontend to Firebase Hosting..."

# ── 1. Build the production bundle ──────────────────────────────────────────
echo "📦 Building frontend..."
cd "${REPO_ROOT}/frontend"
npm run build

# ── 2. Deploy to Firebase Hosting ───────────────────────────────────────────
echo "☁️  Deploying to Firebase Hosting..."
cd "${REPO_ROOT}"
npx firebase-tools deploy --only hosting --project "${PROJECT}"

HOSTING_URL="https://narluga.web.app"
echo ""
echo "✅ Frontend deployed to ${HOSTING_URL}"
