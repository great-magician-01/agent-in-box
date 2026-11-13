# Desktop icon assets

`icon.png` (1024 × 1024, transparent corners), `icon.ico` (sizes 16/24/32/48/64/128/256)
and `icon.icns` (macOS icon grid with transparent padding) are generated from the single SVG
source at `../../web/public/logo.svg`, which is also the browser favicon used by the web app.

When the logo changes, regenerate all three files from that SVG. Keep the rounded white tile
and the transparent corners, and keep the multi-size frames in the ICO so small Windows icons
stay legible.
