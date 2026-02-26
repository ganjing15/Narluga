#!/usr/bin/env bash
# deploy/setup-vm.sh — Install Docker + Caddy on the VM
# Run once after provisioning. Idempotent — safe to re-run.
#
# Usage: ./deploy/setup-vm.sh [PROJECT_ID]

set -euo pipefail

PROJECT="${1:?Usage: $0 <PROJECT_ID>}"
ZONE="us-central1-a"
VM_NAME="narluga-vm"

echo "🔧 Setting up Docker + Caddy on ${VM_NAME}..."

gcloud compute ssh "${VM_NAME}" \
  --zone "${ZONE}" \
  --project "${PROJECT}" \
  --command '
set -e

echo "=== Installing Docker ==="
if command -v docker &>/dev/null; then
  echo "Docker already installed: $(docker --version)"
else
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker.io
  sudo systemctl enable docker
  sudo systemctl start docker
  sudo usermod -aG docker $USER
  echo "Docker installed: $(docker --version)"
fi

echo ""
echo "=== Installing Caddy ==="
if command -v caddy &>/dev/null; then
  echo "Caddy already installed: $(caddy version)"
else
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
  echo "Caddy installed: $(caddy version)"
fi

echo ""
echo "=== Setup complete ==="
'

echo ""
echo "✅ VM setup complete. Next: ./deploy/deploy-backend.sh ${PROJECT}"
