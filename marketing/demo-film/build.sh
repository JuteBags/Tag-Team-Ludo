#!/bin/sh
# Builds "Ludo, explained" (v2 of the Tag Team Ludo demo film) in one language, 16:9 and 9:16.
#   LIB=<lemo-opuscar library>  LANG_FILM=en|hi  [WORKERS=4]  sh marketing/demo-film/build.sh
# Heavy: run it on GitHub Actions (.github/workflows/demo-film.yml), not on a laptop.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${LIB:?set LIB to the Lemo-Opuscar library folder}"
export LIB
L=${LANG_FILM:-en}
export LANG_FILM=$L
PY="$LIB/.venv/bin/python"; [ -x "$PY" ] || PY="$LIB/.venv/Scripts/python.exe"
mkdir -p "$HERE/out"

# 1. The real-app clips as frames (the page shows one per film frame).
for c in "$HERE"/clips/*.mp4; do
  n=$(basename "$c" .mp4); d="$HERE/out/frames/$n"
  [ -f "$d/f_0001.jpg" ] || { mkdir -p "$d"; ffmpeg -y -loglevel error -i "$c" -vf fps=30 -q:v 3 "$d/f_%04d.jpg"; }
done
"$PY" "$HERE/voice/prep.py" counts

# 2. The voice-over (Kokoro; the voice is chosen in voice/script.json). The page sizes its scenes from dur.json.
"$PY" "$HERE/voice/prep.py" lines "$L" "$HERE/out/vo/$L/lines.json"
"$PY" "$LIB/core/tts/tts.py" "$HERE/out/vo/$L/lines.json" "$HERE/out/vo/$L"

cd "$LIB"
# 3. Events (voice cues, the mascot's moves, the clips' dice and taps), then the mix and the captions.
node core/render/events.mjs "$HERE" --q "lang=$L" --out "$HERE/out/events-$L.json"
"$PY" "$HERE/score.py"
"$PY" "$HERE/voice/prep.py" cues "$L"
"$PY" core/render/srt.py "$HERE/out/cues-$L.json" "$HERE/out/tag-team-ludo-demo-$L.srt"

# 4. Picture, both shapes, and the master.
for f in h v; do
  if [ "$f" = v ]; then q="lang=$L&fmt=v"; size=1080x1920; name=tag-team-ludo-demo-$L-vertical
  else q="lang=$L"; size=1920x1080; name=tag-team-ludo-demo-$L; fi
  node core/render/video.mjs "$HERE" --fps 30 --workers "${WORKERS:-4}" --q "$q" --size $size --out "$HERE/out/video-$L-$f.mp4"
  sh core/render/mux.sh "$HERE/out/video-$L-$f.mp4" "$HERE/out/mix-$L.wav" "$HERE/out/$name.mp4" 30 0
done
# Posters: the pair scene, the film's one new idea.
T=$("$PY" -c "import json;e=json.load(open('$HERE/out/events-$L.json'))['ev'];print([x['t'] for x in e if x['type']=='vo' and x['id']=='03'][0])")
ffmpeg -y -loglevel error -ss "$T" -i "$HERE/out/tag-team-ludo-demo-$L.mp4" -frames:v 1 -q:v 3 "$HERE/out/poster-$L.jpg"
ffmpeg -y -loglevel error -ss "$T" -i "$HERE/out/tag-team-ludo-demo-$L-vertical.mp4" -frames:v 1 -q:v 3 "$HERE/out/poster-$L-vertical.jpg"
echo "done: $HERE/out/tag-team-ludo-demo-$L.mp4 and -vertical.mp4"
