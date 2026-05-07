const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const QRCode = require('qrcode');
const sharp = require('sharp');

const MASTER = path.join(__dirname, 'master', process.env.MASTER_VIDEO || 'myhome-rural-raw.mp4');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_1834f270e20daf5c0798106ddbf154fd5d131fdf9a0a7240';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'G7ILShrCNLfmS0A37SXS';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, stdio: ['pipe','pipe','pipe'] });
}

// Get video dimensions and framerate from source
function getVideoInfo(filePath) {
  const out = run(`ffprobe -v quiet -print_format json -show_streams "${filePath}"`);
  const streams = JSON.parse(out).streams;
  const v = streams.find(s => s.codec_type === 'video');
  const [fpsNum, fpsDen] = v.r_frame_rate.split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: fpsNum / fpsDen,
    duration: parseFloat(v.duration || 0)
  };
}

// Convert SS:FF (seconds:frames) to decimal seconds
function toSecs(ss, ff, fps) {
  return ss + ff / fps;
}

function deriveVipSlug(agentUrl) {
  try {
    const url = agentUrl.startsWith('http') ? agentUrl : `https://${agentUrl}`;
    let host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].toLowerCase();
  } catch (e) {
    return agentUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0].toLowerCase();
  }
}

async function makeTextPng(text, outPath, { fontSize = 40, color = 'white', fontFamily = 'Helvetica, Arial, sans-serif', fontWeight = 'normal', width, height = 120 } = {}) {
  const w = width || Math.max(500, text.length * fontSize * 0.65);
  // Escape fontFamily for safe SVG attribute embedding (replace double quotes with single)
  const safeFontFamily = fontFamily.replace(/"/g, "'");
  const svg = `<svg width="${w}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${w/2}" y="${height/2}" font-family="${safeFontFamily}" font-weight="${fontWeight}" font-size="${fontSize}" fill="${color}" text-anchor="middle" dominant-baseline="middle">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return { width: w, height };
}

async function resizeLogo(logoPath, outPath, maxW, maxH) {
  const meta = await sharp(logoPath)
    .resize(maxW, maxH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  return meta;
}

async function buildVideo({ logoPath, agentName, agentUrl, outputPath, jobDir }) {
  console.log(`[Pipeline] Starting for: ${agentName}`);

  // Read actual video dimensions
  const info = getVideoInfo(MASTER);
  const VW = info.width, VH = info.height, FPS = info.fps;
  console.log(`[Pipeline] Source: ${VW}x${VH} @ ${FPS}fps`);

  const slug     = deriveVipSlug(agentUrl);
  const vipUrl   = `vip.myporta.ai/${slug}`;
  const vipQrUrl = `https://${vipUrl}`;
  console.log(`[Pipeline] VIP URL: ${vipQrUrl}`);

  // --- Timestamps (SS:FF notation from Mal, converted to decimal seconds) ---
  const T_LOGO_CENTRE_IN  = toSecs(1, 13, FPS);   // 01:13 → logo appears centre
  const T_LOGO_CENTRE_OUT = toSecs(4,  8, FPS);   // 04:08 → logo leaves centre
  const T_LOGO_TR_IN      = toSecs(4, 19, FPS);   // 04:19 → logo appears top-right
  // logo top-right stays to end of video
  const T_QR_IN           = toSecs(53, 7, FPS);   // 53:07 → QR + URL appear
  // QR stays to end
  console.log(`[Pipeline] Timestamps: centre ${T_LOGO_CENTRE_IN.toFixed(2)}-${T_LOGO_CENTRE_OUT.toFixed(2)}s, top-right from ${T_LOGO_TR_IN.toFixed(2)}s, QR from ${T_QR_IN.toFixed(2)}s`);

  const qrPath      = path.join(jobDir, 'qr.png');
  const logoSmall   = path.join(jobDir, 'logo_small.png');
  const logoCentre  = path.join(jobDir, 'logo_centre.png');
  const txtVipUrl   = path.join(jobDir, 'txt_vip_url.png');

  console.log('[1/3] Building overlays...');

  // --- QR code: ~3cm wide. At 96dpi: 3cm = ~113px. Use 120px to be safe.
  // 5cm x 5cm: at 96dpi on a 1080p frame, 5cm = 189px = 17.5% of VH
  const QR_SIZE = Math.round(VH * 0.175);
  await QRCode.toFile(qrPath, vipQrUrl, {
    width: QR_SIZE, margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });

  // --- Logos ---
  // Top-right logo: ~5mm from edges. At typical screen sizes ~14-18px margin.
  // Logo itself: small, no taller than ~8% of height
  const TR_MARGIN = Math.round(VW * 0.018);   // ~5mm at typical viewing size
  const TR_MAX_W  = Math.round(VW * 0.12);    // max 12% of width
  const TR_MAX_H  = Math.round(VH * 0.09);    // max 9% of height
  await resizeLogo(logoPath, logoSmall, TR_MAX_W, TR_MAX_H);
  const logoSmallMeta = await sharp(logoSmall).metadata();
  const lsW = logoSmallMeta.width, lsH = logoSmallMeta.height;
  const lsX = VW - lsW - TR_MARGIN;
  const lsY = TR_MARGIN;

  // Centre logo: proportionally larger, centred horizontally,
  // midway between bottom of MyHome logo and bottom of screen.
  // MyHome logo is approximately top 40% of frame — so midpoint of bottom 60% = ~70% down
  const CL_MAX_W = Math.round(VW * 0.35);
  const CL_MAX_H = Math.round(VH * 0.20);
  await resizeLogo(logoPath, logoCentre, CL_MAX_W, CL_MAX_H);
  const logoCentreMeta = await sharp(logoCentre).metadata();
  const lcW = logoCentreMeta.width, lcH = logoCentreMeta.height;
  // MyHome logo occupies roughly top 38% → bottom of MyHome logo ≈ VH*0.38
  // Midpoint between VH*0.38 and VH = VH * (0.38 + 1) / 2 = VH * 0.69
  const lcY = Math.round(VH * 0.69 - lcH / 2);
  const lcX = Math.round((VW - lcW) / 2);

  // --- VIP URL text: DM Sans Bold to match the MyHome by MyPorta logo font
  const URL_FONT_SIZE = Math.round(VH * 0.057);
  const urlDims = await makeTextPng(vipUrl, txtVipUrl, {
    fontSize: URL_FONT_SIZE,
    color: '#000000',
    fontFamily: '"DM Sans", "DMSans", Helvetica, Arial, sans-serif',
    fontWeight: 'bold',
    height: Math.round(URL_FONT_SIZE * 1.8)
  });

  // QR centred on screen
  const qrX = Math.round((VW - QR_SIZE) / 2);
  const QR_TOP_OFFSET = Math.round(VH * 0.45); // QR sits at ~45% down
  const qrY = QR_TOP_OFFSET;
  // URL text centred directly below QR with a small gap
  const urlGap = Math.round(VH * 0.015);
  const urlX = Math.round((VW - urlDims.width) / 2);
  const urlY = qrY + QR_SIZE + urlGap;

  console.log(`[Pipeline] Logo centre: ${lcW}x${lcH} at (${lcX},${lcY})`);
  console.log(`[Pipeline] Logo top-right: ${lsW}x${lsH} at (${lsX},${lsY}), margin ${TR_MARGIN}px`);
  console.log(`[Pipeline] QR: ${QR_SIZE}px at (${qrX},${qrY}), URL at (${urlX},${urlY})`);

  // --- Audio: pass through original untouched (no ElevenLabs splice) ---
  console.log('[2/3] Skipping audio mix — using original audio track...');

  // --- Composite video ---
  console.log('[3/3] Rendering video...');

  run(`ffmpeg -y \
    -i "${MASTER}" \
    -i "${logoCentre}" \
    -i "${logoSmall}" \
    -i "${qrPath}" \
    -i "${txtVipUrl}" \
    -filter_complex "\
      [0:v][1:v]overlay=x=${lcX}:y=${lcY}:enable='between(t,${T_LOGO_CENTRE_IN},${T_LOGO_CENTRE_OUT})'[v1];\
      [v1][2:v]overlay=x=${lsX}:y=${lsY}:enable='between(t,${T_LOGO_TR_IN},9999)'[v2];\
      [v2][3:v]overlay=x=${qrX}:y=${qrY}:enable='between(t,${T_QR_IN},9999)'[v3];\
      [v3][4:v]overlay=x=${urlX}:y=${urlY}:enable='between(t,${T_QR_IN},9999)'[vout]" \
    -map "[vout]" -map "0:a" \
    -c:v libx264 -preset fast -crf 18 \
    -c:a copy \
    "${outputPath}"`);

  console.log(`[Pipeline] ✅ Done: ${outputPath}`);
  return outputPath;
}

module.exports = { buildVideo };
