#!/bin/sh
# Unzip a Google Flow download, order clips by scene and join them into one film.
# Usage: assemble.sh <zip> <out_dir> <film_name> <file_prefix_scene1> <file_prefix_scene2> ...
# File names in the zip are tile titles (e.g. "Prince_discarding_princess_portr…_3e8b918c.mp4");
# pass a unique start of each name, in scene order.
set -e
ZIP=$1; OUT=$2; NAME=$3; shift 3
[ -f "$ZIP" ] && [ -n "$OUT" ] && [ -n "$NAME" ] && [ $# -gt 0 ] || { echo "usage: assemble.sh <zip> <out_dir> <film_name> <prefix>..."; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }

mkdir -p "$OUT/clips"
unzip -o -q "$ZIP" -d "$OUT/clips"
: > "$OUT/list.txt"
i=0
for p in "$@"; do
  i=$((i+1)); n=$(printf "%02d" $i)
  f=$(cd "$OUT/clips" && ls | grep -F -- "$p" | grep -v '^scene_' | head -1)
  [ -n "$f" ] || { echo "!! no clip matches: $p"; exit 1; }
  mv "$OUT/clips/$f" "$OUT/clips/scene_$n.mp4"
  echo "file 'clips/scene_$n.mp4'" >> "$OUT/list.txt"
done
left=$(cd "$OUT/clips" && ls | grep -v '^scene_' || true)
[ -z "$left" ] || echo "note: clips not used: $left"

# Stream copy only works when every clip has the same codecs and size.
sigs=$(for f in "$OUT"/clips/scene_*.mp4; do ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate -of csv=p=0 "$f" | tr '\n' ' '; echo; done | sort -u | wc -l)
cd "$OUT"
if [ "$sigs" -eq 1 ]; then
  ffmpeg -y -v error -f concat -safe 0 -i list.txt -c copy "$NAME.mp4"
else
  echo "clips differ, re-encoding"
  ffmpeg -y -v error -f concat -safe 0 -i list.txt -c:v libx264 -crf 18 -c:a aac -b:a 192k "$NAME.mp4"
fi
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$NAME.mp4"
# One frame from the middle of each 10 s clip, to check order at a glance.
ffmpeg -y -v error -ss 5 -i "$NAME.mp4" -vf "fps=1/10,scale=320:-1,tile=5x$(( ($i + 4) / 5 ))" -frames:v 1 "${NAME}_sheet.jpg"
echo "== $OUT/$NAME.mp4"
