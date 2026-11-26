import { groundAt, radians } from './orbit.js';
import dayUrl from './earth-day.webp';
import nightUrl from './earth-night.webp';

const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
const texture = document.createElement('canvas');
texture.width = 1440;
texture.height = 720;
const surface = document.createElement('canvas');
surface.width = surface.height = 600;
const surfaceContext = surface.getContext('2d');
let world, night, sun, sunMinute, backdropKey, azimuth = 20 * radians, elevation = 18 * radians, zoom = 1;
let observer, targets = [], selection, selectSatellite, plotted = [], trajectory = [];
const pointers = new Map();

async function readTexture(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const context = texture.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, texture.width, texture.height);
  return context.getImageData(0, 0, texture.width, texture.height).data;
}
export async function loadEarthTextures() {
  [world, night] = await Promise.all([readTexture(dayUrl), readTexture(nightUrl)]);
  backdropKey = null;
  render();
}
function globeSurface() {
  const key = [azimuth, elevation, sunMinute].join(',');
  if (backdropKey === key) return;
  backdropKey = key;
  const size = surface.width;
  const half = size / 2;
  const pixels = surfaceContext.createImageData(size, size);
  const sinLat = Math.sin(elevation);
  const cosLat = Math.cos(elevation);
  const norm = Math.hypot(sun.x, sun.y, sun.z);
  const sinLon = Math.sin(azimuth);
  const cosLon = Math.cos(azimuth);
  const forward = (sun.x * cosLon + sun.y * sinLon) / norm;
  const north = sun.z / norm;
  const sunX = (sun.y * cosLon - sun.x * sinLon) / norm;
  const sunY = north * cosLat - forward * sinLat;
  const sunZ = north * sinLat + forward * cosLat;

  for (let row = 0; row < size; row++) {
    const y = (half - row - .5) / half;
    for (let col = 0; col < size; col++) {
      const x = (col + .5 - half) / half;
      const square = x * x + y * y;
      if (square >= 1) continue;
      const z = Math.sqrt(1 - square);
      const lat = Math.asin(Math.max(-1, Math.min(1, y * cosLat + z * sinLat)));
      const lon = azimuth + Math.atan2(x, z * cosLat - y * sinLat);
      const tx = ((Math.floor((lon / Math.PI + 1) * texture.width / 2) % texture.width) + texture.width) % texture.width;
      const ty = Math.min(texture.height - 1, Math.floor((.5 - lat / Math.PI) * texture.height));
      const index = 4 * (ty * texture.width + tx);
      const out = 4 * (row * size + col);
      const incidence = x * sunX + y * sunY + z * sunZ;
      const twilight = Math.max(0, Math.min(1, (incidence + .13) / .34));
      const day = twilight * twilight * (3 - 2 * twilight);
      const diffuse = day * (.38 + .76 * Math.max(0, incidence));
      const city = ((night?.[index] ?? 0) / 255) ** 1.05 * (1 - day);
      const rim = (1 - z) ** 3 * (9 + 67 * day);
      const warm = Math.max(0, 1 - Math.abs(incidence - .035) * 11) * 13;
      pixels.data[out] = (world?.[index] ?? 23) * (diffuse + .035) + city * 245 + rim * .29 + warm;
      pixels.data[out + 1] = (world?.[index + 1] ?? 57) * (diffuse + .04) + city * 163 + rim * .6 + warm * .40;
      pixels.data[out + 2] = (world?.[index + 2] ?? 84) * (diffuse + .075) + city * 62 + rim + 5;
      pixels.data[out + 3] = Math.min(255, (1 - square) * size * 80);
    }
  }
  surfaceContext.putImageData(pixels, 0, 0);
}
function render() {
  if (canvas.closest('section').hidden || !sun) return;
  const { width, height } = canvas;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * .415 * zoom;
  const project = ({ latitude, longitude, height: altitude = 0 }) => {
    const delta = longitude - azimuth;
    const cos = Math.cos(latitude);
    const north = Math.sin(latitude);
    const facing = Math.cos(delta) * cos;
    const distance = 1 + .16 * Math.log1p(Math.max(0, altitude) / 350);
    const x = Math.sin(delta) * cos * distance;
    const y = (north * Math.cos(elevation) - facing * Math.sin(elevation)) * distance;
    const depth = (north * Math.sin(elevation) + facing * Math.cos(elevation)) * distance;
    return { x: centerX + x * radius, y: centerY - y * radius, visible: depth >= 0 || x*x + y*y > 1 };
  };
  function dot(point, size, color) {
    context.beginPath();
    context.arc(point.x, point.y, size, 0, 2 * Math.PI);
    context.fillStyle = color;
    context.fill();
  }
  context.fillStyle = '#02050d';
  context.fillRect(0, 0, width, height);
  context.save();
  context.shadowColor = '#468ce8';
  context.shadowBlur = 19;
  globeSurface();
  context.drawImage(surface, centerX - radius, centerY - radius, radius * 2, radius * 2);
  context.restore();
  context.beginPath();
  context.strokeStyle = '#a7e7ff';
  context.lineWidth = 2;
  context.setLineDash([6, 5]);
  let previousVisible = false;
  for (const ground of trajectory) {
    const point = ground && project(ground);
    if (!point?.visible) { previousVisible = false; continue; }
    if (previousVisible) context.lineTo(point.x, point.y);
    else context.moveTo(point.x, point.y);
    previousVisible = true;
  }
  context.stroke();
  context.setLineDash([]);
  plotted = [];
  for (const { satellite, ground } of targets) {
    const point = project(ground);
    if (!point.visible) continue;
    const selected = satellite.id === selection;
    dot(point, selected ? 6 : 2.5, selected ? '#ffe0a3' : '#b0c9ff');
    if (selected) {
      context.font = 'bold 17px system-ui';
      const name = satellite.name;
      const width = Math.min(220, context.measureText(name).width);
      const x = Math.max(6, Math.min(canvas.width - width - 6, point.x + 10));
      const y = Math.max(20, point.y - 9);
      context.strokeStyle = '#081722';
      context.lineWidth = 4;
      context.strokeText(name, x, y, 220);
      context.fillStyle = '#ffe0a3';
      context.fillText(name, x, y, 220);
    }
    plotted.push({ ...point, id: satellite.id });
  }
  if (observer) {
    const point = project({ ...observer, height: 0 });
    if (point.visible) {
      dot(point, 7, '#07151e');
      dot(point, 5, '#9ae8c5');
    }
  }
  canvas.setAttribute('aria-label', observer
    ? '3D Earth with your location and ' + targets.length + ' satellites above your horizon'
    : '3D Earth. Allow location to show satellites above you.');
}
export function updateGlobe(location, satellites, time, selected, onSelect, sunPosition, selectedSatellite) {
  sun = sunPosition;
  sunMinute = Math.floor(time / 60_000);
  if (location && location !== observer) {
    azimuth = location.longitude;
    elevation = location.latitude;
  }
  observer = location;
  selection = selected;
  trajectory = [];
  if (selectedSatellite) {
    for (let minutes = 0; minutes <= 20; minutes += .5) {
      trajectory.push(groundAt(selectedSatellite.record, time + minutes * 60_000));
    }
  }
  selectSatellite = onSelect;
  targets = satellites.flatMap(({ satellite }) => {
    const ground = groundAt(satellite.record, time);
    return ground ? [{ satellite, ground }] : [];
  });
  render();
}
document.querySelector('#center-earth').onclick = () => {
  azimuth = observer?.longitude ?? 20 * radians;
  elevation = observer?.latitude ?? 18 * radians;
  zoom = 1;
  updateZoomControls();
  render();
};
function adjust(dx, dy) {
  azimuth += dx;
  elevation = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, elevation + dy));
  render();
}
canvas.addEventListener('keydown', event => {
  const moves = { ArrowLeft: [-.13, 0], ArrowRight: [.13, 0], ArrowUp: [0, .13], ArrowDown: [0, -.13] };
  if (!moves[event.key]) return;
  event.preventDefault();
  adjust(...moves[event.key]);
});
canvas.addEventListener('pointerdown', event => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, distance: 0 });
  if (pointers.size > 1) for (const pointer of pointers.values()) pointer.distance = 6;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.distance += Math.hypot(dx, dy);
  const second = Array.from(pointers.values()).find(other => other !== pointer);
  const previousGap = second && Math.hypot(pointer.x - second.x, pointer.y - second.y);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (previousGap > 0) changeZoom(Math.hypot(pointer.x - second.x, pointer.y - second.y) / previousGap);
  else if (!second) adjust(-dx * .008, dy * .008);
});
canvas.addEventListener('pointerup', event => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  if (pointer.distance < 6) {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * canvas.width / box.width;
    const y = (event.clientY - box.top) * canvas.height / box.height;
    let closest = 16;
    let id;
    for (const item of plotted) {
      const distance = Math.hypot(x - item.x, y - item.y);
      if (distance < closest) { id = item.id; closest = distance; }
    }
    if (id) selectSatellite(id);
  }
  pointers.delete(event.pointerId);
});
canvas.addEventListener('lostpointercapture', event => { pointers.delete(event.pointerId); });
const zoomIn = document.querySelector('#earth-zoom-in');
const zoomOut = document.querySelector('#earth-zoom-out');
function changeZoom(scale) {
  zoom = Math.max(.48, Math.min(2.7, zoom * scale));
  updateZoomControls();
  render();
}
function updateZoomControls() {
  zoomIn.disabled = zoom >= 2.7;
  zoomOut.disabled = zoom <= .48;
}
zoomIn.onclick = () => changeZoom(1.2);
zoomOut.onclick = () => changeZoom(1 / 1.2);
canvas.addEventListener('wheel', event => {
  if (document.activeElement !== canvas) return;
  event.preventDefault();
  changeZoom(Math.exp(-event.deltaY * .001));
}, { passive: false });
