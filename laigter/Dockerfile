# Headless Laigter (sprite normal/specular/occlusion/parallax generator).
#
# Laigter ships as a Qt + OpenGL AppImage. Even with --no-gui it still spins up
# a GL context, so the container needs an X server (Xvfb) and a software GL
# stack (Mesa llvmpipe) — there's no GPU in this pipeline. The AppImage is
# *extracted* at build time (`--appimage-extract`, which needs no FUSE) and run
# from squashfs-root, so the runtime needs no FUSE/loop device either.
#
# AppImages bundle their own Qt, but the bundled xcb platform plugin still
# dlopens the system libxcb-* set, so those are installed explicitly.
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb ca-certificates wget \
      libgl1-mesa-dri libglx-mesa0 libegl1 libopengl0 libgl1 libglu1-mesa \
      libfontconfig1 libfreetype6 libdbus-1-3 libnss3 \
      libxkbcommon0 libxkbcommon-x11-0 \
      libxcb1 libx11-xcb1 libxcb-glx0 libxcb-icccm4 libxcb-image0 \
      libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-render0 \
      libxcb-shape0 libxcb-shm0 libxcb-sync1 libxcb-xfixes0 \
      libxcb-xinerama0 libxcb-util1 libxcb-cursor0 \
 && rm -rf /var/lib/apt/lists/*

ARG LAIGTER_VER=1.13.1
RUN wget -qO /tmp/laigter.AppImage \
      "https://github.com/azagaya/laigter/releases/download/${LAIGTER_VER}/Laigter-x86_64.AppImage" \
 && chmod +x /tmp/laigter.AppImage \
 && cd /opt && /tmp/laigter.AppImage --appimage-extract \
 && rm /tmp/laigter.AppImage

# llvmpipe software GL; xcb platform under Xvfb (offscreen gives no GL surface).
ENV LIBGL_ALWAYS_SOFTWARE=1 \
    QT_QPA_PLATFORM=xcb \
    QT_OPENGL=software

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
