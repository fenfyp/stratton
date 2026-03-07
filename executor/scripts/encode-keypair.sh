#!/bin/bash
# Encode un fichier keypair Solana (.json) en base64
# Usage : ./scripts/encode-keypair.sh /path/to/launch-wallet.json

set -e

KEYPAIR_PATH="${1:-$EXECUTOR_KEYPAIR_PATH}"

if [ -z "$KEYPAIR_PATH" ]; then
  echo "Usage: $0 /path/to/keypair.json"
  echo "  ou définir EXECUTOR_KEYPAIR_PATH dans votre environnement"
  exit 1
fi

if [ ! -f "$KEYPAIR_PATH" ]; then
  echo "Erreur: fichier introuvable — $KEYPAIR_PATH"
  exit 1
fi

ENCODED=$(base64 < "$KEYPAIR_PATH" | tr -d '\n')

echo ""
echo "✓ Keypair encodé. Copie cette valeur dans Railway / Render :"
echo ""
echo "EXECUTOR_KEYPAIR_BASE64=$ENCODED"
echo ""
echo "⚠ Ne partage jamais cette valeur publiquement."
