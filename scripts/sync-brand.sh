#!/usr/bin/env bash
# Copies the runtime subset of the official brand package (brand/VELSUNO, source of truth) to public/brand.
# Re-run after replacing the brand package. Never edit the copies by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=brand/VELSUNO
DST=public/brand
rm -rf "$DST"; mkdir -p "$DST/icons/ui" "$DST/social" "$DST/logo"
cp "$SRC"/icons/*.{svg,png,ico} "$DST/icons/"
cp "$SRC/icons/ui/sprite.svg" "$DST/icons/ui/"
cp "$SRC/social/og-image-1200x630.png" "$DST/social/"
cp "$SRC"/logo/*.svg "$DST/logo/"
echo "brand assets synced to $DST"
