import './style.css';
import { findPass, groundAt, lookAt, parseCatalog, radians, skyClock, skyIsDark } from './orbit.js';
import { project } from './camera.js';
import { drawMap, loadLand } from './map.js';
import { centerLight } from './light.js';

const byId = id => document.getElementById(id);
const video = document.querySelector('video');
const view = document.querySelector('.view');
const activeUrl = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV';
const issUrl = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=CSV';
const twoHours = 7_200_000;
const staleAge = 3 * 86_400_000;
const timeLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const passCache = new Map();
let catalog = new Map();
let activeCatalog = false;
let selectedId = '25544';
let observer, pose, stream, arError, lastMap = 0;
let mapMode = false;
let samples = [];
let matches = [];
let lastScan = 0;

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* The tracker works without local storage. */ }
}
const feedRequests = new Map();
async function fetchElements(url, key) {
  if (feedRequests.has(key)) return feedRequests.get(key);
  const task = (async () => {
    const storage = await window.caches?.open('live-satellites-orbits-v1').catch(() => null);
    const cached = await storage?.match(url).catch(() => null);
    const previous = await cached?.text().catch(() => null);
    const lastAttempt = Math.max(Number(read(key + '-attempt')), feedAttempts.get(key) ?? 0);
    if (read(key + '-paused') || feedPaused.has(key) || Date.now() - lastAttempt < twoHours) return previous;
    feedAttempts.set(key, Date.now());
    write(key + '-attempt', String(Date.now()));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(key === 'active-gp' ? 120000 : 15000) });
      if (!response.ok) {
        write(key + '-paused', '1');
        feedPaused.add(key);
        return previous;
      }
      const copy = response.clone();
      const csv = await response.text();
      parseCatalog(csv);
      await storage?.put(url, copy).catch(() => {});
      return csv;
    } catch {
      return previous;
    }
  })();
  feedRequests.set(key, task);
  try { return await task; } finally { feedRequests.delete(key); }
}
const feedAttempts = new Map();
const feedPaused = new Set();

async function loadCatalog() {
  const csv = await fetchElements(activeUrl, 'active-gp');
  if (csv) {
    catalog = parseCatalog(csv);
    activeCatalog = true;
  } else if (!catalog.size) {
    const iss = await fetchElements(issUrl, 'iss-gp');
    if (iss) catalog = parseCatalog(iss);
  }
  if (!catalog.has(selectedId)) selectedId = catalog.keys().next().value ?? '25544';
  if (catalog.size) {
    byId('feed').textContent = activeCatalog
      ? catalog.size.toLocaleString() + ' active satellites · CelesTrak'
      : 'Full catalog unavailable · ISS fallback';
  } else {
    byId('feed').textContent = 'Orbital data unavailable. Try again later.';
  }
  passCache.clear();
  lastMap = 0;
  showSearch();
  update();
}

function isFresh(satellite, now) {
  return satellite && Math.abs(now - satellite.epoch) <= staleAge;
}
function formatAngle(angle) {
  return (angle / radians).toFixed(1) + '°';
}
function selectSatellite(id) {
  selectedId = id;
  lastMap = 0;
  update();
}
function renderList(element, satellites) {
  const ids = satellites.map(sat => sat.id).join(',');
  if (ids === element.dataset.ids) return;
  element.dataset.ids = ids;
  element.replaceChildren(...satellites.map(sat => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = sat.name + ' · ' + sat.id;
    button.onclick = () => selectSatellite(sat.id);
    item.append(button);
    return item;
  }));
}
function showSearch() {
  const query = byId('search').value.trim().toUpperCase();
  const results = byId('results');
  const found = [];
  if (query) {
    const exact = catalog.get(query);
    if (exact) found.push(exact);
    for (const sat of catalog.values()) {
      if (found.length >= 8) break;
      if (sat !== exact && (sat.name.toUpperCase().includes(query) || sat.id.includes(query))) found.push(sat);
    }
  }
  renderList(results, found);
  byId('search-status').textContent = query && !found.length ? 'No matching satellites.' : '';
}
byId('search').addEventListener('input', showSearch);

