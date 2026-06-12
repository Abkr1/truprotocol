# truProtocol brand assets

The official mark: a white lowercase **t** on the brand-green rounded square.
The glyph is pure vector geometry (no font dependency), so it renders
identically everywhere.

| File | Use |
|---|---|
| `truprotocol-logo.svg` | **Master** (gradient `#43d089 -> #1fa365`, matches the dApp). Prefer this everywhere SVG is accepted. |
| `truprotocol-logo-<size>.png` | Rasters: 1024/512/256/128/64/48/32/16. 1024 for stores/social, 512 for app icons, 32+16 for favicons. |
| `truprotocol-logo-flat.svg` / `-flat-512.png` | Single-color variant (`#2bb673`) for print/embroidery/strict contexts. |
| `truprotocol-glyph-white.svg` / `-512.png` | The bare white "t" on transparency, for watermarks and dark surfaces. |
| `truprotocol-header-dark.svg` / `.png` / `@2x.png` | Twitter/X profile header (1500x500, plus 3000x1000). Wordmark needs the Inter font installed when re-rendering. |

Brand colors: gradient `#43d089 -> #1fa365`; flat green `#2bb673`; glyph `#ffffff`.
Corner radius is ~29% of the square (rx 140 at 480).

Re-render the PNGs after editing an SVG (WSL, needs `sharp` once via
`npm i sharp` in `~/logo_build`):

```bash
bash run_logo.sh   # at the repo root; wraps branding/render_logo.cjs
```
