#!/bin/sh
# Create one Google Flow character: describe -> generate -> name -> voice -> info -> Done.
# Usage (from repo root): make_char.sh <tabId> <chars.json> <index>
# chars.json: [{ "name", "voice", "desc", "info" }]
set -e
T=$1; F=$2; I=$3
[ -n "$T" ] && [ -f "$F" ] && [ -n "$I" ] || { echo "usage: make_char.sh <tabId> <chars.json> <index>"; exit 2; }

run() { node run_workflow.js "$@" --raw; }
field() { node -e 'const c=require(require("path").resolve(process.argv[1]))[+process.argv[2]];process.stdout.write(String(c[process.argv[3]]||""))' "$F" "$I" "$1"; }
count() { node run_workflow.js el count "$1" --tab "$T" --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.count)}catch(_){console.log(0)}})'; }
typeinto() { node -e 'process.stdout.write(JSON.stringify({ref:process.argv[1],value:process.argv[2],target:{tabId:+process.argv[3]}}))' "$1" "$2" "$T"; }

NAME=$(field name); VOICE=$(field voice)
echo "== $NAME"
run el click @flow.navCharacters --tab "$T"
sleep 2
# From the 2nd character on, the list shows a "New character" card first.
NEWCARD='{"textExact":["Nhân vật mới","New character"]}'
if [ "$(count "$NEWCARD")" -gt 0 ]; then run el click "$NEWCARD" --tab "$T"; fi
run el waitAppear @flow.charPrompt '{"timeout":20000}' --tab "$T"
run call el.type "$(typeinto @flow.charPrompt "$(field desc)")"
run el click @flow.charSubmit --tab "$T"
# Image is done when its download button appears (the name input shows earlier, while generating).
run el waitAppear @flow.charImageReady '{"timeout":180000}' --tab "$T" --timeout 200000
sleep 2
run call el.type "$(typeinto @flow.charName "$NAME")"
run press Enter --tab "$T"
if [ -n "$VOICE" ]; then
  run el click @flow.charVoice --tab "$T"
  run el waitAppear @flow.voiceItem '{"timeout":15000}' --tab "$T"
  # Match the voice row by its name; "voice_selection" alone matches every row (first = Achernar).
  VREF=$(node -e 'process.stdout.write(JSON.stringify({css:"[role=dialog] button",text:[process.argv[1],process.argv[1].toLowerCase()]}))' "$VOICE")
  [ "$(count "$VREF")" -gt 0 ] || { echo "!! voice not in list: $VOICE"; exit 1; }
  run call el.click "$(node -e 'process.stdout.write(JSON.stringify({ref:JSON.parse(process.argv[1]),target:{tabId:+process.argv[2]}}))' "$VREF" "$T")"
  # Selecting is not enough: the voice is only assigned after "Add to character". A miss must fail.
  run el waitAppear @flow.voiceAdd '{"timeout":5000}' --tab "$T"
  run el click @flow.voiceAdd --tab "$T"
  sleep 2
fi
INFO=$(field info)
if [ -n "$INFO" ]; then
  run el waitAppear @flow.charInfo '{"timeout":15000}' --tab "$T"
  run call el.type "$(typeinto @flow.charInfo "$INFO")"
fi
run el click @flow.charDone --tab "$T"
sleep 3
echo "== done $NAME"
