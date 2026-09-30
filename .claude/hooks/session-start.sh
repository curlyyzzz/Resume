#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs the tools the project skills rely on:
#   - ffmpeg      (add-work: remux/compress videos, posters, image conversion)
#   - Playwright  (site-check, add-work: screenshots and in-browser checks)
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# --- ffmpeg -----------------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  python3 -m pip install --quiet --disable-pip-version-check --root-user-action=ignore imageio-ffmpeg
  FF="$(python3 -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
  if [ -w /usr/local/bin ]; then
    ln -sf "$FF" /usr/local/bin/ffmpeg
  else
    mkdir -p "$HOME/.local/bin"
    ln -sf "$FF" "$HOME/.local/bin/ffmpeg"
    [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$HOME/.local/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

# --- Playwright (browsers are preinstalled in /opt/pw-browsers) -------------
if [ ! -d "$(npm root -g)/playwright" ]; then
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --silent playwright
fi

echo "session-start: ffmpeg=$(command -v ffmpeg || echo "$HOME/.local/bin/ffmpeg") playwright=$(npm root -g)/playwright"
