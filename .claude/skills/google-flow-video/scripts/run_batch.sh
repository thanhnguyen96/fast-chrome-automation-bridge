#!/bin/sh
# Send many scenes to the Google Flow agent in ONE message, approve once.
# Usage (from repo root): run_batch.sh <tabId> <batch.json>
# batch.json: { "chars": ["Exact Flow character name", ...max 3], "scenes": ["full scene prompt", ...] }
# All scenes in a batch share the same attached characters (Omni: max 3). Split batches by character set.
# Never clicks "Always approve". Stops with "!!" when no approve chip shows (agent asked something).
T=$1; F=$2
[ -n "$T" ] && [ -f "$F" ] || { echo "usage: run_batch.sh <tabId> <batch.json>"; exit 2; }
APPROVE='{"textExact":["Phê duyệt","Approve"]}'

run() { node run_workflow.js "$@" --raw; }
count() { node run_workflow.js el count "$1" --tab "$T" --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.count)}catch(_){console.log(-1)}})'; }
batch() { node -e 'const b=require(require("path").resolve(process.argv[1]));'"$1" "$F" "$T" "${2:-}"; }

NCH=$(batch 'console.log(b.chars.length)')
NSC=$(batch 'console.log(b.scenes.length)')
[ "$NCH" -le 3 ] || { echo "!! $NCH characters, Omni allows max 3 per message"; exit 1; }
batch 'b.scenes.forEach((s,i)=>{if(/scene\s*\d|cảnh\s*\d/i.test(s))console.log("!! scene "+(i+1)+" prompt mentions a scene number; Omni may print it")})'

# Agent is busy while the Stop button shows.
i=0
while [ "$(count '{"css":"button","aria":["Dừng","Stop"]}')" != "0" ] && [ $i -lt 120 ]; do sleep 5; i=$((i+1)); done

# The settings panel covers the chat input; close it if open.
if [ "$(count '{"textExact":["Cài đặt tác nhân","Agent settings"]}')" -gt 0 ]; then
  run el click '{"css":"button","text":"arrow_back","nth":-1}' --tab "$T" >/dev/null
  sleep 1
fi
run press Escape --tab "$T" >/dev/null 2>&1 || true

k=0
while [ $k -lt "$NCH" ]; do
  NAME=$(batch 'process.stdout.write(b.chars[+process.argv[3]])' "$k")
  run el click '{"css":"button","aria":["Thêm thành phần vào ô nhập câu lệnh","Add to prompt"]}' --tab "$T" >/dev/null \
    || { echo "!! no + button in chat (panel open?)"; exit 1; }
  run el waitAppear '{"css":"button[role=option].asset-item"}' '{"timeout":10000}' --tab "$T" >/dev/null
  run call el.click "$(node -e 'process.stdout.write(JSON.stringify({ref:{css:"button[role=option].asset-item",text:process.argv[1]},target:{tabId:+process.argv[2]}}))' "$NAME" "$T")" >/dev/null \
    || { echo "!! character not found: $NAME"; exit 1; }
  run el click '{"css":"button","textExact":["Thêm vào câu lệnh","Add to prompt"]}' '{"timeout":2000}' --tab "$T" >/dev/null 2>&1 || true
  sleep 1
  k=$((k+1))
done

# Scene labels tell the agent where each scene starts; the header forbids putting them on screen.
MSG=$(batch '
let m="Create "+b.scenes.length+" separate 10-second videos with Omni, one video per scene below, in this order. "
 +"Use each scene prompt exactly as written, do not rewrite or merge scenes. "
 +"The scene labels are only for you: never put scene numbers, labels or titles into the videos.\n\n";
b.scenes.forEach((s,i)=>{m+="[Scene "+(i+1)+"]\n"+s+"\n\n"});
process.stdout.write(JSON.stringify({ref:"@flow.prompt",value:m.trim(),target:{tabId:+process.argv[2]}}))')
run call el.type "$MSG" >/dev/null
BEFORE=$(count "$APPROVE")
run el click @flow.submit --tab "$T" >/dev/null
echo "== sent $NSC scenes"
i=0; NOW=$BEFORE
while [ "$NOW" -le "$BEFORE" ] && [ $i -lt 36 ]; do sleep 5; NOW=$(count "$APPROVE"); i=$((i+1)); done
if [ "$NOW" -le "$BEFORE" ]; then
  echo "!! no approve chip, read the chat (el text body) to see what the agent asked"; exit 1
fi
# Show the agent's plan (cost, number of videos) before approving.
node run_workflow.js el text body --tab "$T" --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).data.text;const k=t.lastIndexOf("Phê duyệt");console.log(t.slice(Math.max(0,k-400),k).trim())})'
run el click '{"textExact":["Phê duyệt","Approve"],"nth":-1}' --tab "$T" >/dev/null
echo "== approved $NSC scenes"

# Tiles exist in the DOM only on the Video tab; on Characters/Scenes the count stays 0.
# The Video nav item appears after the first clip starts, so retry until it shows.
BASE=-1; i=0
while [ $i -lt 80 ]; do
  run el click @flow.navVideos '{"timeout":3000}' --tab "$T" >/dev/null 2>&1 && {
    [ "$BASE" -ge 0 ] || { sleep 2; BASE=0; }
    TILES=$(count '{"css":"flow-video-tile"}')
    BUSY=$(count @flow.progress)
    FAILED=$(count '{"css":"flow-video-tile","text":["Không thành công","Failed"]}')
    echo "$(date +%T) tiles=$TILES running=$BUSY failed=$FAILED"
    [ "$TILES" -ge "$NSC" ] && [ "$BUSY" = "0" ] && break
  }
  sleep 15; i=$((i+1))
done
echo "== done (tiles also include clips made before this batch)"