function update() {
  if (document.hidden) return;
  const now = Date.now();
  const satellite = catalog.get(selectedId);
  const fresh = isFresh(satellite, now);
  const clock = skyClock(now);
  const look = fresh && observer ? lookAt(satellite.record, observer, now, clock) : null;
  byId('pass-title').textContent = satellite ? satellite.name + ' · NORAD ' + satellite.id : 'Satellite details';
  if (now - lastMap >= 1000) {
    lastMap = now;
    const point = mapMode ? drawMap(fresh ? satellite : null, observer, now) : fresh && groundAt(satellite.record, now);
    byId('position').textContent = point
      ? 'Current position · ' + formatAngle(point.latitude) + ', ' + formatAngle(point.longitude) +
        ' · ' + Math.round(point.height).toLocaleString() + ' km altitude · ' + timeLabel.format(now)
      : satellite ? 'Orbital elements are too old for current tracking.' : '';
  }
  byId('direction').textContent = look
    ? 'Bearing ' + Math.round(look.azimuth / radians) % 360 + '° true · Elevation ' + formatAngle(look.elevation) +
      ' · ' + Math.round(look.rangeSat).toLocaleString() + ' km away' : '';
  byId('visibility').textContent = !look ? '' : look.elevation < 0
    ? 'Below your horizon now'
    : look.sunlit && skyIsDark(observer, clock)
      ? 'Sunlit under a dark sky · brightness varies'
      : 'Above the horizon · daylight or Earth shadow can hide it';
  let result = fresh && observer ? passCache.get(selectedId) : null;
  if (fresh && observer && (!result || now >= result.until)) {
    const pass = findPass(satellite.record, observer, now);
    result = { pass, until: pass?.set ?? now + 600_000 };
    passCache.set(selectedId, result);
  }
  const pass = result?.pass;
  byId('pass').hidden = !pass;
  if (observer) {
    byId('observer').textContent = fresh
      ? pass ? 'Predicted local pass above 10°' : 'No completed pass above 10° found in the next 72 hours.'
      : 'Fresh orbital elements are needed for local predictions.';
  }
  if (pass) {
    byId('rise').textContent = now >= pass.rise ? 'In progress' : timeLabel.format(pass.rise);
    byId('peak').textContent = timeLabel.format(pass.peak) + ' · ' + formatAngle(pass.max);
    byId('set').textContent = timeLabel.format(pass.set);
  }
  if (!mapMode) drawCamera(now, clock, satellite, look);
}

function drawCamera(now, clock, satellite, selectedLook) {
  const marker = byId('marker');
  const guidance = byId('guidance');
  marker.hidden = true;
  if (!stream || !observer || !pose || performance.now() - pose.received > 2500) {
    guidance.textContent = !stream
      ? arError || 'Start the camera and hold a moving light in the reticle.'
      : !observer ? 'Use your location to identify satellites.' : 'Compass unavailable. Try the 2D View.';
    samples = [];
    matches = [];
    renderList(byId('candidates'), []);
    return;
  }
  const width = view.clientWidth;
  const height = view.clientHeight;
  const rotation = (screen.orientation?.angle ?? window.orientation ?? 0) * radians;
  const radius = Math.min(width, height) * .15;
  const light = centerLight(video, view, radius);
  samples = samples.filter(sample => now - sample.time <= 3500);
  if (light) samples.push({ time: now, light, pose, width, height, rotation });
  if (now - lastScan >= 900) {
    lastScan = now;
    matches = rankMatches(now, clock, width, height, rotation, radius);
    renderList(byId('candidates'), matches.slice(0, 3).map(match => match.satellite));
  }
  const [best, second] = matches;
  const confident = light && best?.samples >= 5 && best.score < radius * .5 &&
    (!second || second.score - best.score > radius * .2);
  guidance.textContent = confident ? 'Likely match · ' + best.satellite.name
    : best ? 'Possible matches · hold the light steady in the reticle'
    : light ? 'No confident satellite match' : 'Center a moving light in the reticle';
  const tracked = confident ? best.satellite : satellite;
  const look = confident ? lookAt(tracked.record, observer, now, clock) : selectedLook;
  if (!look || look.elevation < 0) return;
  const point = project(look, pose, width, height, rotation);
  if (!point.visible) return;
  marker.style.left = point.x + 'px';
  marker.style.top = point.y + 'px';
  marker.textContent = tracked.name;
  marker.hidden = false;
}

