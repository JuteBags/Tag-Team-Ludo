#!/usr/bin/env bash
# Opens room and friend links in the installed app on a running emulator (#238), and checks from logcat that the app
# got each one: the app's console lines "[ludo-link] …" (app.ts onAppLink and followLink, onlineScreen's Join).
#   bash tools/android/links-check.sh <app-debug.apk> <out dir>
# Writes <out>/<case>.png and .log, <out>/summary.md, and <out>/pass when every case passed.
set -u
APK="$1"
OUT="$2"
PKG=com.jutebags.ludo
SITE=https://jutebags.github.io/Tag-Team-Ludo
mkdir -p "$OUT"
adb install -r "$APK" > "$OUT/install.log" 2>&1 || { echo "install failed"; cat "$OUT/install.log"; exit 1; }
echo "| case | how | expected in logcat | result |" > "$OUT/summary.md"
echo "|---|---|---|---|" >> "$OUT/summary.md"
fails=0

# run <name> <how> <expected line> <am start args...>
run() {
  local name="$1" how="$2" want="$3"
  shift 3
  adb logcat -c
  adb shell am start -W "$@" > "$OUT/$name.start.txt" 2>&1
  # The WebView and the game load, then the link is followed.
  local ok=no
  for i in $(seq 1 45); do
    adb logcat -d -s Capacitor/Console:* chromium:* > "$OUT/$name.log" 2>/dev/null
    if grep -qF "$want" "$OUT/$name.log"; then ok=yes; break; fi
    sleep 2
  done
  sleep 3
  adb exec-out screencap -p > "$OUT/$name.png"
  adb logcat -d -s Capacitor/Console:* chromium:* > "$OUT/$name.log" 2>/dev/null
  echo "| $name | $how | \`$want\` | $([ "$ok" = yes ] && echo PASS || echo '**FAIL**') |" >> "$OUT/summary.md"
  [ "$ok" = yes ] || fails=$((fails + 1))
}

# 1. The room link, the app not running.
adb shell am force-stop "$PKG"
run room-link "https link, cold start" "[ludo-link] join step ABCDE" -a android.intent.action.VIEW -d "$SITE/play/#join=ABCDE" "$PKG"
# 2. The web page's "Open in the app" (intent:// with the code in the query), the app not running.
adb shell am force-stop "$PKG"
run intent-link "intent:// link, cold start" "[ludo-link] join step BCDEF" "intent://jutebags.github.io/Tag-Team-Ludo/play/?join=BCDEF#Intent;scheme=https;package=$PKG;S.browser_fallback_url=https%3A%2F%2Fjutebags.github.io%2FTag-Team-Ludo%2Fplay%2F%23join%3DBCDEF;end"
# 3. A friend link while the app runs (appUrlOpen, no restart).
run friend-link "https link, app running" '[ludo-link] follow {"friend":"K7Q2MZ"}' -a android.intent.action.VIEW -d "$SITE/play/#friend=K7Q2MZ" "$PKG"

cat "$OUT/summary.md"
[ "$fails" = 0 ] && touch "$OUT/pass"
exit 0
