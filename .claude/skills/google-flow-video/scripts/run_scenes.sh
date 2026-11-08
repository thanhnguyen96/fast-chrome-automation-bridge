#!/bin/sh
# Send scenes to the Google Flow agent chat, one message per scene, approving each once.
# Usage (from repo root): run_scenes.sh <tabId> <scenes.json> <index>...   (0-based)
# scenes.json: [{ "chars": ["Exact Flow character name", ...max 3], "prompt": "..." }]
# Never clicks "Always approve". Stops with "!!" when no approve chip shows (agent asked something).
T=$1; F=$2; shift 2
[ -n "$T" ] && [ -f "$F" ] && [ $# -gt 0 ] || { echo "usage: run_scenes.sh <tabId> <scenes.json> <index>..."; exit 2; }
APPROVE='{"textExact":["Phê duyệt","Approve"]}'

run() { node run_workflow.js "$@" --raw; }
count() { node run_workflow.js el count "$1" --tab "$T" --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).data.count)}catch(_){console.log(-1)}})'; }
scene() { node -e 'const s=require(require("path").resolve(process.argv[1]))[+process.argv[2]];'"$1" "$F" "$I" "$T" "${2:-}"; }

# Agent is busy while the Stop button shows in the chat.
wait_idle() {
  i=0
  while [ "$(count '{"css":"button","aria":["Dừng","Stop"]}')" != "0" ] && [ $i -lt 120 ]; do sleep 5; i=$((i+1)); done
}

for I in "$@"; do
  echo "== scene $((I+1))"
  wait_idle
  NCH=$(scene 'console.log(s.chars.length)')
  [ "$NCH" -le 3 ] || { echo "!! scene $((I+1)): $NCH characters, Omni allows max 3"; exit 1; }
  node run_workflow.js press Escape --tab "$T" --raw >/dev/null 2>&1 || true
  # Leftover attached characters from a failed run vanish from the picker; clear them.
  run el click '{"css":"button","aria":["Xoá câu lệnh","Clear prompt"]}' '{"timeout":1500}' --tab "$T" >/dev/null 2>&1 || true
  sleep 1
  k=0
  while [ $k -lt "$NCH" ]; do
    NAME=$(scene 'process.stdout.write(s.chars[+process.argv[4]])' "$k")
    run el click '{"css":"button","aria":["Thêm thành phần vào ô nhập câu lệnh","Add to prompt","Add ingredients to the prompt box"]}' --tab "$T" >/dev/null
    run el waitAppear '{"css":"button[role=option].asset-item"}' '{"timeout":10000}' --tab "$T" >/dev/null
    # Match the name as the whole first line: plain text would let "Vova" hit "MeVova".
    # The picker lists only the newest assets, so filter with its search box; retry while it loads.
    PICK=$(node -e 'process.stdout.write(JSON.stringify({ref:{css:"button[role=option].asset-item",text:{regex:"^"+process.argv[1]+"( |$)"}},target:{tabId:+process.argv[2]}}))' "$NAME" "$T")
    try=0; ok=0
    while [ $try -lt 3 ] && [ $ok = 0 ]; do
      run call el.type "$(node -e 'process.stdout.write(JSON.stringify({ref:{css:"input",aria:["Search assets","Tìm kiếm tài sản","Tìm kiếm thành phần","Search ingredients"]},value:process.argv[1],target:{tabId:+process.argv[2]}}))' "$NAME" "$T")" >/dev/null 2>&1 || true
      sleep 2
      run call el.click "$PICK" >/dev/null 2>&1 && ok=1 || { try=$((try+1)); sleep 2; }
    done
    [ $ok = 1 ] || { echo "!! character not found: $NAME"; exit 1; }
    # The picker sometimes adds on item click and closes; then the confirm button is gone.
    run el click '{"css":"button","textExact":["Thêm vào câu lệnh","Add to prompt"]}' '{"timeout":2000}' --tab "$T" >/dev/null 2>&1 || true
    sleep 1
    k=$((k+1))
  done
  run call el.type "$(scene 'process.stdout.write(JSON.stringify({ref:"@flow.prompt",value:"Create 1 video, Omni 1.1 Flash, "+(process.env.ASPECT||"16:9")+", 720p, 10 seconds, 15 credits, using this prompt exactly as written:\n\n"+s.prompt,target:{tabId:+process.argv[3]}}))')" >/dev/null
  BEFORE=$(count "$APPROVE")
  run el click '{"css":"button","aria":["Bắt đầu tạo","Start generation","Create"],"nth":-1}' --tab "$T" >/dev/null
  i=0; NOW=$BEFORE
  while [ "$NOW" -le "$BEFORE" ] && [ $i -lt 36 ]; do sleep 5; NOW=$(count "$APPROVE"); i=$((i+1)); done
  if [ "$NOW" -le "$BEFORE" ]; then
    echo "!! scene $((I+1)): no approve chip, read the chat to see what the agent asked"; exit 1
  fi
  PLAN=$(node run_workflow.js el text body --tab "$T" --raw | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).data.text;const k=Math.max(t.lastIndexOf("Phê duyệt"),t.lastIndexOf("Approve"));console.log(t.slice(Math.max(0,k-400),k).trim())})')
  COST=$(printf '%s' "$PLAN" | grep -oE '[0-9]+ (credits|tín dụng)' | tail -1 | grep -oE '^[0-9]+')
  if printf '%s' "$PLAN" | grep -q 'Omni 1\.2' || [ -z "$COST" ] || [ "$COST" -ne "${MAX_PER_SCENE:-15}" ]; then
    run el click '{"textExact":["Từ chối","Reject"],"nth":-1}' --tab "$T" >/dev/null
    echo "!! scene $((I+1)): plan rejected (cost '${COST:-?}', want ${MAX_PER_SCENE:-15}, Omni 1.1)"; exit 1
  fi
  run el click '{"textExact":["Phê duyệt","Approve"],"nth":-1}' --tab "$T" >/dev/null
  echo "== approved scene $((I+1))"
  sleep 8
done
echo "== all sent"
