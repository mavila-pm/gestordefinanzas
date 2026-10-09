# Vels avatar

- `vels-avatar-source.webp`: approved illustration, original file (1254×1254). Never redrawn or edited.
- Served derivatives in `public/brand/vels/` (square crop 820×820 at x=217, y=60: face, glasses, hair, shoulders,
  green circle as background; Lanczos resize; no color changes): `vels-avatar.png` 512 (lossless master),
  `vels-avatar-256.png` / `-128.png` / `-64.png` (256-color PNG, mean difference 0.64/255 vs lossless).
- `components/vels-identity.tsx` picks ≥2× the displayed size (≤32 px → 64, ≤64 → 128, else 256); CSS makes it round.
