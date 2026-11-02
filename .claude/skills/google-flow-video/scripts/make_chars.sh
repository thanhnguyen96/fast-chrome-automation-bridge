#!/bin/sh
# Create every character in chars.json at once: one extra tab per character, all on the same project.
# Usage (from repo root): make_chars.sh <tabId> <chars.json>
# <tabId> must already show the project. Logs go next to chars.json (char<i>.log).
T=$1; F=$2
[ -n "$T" ] && [ -f "$F" ] || { echo "usage: make_chars.sh <tabId> <chars.json>"; exit 2; }
DIR=$(dirname "$F")
N=$(node -e 'console.log(require(require("path").resolve(process.argv[1])).length)' "$F")
URL=$(node run_workflow.js call tabs.list '{}' --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).data.find(x=>x.id==process.argv[1]);process.stdout.write(t?t.url:"")})' "$T")
case "$URL" in *flow.google.com/project/*) ;; *) echo "!! tab $T is not on a Flow project: $URL"; exit 1 ;; esac

# Tab 0 is the given tab; open one more tab on the same project for each other character.
TABS=$T
i=1
while [ $i -lt "$N" ]; do
  id=$(node run_workflow.js call tabs.open "{\"url\":\"$URL\",\"timeoutMs\":45000}" --timeout 60000 --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).data.tabId))}catch(_){}})')
  [ -n "$id" ] || { echo "!! could not open tab $i"; exit 1; }
  TABS="$TABS $id"; i=$((i+1))
done
for t in $TABS; do node run_workflow.js call agent.keepAlive "{\"target\":{\"tabId\":$t}}" --raw >/dev/null 2>&1; done

echo "== $N characters on tabs: $TABS"
i=0
for t in $TABS; do
  sh .claude/skills/google-flow-video/scripts/make_char.sh "$t" "$F" "$i" > "$DIR/char$i.log" 2>&1 &
  i=$((i+1))
done
wait

FAIL=0
i=0
for t in $TABS; do
  if grep -q '^== done' "$DIR/char$i.log" && ! grep -q '^!!' "$DIR/char$i.log"; then echo "ok   $i: $(head -1 "$DIR/char$i.log")"
  else echo "FAIL $i: see $DIR/char$i.log"; tail -3 "$DIR/char$i.log"; FAIL=1; fi
  [ "$t" = "$T" ] || node run_workflow.js call tabs.close "{\"target\":{\"tabId\":$t}}" --raw >/dev/null
  i=$((i+1))
done
# The main tab's lists were loaded before the other tabs saved their characters.
node run_workflow.js call tabs.reload "{\"target\":{\"tabId\":$T}}" --raw >/dev/null
exit $FAIL
