#!/usr/bin/env bash
# Paso 0d: build del legacy con red (solo para dependencias); el runtime corre en la red interna del compose
set -euo pipefail
cd "$(dirname "$0")/.."
"${RUNTIME:-podman}" build -f sandbox/Dockerfile -t localhost/recover/fixture:sandbox repo
