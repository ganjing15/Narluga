# Narluga — Automated Cloud Deployment

Fully automated deployment of the Narluga stack to Google Cloud Platform using bash scripts.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  Firebase Hosting (CDN)  │        │  GCP e2-micro VM         │
│  React SPA               │ ──────►│  Docker: FastAPI backend  │
│  gen-lang-*.web.app      │  WSS   │  Caddy: auto-SSL (LE)    │
└──────────────────────────┘        │  narluga.duckdns.org     │
         │                          └──────────┬───────────────┘
    Firebase Auth                              │
    (Google Sign-In)                    Gemini API
         │                          (3.1 Pro + 2.5 Flash Audio)
    Cloud Firestore
    (Saved Graphics)
```

**Cost: $0** — GCP e2-micro is always-free, Firebase services are within free tier.

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI)
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npx firebase-tools login`)
- [Node.js 18+](https://nodejs.org/) and npm
- A GCP project with billing enabled
- A [DuckDNS](https://www.duckdns.org) subdomain (or any domain you control)

## Quick Start

Deploy the entire stack from scratch in 4 commands:

```bash
# 1. Provision GCP infrastructure (VM, IP, firewall)
./deploy/provision.sh <PROJECT_ID> <DOMAIN>

# 2. Install Docker + Caddy on the VM
./deploy/setup-vm.sh <PROJECT_ID>

# 3. Build and deploy the backend container
./deploy/deploy-backend.sh <PROJECT_ID> <DOMAIN>

# 4. Build and deploy the frontend to Firebase Hosting
./deploy/deploy-frontend.sh <PROJECT_ID>
```

Example with real values:
```bash
./deploy/provision.sh gen-lang-client-0129909190 narluga.duckdns.org
./deploy/setup-vm.sh gen-lang-client-0129909190
./deploy/deploy-backend.sh gen-lang-client-0129909190 narluga.duckdns.org
./deploy/deploy-frontend.sh gen-lang-client-0129909190
```

## Scripts

| Script | Purpose | Idempotent |
|---|---|---|
| `provision.sh` | Create static IP, firewall rules, e2-micro VM | ✅ Yes |
| `setup-vm.sh` | Install Docker + Caddy on the VM | ✅ Yes |
| `deploy-backend.sh` | Copy source, build Docker image, start container, configure Caddy | ✅ Yes |
| `deploy-frontend.sh` | Build Vite bundle, deploy to Firebase Hosting | ✅ Yes |
| `teardown.sh` | Delete VM, IP, firewall rules (with confirmation) | — |
| `Caddyfile` | Caddy reverse proxy config (auto-SSL via Let's Encrypt) | — |

## Configuration

### Backend (`backend/.env`)

```env
GEMINI_API_KEY=your_key_here          # Required
SUPADATA_API_KEY=your_key_here        # Optional: YouTube transcripts
GITHUB_TOKEN=your_token_here          # Optional: GitHub scraping
DISABLE_AUTH=true                     # Set to false to enforce Firebase Auth
```

### Frontend (`frontend/.env.production`)

```env
VITE_BACKEND_URL=https://your-domain.duckdns.org
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
# ... (see file for all values)
```

## Redeployment

After code changes, redeploy only what changed:

```bash
# Backend only
./deploy/deploy-backend.sh <PROJECT_ID> <DOMAIN>

# Frontend only
./deploy/deploy-frontend.sh <PROJECT_ID>
```

## Teardown

Remove all GCP compute resources (does **not** affect Firebase Hosting or Firestore):

```bash
./deploy/teardown.sh <PROJECT_ID>
```
