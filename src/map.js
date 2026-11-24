import { groundAt, radians } from './orbit.js';
import landUrl from './land.json?url';

const canvas = document.querySelector('#world');
const context = canvas.getContext('2d');
let land;
export async function loadLand() {
  const response = await fetch(landUrl);
  if (!response.ok) throw new Error('Map unavailable');
  land = (await response.json()).features;
}
export function drawMap(satellite, observer, time) {
  const width = canvas.width;
  const height = canvas.height;
  const xy = (longitude, latitude) => [(longitude + 180) * width / 360, (90 - latitude) * height / 180];
  context.fillStyle = '#0b2030';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#254252';
  context.lineWidth = 1;
  context.beginPath();
  for (let lon = -150; lon <= 150; lon += 30) {
    const [x] = xy(lon, 0);
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = xy(0, lat);
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.fillStyle = '#294858';
  for (const { geometry } of land ?? []) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      context.beginPath();
      for (const ring of polygon) {
        ring.forEach(([lon, lat], index) => {
          const [x, y] = xy(lon, lat);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.closePath();
      }
      context.fill('evenodd');
    }
  }
  function track(start, end, color, dashed) {
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.setLineDash(dashed ? [6, 6] : []);
    context.beginPath();
    let previous;
    for (let at = start; at <= end; at += 60_000) {
      const point = groundAt(satellite.record, at);
      if (!point) { previous = undefined; continue; }
      const [x, y] = xy(point.longitude / radians, point.latitude / radians);
      if (previous === undefined || Math.abs(x - previous) > width / 2) context.moveTo(x, y);
      else context.lineTo(x, y);
      previous = x;
    }
    context.stroke();
    context.setLineDash([]);
  }
  function dot(point, color, size) {
    const [x, y] = xy(point.longitude / radians, point.latitude / radians);
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = '#07151e';
    context.lineWidth = 3;
    context.stroke();
  }
  const current = satellite && groundAt(satellite.record, time);
  if (current) {
    track(time - 45 * 60_000, time, '#8bb5ff', false);
    track(time, time + 45 * 60_000, '#8bb5ff', true);
    dot(current, '#a9c7ff', 9);
  }
  if (observer) dot(observer, '#9ae8c5', 7);
  return current;
}

