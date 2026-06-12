// Renders the truProtocol SVG logos to PNG at standard sizes (run via sharp).
const sharp = require('sharp');
const fs = require('fs');
const B = '/mnt/c/Users/USER/Documents/GitHub/trudao/branding';
const jobs = [
  { src: 'truprotocol-logo.svg', name: 'truprotocol-logo', sizes: [1024, 512, 256, 128, 64, 48, 32, 16] },
  { src: 'truprotocol-logo-flat.svg', name: 'truprotocol-logo-flat', sizes: [512] },
  { src: 'truprotocol-glyph-white.svg', name: 'truprotocol-glyph-white', sizes: [512] },
];
(async () => {
  for (const j of jobs) {
    const svg = fs.readFileSync(`${B}/${j.src}`);
    for (const s of j.sizes) {
      const density = Math.max(72, Math.ceil((72 * s) / 512) * 4); // supersample for crisp small sizes
      await sharp(svg, { density }).resize(s, s).png().toFile(`${B}/${j.name}-${s}.png`);
      console.log('wrote', j.name, s);
    }
  }
  console.log('RENDER_DONE');
})().catch((e) => { console.error(e); process.exit(1); });
