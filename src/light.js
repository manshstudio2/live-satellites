const sampler = document.createElement('canvas');
sampler.width = sampler.height = 48;
const context = sampler.getContext('2d', { willReadFrequently: true });

export function centerLight(video, view, radius) {
  if (!context || video.readyState < 2 || !view.clientWidth || !view.clientHeight) return null;
  const scale = Math.max(view.clientWidth / video.videoWidth, view.clientHeight / video.videoHeight);
  const side = radius * 2 / scale;
  context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 48, 48);
  const pixels = context.getImageData(0, 0, 48, 48).data;
  const luma = new Uint8Array(48 * 48);
  let sum = 0;
  let brightest = 0;
  let peak = 0;
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4;
    const value = Math.round(pixels[p] * .2126 + pixels[p + 1] * .7152 + pixels[p + 2] * .0722);
    luma[i] = value;
    sum += value;
    if (value > brightest) { brightest = value; peak = i; }
  }
  const average = sum / luma.length;
  if (brightest < 45 || brightest - average < 34) return null;
  const x = peak % 48;
  const y = Math.floor(peak / 48);
  if (x < 3 || x > 44 || y < 3 || y > 44) return null;
  const threshold = Math.max(average + 22, brightest * .7);
  let total = 0;
  let weightedX = 0;
  let weightedY = 0;
  let core = 0;
  let other = 0;
  for (let i = 0; i < luma.length; i++) {
    const px = i % 48;
    const py = Math.floor(i / 48);
    if (luma[i] < threshold) continue;
    if (Math.abs(px - x) > 3 || Math.abs(py - y) > 3) { other++; continue; }
    const weight = luma[i] - average;
    total += weight;
    weightedX += px * weight;
    weightedY += py * weight;
    core++;
  }
  if (core < 2 || other > core + 4) return null;
  return {
    x: view.clientWidth / 2 + (weightedX / total + .5 - 24) * radius / 24,
    y: view.clientHeight / 2 + (weightedY / total + .5 - 24) * radius / 24,
  };
}
