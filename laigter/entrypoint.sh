#!/bin/sh
# Run the extracted Laigter AppImage headless under a throwaway X server.
#   -g  --no-gui          (baked in — callers never want the GUI here)
#   -s  --software-opengl (llvmpipe; no GPU in this pipeline)
# Everything after is passed through from `bin/laigter` (-d/-n/-r/...).
#
# NOT exec'd, and the compose service sets `init: true`: as PID 1, xvfb-run's
# trap-based Xvfb teardown wedges after Laigter finishes (PID 1 reaping
# semantics), which hangs the whole run. Keeping a real init/shell above it
# lets it exit cleanly.
#
# `timeout` is a safety net: Laigter writes the map and *then* can linger on
# the GL/event-loop shutdown, so a kill after the deadline still leaves valid
# output — the batch driver keys success off the file existing, not the exit
# code, so a timeout (124) is treated as success here.
timeout "${LAIGTER_TIMEOUT:-180}" \
  xvfb-run -a -s "-screen 0 1024x1024x24" \
  /opt/squashfs-root/AppRun -g -s "$@"
status=$?
[ "$status" = 124 ] && status=0
exit "$status"
