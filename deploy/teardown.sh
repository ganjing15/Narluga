#!/usr/bin/env bash
# deploy/teardown.sh — Remove all GCP resources created by provision.sh
#
# Usage: ./deploy/teardown.sh <PROJECT_ID>
# ⚠️  This is destructive! It deletes the VM, IP, and firewall rules.

set -euo pipefail

PROJECT="${1:?Usage: $0 <PROJECT_ID>}"
ZONE="us-central1-a"
REGION="us-central1"
VM_NAME="narluga-vm"
IP_NAME="narluga-ip"

echo "⚠️  This will delete ALL Narluga GCP resources in project: ${PROJECT}"
echo "   - VM: ${VM_NAME}"
echo "   - Static IP: ${IP_NAME}"
echo "   - Firewall rule: allow-http-https"
echo ""
read -p "Are you sure? (y/N): " CONFIRM
if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "🗑️  Deleting VM..."
gcloud compute instances delete "${VM_NAME}" \
  --zone "${ZONE}" \
  --project "${PROJECT}" \
  --quiet 2>/dev/null || echo "   (VM not found, skipping)"

echo "🗑️  Releasing static IP..."
gcloud compute addresses delete "${IP_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --quiet 2>/dev/null || echo "   (IP not found, skipping)"

echo "🗑️  Deleting firewall rule..."
gcloud compute firewall-rules delete allow-http-https \
  --project "${PROJECT}" \
  --quiet 2>/dev/null || echo "   (Rule not found, skipping)"

echo ""
echo "✅ All GCP resources deleted."
echo "   Note: Firebase Hosting and Firestore are not affected."
