#!/bin/bash
# Setup script for narluga-vm (e2-micro, Debian 12)
# Installs Docker + Caddy, deploys the backend

set -e

echo "=== Installing Docker ==="
sudo apt-get update -qq
sudo apt-get install -y -qq docker.io docker-compose-plugin
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER

echo "=== Installing Caddy ==="
sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq
sudo apt-get install -y -qq caddy

echo "=== Done! Docker and Caddy installed ==="
docker --version
caddy version
