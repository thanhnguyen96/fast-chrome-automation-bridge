#!/bin/sh
# Create one Google Flow character: describe -> generate -> name -> voice -> info -> Done.
# Usage (from repo root): make_char.sh <tabId> <chars.json> <index>
# chars.json: [{ "name", "voice", "desc", "info" }]
set -e
T=$1; F=$2; I=$3
[ -n "$T" ] && [ -f "$F" ] && [ -n "$I" ] || { echo "usage: make_char.sh <tabId> <chars.json> <index>"; exit 2; }

run() { node run_workflow.js "$@" --raw; }
field() { node -e 'const c=require(require("path").resolve(process.argv[1]))[+process.argv[2]];process.stdout.write(String(c[process.argv[3]]||""))' "$F" "$I" "$1"; }
typeinto() { node -e 'process.stdout.write(JSON.stringify({ref:process.argv[1],value:process.argv[2],target:{tabId:+process.argv[3]}}))' "$1" "$2" "$T"; }

NAME=$(field name); VOICE=$(field voice)
echo "== $NAME"
run el click @flow.navCharacters --tab "$T"
sleep 2
# From the 2nd character on, the list shows a "New character" card first.
run el click '{"textExact":["Nhân vật mới","New character"]}' '{"timeout":3000}' --tab "$T" || true
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
  run call el.click "$(node -e 'process.stdout.write(JSON.stringify({ref:{css:"[role=dialog] button",text:process.argv[1]},target:{tabId:+process.argv[2]}}))' "$VOICE" "$T")"
  # Selecting is not enough: the voice is only assigned after "Add to character".
  run el click @flow.voiceAdd '{"timeout":3000}' --tab "$T" || true
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
