#!/usr/bin/env bash
# deploy/provision.sh — Provision GCP infrastructure for Narluga
# Creates: static IP, firewall rules, e2-micro VM (always-free tier)
#
# Usage:  ./deploy/provision.sh [PROJECT_ID] [DOMAIN]
# Example: ./deploy/provision.sh gen-lang-client-0129909190 narluga.duckdns.org

set -euo pipefail

PROJECT="${1:?Usage: $0 <PROJECT_ID> [DOMAIN]}"
DOMAIN="${2:-narluga.duckdns.org}"
REGION="us-central1"
ZONE="${REGION}-a"
VM_NAME="narluga-vm"
IP_NAME="narluga-ip"

echo "🔧 Provisioning Narluga infrastructure in project: ${PROJECT}"
echo "   Region: ${REGION}  |  Zone: ${ZONE}  |  Domain: ${DOMAIN}"
echo ""

# ── 1. Enable required APIs ──────────────────────────────────────────────────
echo "📡 Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com --project "${PROJECT}" --quiet

# ── 2. Reserve a static external IP ─────────────────────────────────────────
if gcloud compute addresses describe "${IP_NAME}" --region "${REGION}" --project "${PROJECT}" &>/dev/null; then
  echo "✅ Static IP '${IP_NAME}' already exists"
else
  echo "📌 Reserving static IP '${IP_NAME}'..."
  gcloud compute addresses create "${IP_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT}"
fi

EXTERNAL_IP=$(gcloud compute addresses describe "${IP_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --format='value(address)')
echo "   External IP: ${EXTERNAL_IP}"

# ── 3. Create firewall rules ────────────────────────────────────────────────
if gcloud compute firewall-rules describe allow-http-https --project "${PROJECT}" &>/dev/null; then
  echo "✅ Firewall rule 'allow-http-https' already exists"
else
  echo "🔓 Creating firewall rule for HTTP/HTTPS..."
  gcloud compute firewall-rules create allow-http-https \
    --allow tcp:80,tcp:443 \
    --target-tags http-server,https-server \
    --project "${PROJECT}"
fi

# ── 4. Create the VM ────────────────────────────────────────────────────────
if gcloud compute instances describe "${VM_NAME}" --zone "${ZONE}" --project "${PROJECT}" &>/dev/null; then
  echo "✅ VM '${VM_NAME}' already exists"
else
  echo "🖥️  Creating e2-micro VM '${VM_NAME}'..."
  gcloud compute instances create "${VM_NAME}" \
    --zone "${ZONE}" \
    --machine-type e2-micro \
    --image-family debian-12 \
    --image-project debian-cloud \
    --address "${IP_NAME}" \
    --tags http-server,https-server \
    --project "${PROJECT}"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "✅ Infrastructure provisioned!"
echo ""
echo "   VM:         ${VM_NAME} (${ZONE})"
echo "   IP:         ${EXTERNAL_IP}"
echo "   Free tier:  e2-micro in ${REGION} (always-free)"
echo ""
echo "📋 Next steps:"
echo "   1. Point your domain (${DOMAIN}) to ${EXTERNAL_IP}"
echo "      - DuckDNS: https://www.duckdns.org → update IP"
echo "      - Custom domain: add an A record"
echo "   2. Run: ./deploy/setup-vm.sh ${PROJECT}"
echo "══════════════════════════════════════════════════════════════"
