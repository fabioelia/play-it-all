#!/bin/sh
# Generates demo/demo.webm: a 90 s test clip with burned-in labels
# marking where the demo's "explicit" scenes are, plus a tone track so muting
# is audible. Requires ffmpeg.
set -e
OUT="${1:-$(dirname "$0")/../demo/demo.webm}"
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=480x270:rate=24:duration=90" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=90" \
  -vf "drawbox=x=0:y=0:w=iw:h=ih:color=red@0.55:t=fill:enable='between(t,20,30)',\
drawbox=x=0:y=0:w=iw:h=ih:color=magenta@0.55:t=fill:enable='between(t,44,52)',\
drawbox=x=0:y=0:w=iw:h=ih:color=yellow@0.45:t=fill:enable='between(t,60,62)',\
drawbox=x=0:y=0:w=iw:h=ih:color=darkred@0.65:t=fill:enable='between(t,70,75)'" \
  -c:v libvpx -b:v 300k -deadline realtime -cpu-used 8 -c:a libopus -b:a 48k "$OUT"
echo "wrote $OUT"
