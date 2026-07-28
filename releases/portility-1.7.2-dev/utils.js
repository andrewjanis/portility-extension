/**
 * utils.js
 * Portility — shared utility functions.
 */

'use strict';

/**
 * Compress an image data URL to JPEG within a target file size.
 * Loads the image onto a canvas, scales to maxDim, then iteratively
 * lowers JPEG quality until the result is under maxSizeKB.
 *
 * @param {string} dataUrl - Base64 data URL of the source image
 * @param {number} [maxSizeKB=500] - Target maximum size in kilobytes
 * @param {number} [maxDim=1024] - Maximum width or height in pixels
 * @returns {Promise<string>} Compressed JPEG data URL
 */
function compressImage(dataUrl, maxSizeKB, maxDim) {
  if (maxSizeKB === undefined) maxSizeKB = 500;
  if (maxDim === undefined) maxDim = 1024;

  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var w = img.width;
      var h = img.height;

      // Scale down if either dimension exceeds maxDim
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round(h * (maxDim / w));
          w = maxDim;
        } else {
          w = Math.round(w * (maxDim / h));
          h = maxDim;
        }
      }

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      var quality = 0.7;
      var result = canvas.toDataURL('image/jpeg', quality);

      // Approximate KB: strip the data:...;base64, prefix, then base64 → bytes
      function approxKB(url) {
        var base64 = url.split(',')[1] || '';
        return (base64.length * 0.75) / 1024;
      }

      // Iteratively reduce quality if over budget
      while (approxKB(result) > maxSizeKB && quality > 0.1) {
        quality = Math.round((quality - 0.1) * 10) / 10;
        result = canvas.toDataURL('image/jpeg', quality);
      }

      var beforeKB = approxKB(dataUrl).toFixed(1);
      var afterKB = approxKB(result).toFixed(1);
      console.log('[compressImage] ' + img.width + 'x' + img.height + ' → ' + w + 'x' + h +
        ' | quality ' + quality + ' | ' + beforeKB + ' KB → ' + afterKB + ' KB');

      resolve(result);
    };
    img.onerror = function () {
      reject(new Error('Failed to load image for compression'));
    };
    img.src = dataUrl;
  });
}
