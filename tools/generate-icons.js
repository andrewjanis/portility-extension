/**
 * generate-icons.js
 * Generates all 9 PNG icons for the Portility Chrome extension
 * from the Portility "P" logo.
 *
 * Run with:  node generate-icons.js
 * Requires:  npm install canvas
 *
 * Icon sets produced:
 *   Default   — full-color P logo (active state)
 *   Gray      — desaturated P logo (inactive state)
 *   Checkmark — green background with white checkmark (success state)
 */

var canvas = require('canvas');
var createCanvas = canvas.createCanvas;
var loadImage = canvas.loadImage;
var fs = require('fs');
var path = require('path');

var ICONS_DIR = path.join(__dirname, '..', 'src', 'icons');
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

var SIZES = [16, 48, 128];
var LOGO_PATH = path.join('c:', 'Users', 'andre', 'OneDrive', 'Documents', 'Portility AI', 'files', 'logo concepts', 'P Only.png');

/** Draw a rounded rectangle path. */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Draw the green checkmark icon (success state).
 */
function drawCheckIcon(size) {
  var c = createCanvas(size, size);
  var ctx = c.getContext('2d');

  var padding = size * 0.08;
  var radius = size * 0.22;

  ctx.fillStyle = '#16a34a';
  roundRect(ctx, padding, padding, size - padding * 2, size - padding * 2, radius);
  ctx.fill();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, size * 0.11);
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();

  var cx = size / 2;
  var cy = size / 2;
  var scale = size * 0.28;

  ctx.moveTo(cx - scale * 0.7, cy);
  ctx.lineTo(cx - scale * 0.1, cy + scale * 0.65);
  ctx.lineTo(cx + scale * 0.85, cy - scale * 0.55);
  ctx.stroke();

  return c.toBuffer('image/png');
}

/**
 * Draw the P logo icon at a given size.
 * @param {Image} logoImg  loaded logo image
 * @param {number} size    target size
 * @param {boolean} grayscale  if true, desaturate the image
 * @returns {Buffer} PNG buffer
 */
function drawLogoIcon(logoImg, size, grayscale) {
  var c = createCanvas(size, size);
  var ctx = c.getContext('2d');

  // Fill white background (the logo has a white background)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Crop to just the P letterform (left portion of the image, skip the scattered squares)
  var padding = Math.round(size * 0.02);
  var drawSize = size - padding * 2;

  // Use the full image — it's already just the P
  var srcX = 0;
  var srcY = 0;
  var srcWidth = logoImg.width;
  var srcHeight = logoImg.height;

  // Fit the cropped P into the square canvas, centered
  var srcAspect = srcWidth / srcHeight;
  var destW, destH, destX, destY;
  if (srcAspect > 1) {
    destW = drawSize;
    destH = Math.round(drawSize / srcAspect);
  } else {
    destH = drawSize;
    destW = Math.round(drawSize * srcAspect);
  }
  destX = padding + Math.round((drawSize - destW) / 2);
  destY = padding + Math.round((drawSize - destH) / 2);

  ctx.drawImage(logoImg, srcX, srcY, srcWidth, srcHeight, destX, destY, destW, destH);

  if (grayscale) {
    // Get pixel data and desaturate
    var imageData = ctx.getImageData(0, 0, size, size);
    var data = imageData.data;
    for (var i = 0; i < data.length; i += 4) {
      var avg = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      // Lighten the grayscale to make it look "inactive"
      var lightened = Math.round(avg * 0.6 + 255 * 0.4);
      data[i] = lightened;
      data[i + 1] = lightened;
      data[i + 2] = lightened;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  return c.toBuffer('image/png');
}

async function main() {
  console.log('Loading logo from: ' + LOGO_PATH);

  if (!fs.existsSync(LOGO_PATH)) {
    console.error('ERROR: Logo file not found at ' + LOGO_PATH);
    process.exit(1);
  }

  var logoImg = await loadImage(LOGO_PATH);
  console.log('Logo loaded: ' + logoImg.width + 'x' + logoImg.height);

  var generated = 0;

  for (var s = 0; s < SIZES.length; s++) {
    var size = SIZES[s];

    // Active (full color)
    var activeBuffer = drawLogoIcon(logoImg, size, false);
    var activeName = 'icon' + size + '.png';
    fs.writeFileSync(path.join(ICONS_DIR, activeName), activeBuffer);
    console.log('  done  ' + activeName);
    generated++;

    // Gray (desaturated)
    var grayBuffer = drawLogoIcon(logoImg, size, true);
    var grayName = 'icon' + size + '_gray.png';
    fs.writeFileSync(path.join(ICONS_DIR, grayName), grayBuffer);
    console.log('  done  ' + grayName);
    generated++;

    // Checkmark (green)
    var checkBuffer = drawCheckIcon(size);
    var checkName = 'icon' + size + '_check.png';
    fs.writeFileSync(path.join(ICONS_DIR, checkName), checkBuffer);
    console.log('  done  ' + checkName);
    generated++;
  }

  console.log('\nAll ' + generated + ' icons written to icons/');
}

main().catch(function (err) {
  console.error('Error: ' + err.message);
  process.exit(1);
});