function rankMatches(now, clock, width, height, rotation, radius) {
  const recent = samples.slice(-8);
  const target = recent.at(-1)?.light ?? { x: width / 2, y: height / 2 };
  const dark = skyIsDark(observer, clock);
  const nearby = [];
  for (const satellite of catalog.values()) {
    if (!isFresh(satellite, now)) continue;
    const look = lookAt(satellite.record, observer, now, clock);
    if (!look || look.elevation < 0) continue;
    const projected = project(look, pose, width, height, rotation);
    if (!projected.visible) continue;
    const distance = Math.hypot(projected.x - target.x, projected.y - target.y);
    if (distance <= radius) nearby.push({ satellite, score: distance, lit: look.sunlit && dark, samples: 0 });
  }
  nearby.sort((a, b) => a.score - b.score);
  const sampleClocks = recent.map(sample => skyClock(sample.time));
  for (const candidate of nearby.slice(0, 16)) {
    if (!recent.length) break;
    let sum = 0;
    for (const [index, sample] of recent.entries()) {
      const look = lookAt(candidate.satellite.record, observer, sample.time, sampleClocks[index]);
      const point = look && project(look, sample.pose, sample.width, sample.height, sample.rotation);
      sum += point?.visible ? Math.hypot(point.x - sample.light.x, point.y - sample.light.y) : radius * 2;
    }
    candidate.samples = recent.length;
    candidate.score = sum / recent.length + (candidate.lit ? 0 : radius * .3);
  }
  return nearby.slice(0, 16).sort((a, b) => a.score - b.score).slice(0, 3);
}

function receivePose(event) {
  if ((event.absolute || event.type === 'deviceorientationabsolute') &&
      [event.alpha, event.beta, event.gamma].every(Number.isFinite)) {
    pose = { alpha: event.alpha * radians, beta: event.beta * radians, gamma: event.gamma * radians, received: performance.now() };
  }
}
byId('location').onclick = () => {
  if (!navigator.geolocation) {
    byId('observer').textContent = 'Location requires a supported browser over HTTPS.';
    return;
  }
  byId('observer').textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    observer = { latitude: coords.latitude * radians, longitude: coords.longitude * radians, height: (coords.altitude ?? 0) / 1000 };
    passCache.clear();
    lastMap = 0;
    update();
  }, () => {
    byId('observer').textContent = 'Location unavailable. Check browser permissions and try again.';
  }, { timeout: 12000 });
};
function stopCamera() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  byId('camera').textContent = 'Start camera';
}
function route() {
  mapMode = window.location.hash === '#map';
  byId('map').hidden = !mapMode;
  byId('ar').hidden = mapMode;
  byId('ar-link').setAttribute('aria-current', mapMode ? 'false' : 'page');
  byId('map-link').setAttribute('aria-current', mapMode ? 'page' : 'false');
  if (mapMode) stopCamera();
  lastMap = 0;
  update();
}
byId('camera').onclick = async () => {
  if (stream) { stopCamera(); update(); return; }
  const button = byId('camera');
  button.disabled = true;
  arError = '';
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
    }
    const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (document.hidden || mapMode) { camera.getTracks().forEach(track => track.stop()); return; }
    stream = camera;
    video.srcObject = stream;
    await video.play();
    button.textContent = 'Stop camera';
  } catch {
    stopCamera();
    arError = 'Camera unavailable. Check browser permissions and HTTPS.';
  } finally {
    button.disabled = false;
    update();
  }
};
window.addEventListener('hashchange', route);
window.addEventListener('deviceorientationabsolute', receivePose);
window.addEventListener('deviceorientation', receivePose);
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else update();
});
setInterval(update, 250);
setInterval(() => {
  if (!document.hidden && Date.now() - Math.max(Number(read('active-gp-attempt')), feedAttempts.get('active-gp') ?? 0) >= twoHours &&
      !read('active-gp-paused') && !feedPaused.has('active-gp')) void loadCatalog();
}, 60_000);
route();
void loadLand().then(() => { lastMap = 0; update(); }).catch(() => { byId('map-status').textContent = 'Basemap unavailable.'; });
void loadCatalog();

