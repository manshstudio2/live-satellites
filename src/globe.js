import { groundAt, radians } from './orbit.js';
import landUrl from './land.json?url';

const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
const texture = document.createElement('canvas');
texture.width = 720;
texture.height = 360;
const surface = document.createElement('canvas');
surface.width = surface.height = 480;
const surfaceContext = surface.getContext('2d');
let world, backdropKey, azimuth = 20 * radians, elevation = 18 * radians, zoom = 1;
let observer, targets = [], selection, selectSatellite, plotted = [];
let pointer;

export async function loadLand() {
  const response = await fetch(landUrl);
  if (!response.ok) throw new Error('Earth texture unavailable');
  const data = await response.json();
  const ctx = texture.getContext('2d');
  ctx.fillStyle = '#173954';
  ctx.fillRect(0, 0, texture.width, texture.height);
  ctx.fillStyle = '#4e9b84';
  for (const { geometry } of data.features) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      ctx.beginPath();
      for (const ring of polygon) {
        ring.forEach(([lon, lat], index) => {
          const x = (lon + 180) * 2;
          const y = (90 - lat) * 2;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }
  world = ctx.getImageData(0, 0, texture.width, texture.height).data;
  backdropKey = null;
  render();
}

function globeSurface() {
  const key = [azimuth, elevation].join(',');
  if (backdropKey === key) return;
  backdropKey = key;
  const size = surface.width;
  const half = size / 2;
  const pixels = surfaceContext.createImageData(size, size);
  const sinLat = Math.sin(elevation);
  const cosLat = Math.cos(elevation);
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
      const light = .65 + .27 * z + .1 * (y - x);
      const rim = (1 - z) ** 4 * 28;
      pixels.data[out] = (world?.[index] ?? 23) * light + rim;
      pixels.data[out + 1] = (world?.[index + 1] ?? 57) * light + rim * 1.5;
      pixels.data[out + 2] = (world?.[index + 2] ?? 84) * light + rim * 2;
      pixels.data[out + 3] = Math.min(255, (1 - square) * size * 80);
    }
  }
  surfaceContext.putImageData(pixels, 0, 0);
}
function render() {
  if (canvas.closest('section').hidden) return;
  const { width, height } = canvas;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * .35 * zoom;
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
  context.fillStyle = '#081722';
  context.fillRect(0, 0, width, height);
  globeSurface();
  context.drawImage(surface, centerX - radius, centerY - radius, radius * 2, radius * 2);
  plotted = [];
  for (const { satellite, ground } of targets) {
    const point = project(ground);
    if (!point.visible) continue;
    const selected = satellite.id === selection;
    dot(point, selected ? 6 : 2.5, selected ? '#ffe0a3' : '#b0c9ff');
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
export function updateGlobe(location, satellites, time, selected, onSelect) {
  if (location && location !== observer) {
    azimuth = location.longitude;
    elevation = location.latitude;
  }
  observer = location;
  selection = selected;
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
  if (pointer) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0 };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (pointer?.id !== event.pointerId) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.distance += Math.hypot(dx, dy);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  adjust(-dx * .008, dy * .008);
});
canvas.addEventListener('pointerup', event => {
  if (pointer?.id !== event.pointerId) return;
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
  pointer = null;
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
const zoomIn = document.querySelector('#earth-zoom-in');
const zoomOut = document.querySelector('#earth-zoom-out');
function changeZoom(scale) {
  zoom = Math.max(.55, Math.min(1.6, zoom * scale));
  updateZoomControls();
  render();
}
function updateZoomControls() {
  zoomIn.disabled = zoom >= 1.6;
  zoomOut.disabled = zoom <= .55;
}
zoomIn.onclick = () => changeZoom(1.2);
zoomOut.onclick = () => changeZoom(1 / 1.2);
canvas.addEventListener('wheel', event => {
  if (document.activeElement !== canvas) return;
  event.preventDefault();
  changeZoom(Math.exp(-event.deltaY * .001));
}, { passive: false });
