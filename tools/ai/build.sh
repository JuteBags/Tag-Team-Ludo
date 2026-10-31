#!/usr/bin/env bash
# Bundles the AI tools for Node into tools/ai/dist/{selfplay,arena}.mjs (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/../.."
for f in selfplay arena; do
  npx rolldown "tools/ai/$f.ts" --platform node --format esm --file "tools/ai/dist/$f.mjs" --log-level silent
done
echo built
