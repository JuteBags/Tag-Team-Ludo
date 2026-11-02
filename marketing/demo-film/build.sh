#!/bin/sh
# Builds "The One Move" (Tag Team Ludo demo film): picture, score, mix, master.
# LIB = the Lemo-Opuscar library folder (sh <skill>/scripts/setup.sh prints it). Heavy: run it on GitHub Actions
# (.github/workflows/demo-film.yml), not on a laptop.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${LIB:?set LIB to the Lemo-Opuscar library folder}"
export LIB
PY="$LIB/.venv/bin/python"; [ -x "$PY" ] || PY="$LIB/.venv/Scripts/python.exe"
cd "$LIB"
node core/render/events.mjs "$HERE"
node core/render/video.mjs "$HERE" --fps 30 --workers "${WORKERS:-4}" --out "$HERE/out/video.mp4"
"$PY" "$HERE/score.py"
"$PY" core/render/srt.py "$HERE/cues.json" "$HERE/out/tag-team-ludo-demo.srt"
sh core/render/mux.sh "$HERE/out/video.mp4" "$HERE/out/mix.wav" "$HERE/out/tag-team-ludo-demo.mp4" 30 0
ffmpeg -y -loglevel error -ss 25.4 -i "$HERE/out/tag-team-ludo-demo.mp4" -frames:v 1 -q:v 3 "$HERE/out/poster.jpg"
echo "done: $HERE/out/tag-team-ludo-demo.mp4"
