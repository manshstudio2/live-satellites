import './style.css';
import { findPass, groundAt, lookAt, parseCatalog, radians, skyClock, skyIsDark } from './orbit.js';
import { project } from './camera.js';
import { updateGlobe, loadLand } from './globe.js';
import { centerLight } from './light.js';

const byId = id => document.getElementById(id);
const video = document.querySelector('video');
const view = document.querySelector('.view');
const activeUrl = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV';
const twoHours = 7_200_000;
const staleAge = 3 * 86_400_000;
const timeLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const passCache = new Map();
let catalog = new Map();
let selectedId;
let observer, pose, stream, arError, lastPosition = 0;
let earthMode = false;
let samples = [];
let matches = [];
let lastScan = 0;
let lastLightSample = 0;
let skyTargets = [];

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
    catalog.delete('25544');
  }
  if (!catalog.has(selectedId)) selectedId = undefined;
  byId('feed').textContent = catalog.size
    ? catalog.size.toLocaleString() + ' active satellites · CelesTrak'
    : 'The active satellite catalog is unavailable. Live positions will appear when orbital data loads.';
  passCache.clear();
  lastPosition = 0;
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
  lastPosition = 0;
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
    button.textContent = sat.name;
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
    for (const sat of catalog.values()) {
      if (found.length >= 8) break;
      if (sat.name.toUpperCase().includes(query)) found.push(sat);
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
  byId('satellite-details').hidden = !satellite;
  const fresh = isFresh(satellite, now);
  const clock = skyClock(now);
  const look = fresh && observer ? lookAt(satellite.record, observer, now, clock) : null;
  byId('pass-title').textContent = satellite ? satellite.name : 'Satellite details';
  if (now - lastPosition >= 1000) {
    lastPosition = now;
    if (earthMode) {
      const targets = observer ? satellitesAbove(now, clock) : [];
      updateGlobe(observer, targets, now, selectedId, selectSatellite);
      byId('earth-status').textContent = observer
        ? catalog.size ? targets.length + ' predicted above your horizon' : 'Waiting for orbital data'
        : 'Use your location to see satellites above you.';
    }
    const point = fresh && groundAt(satellite.record, now);
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
  if (observer && !satellite) byId('observer').textContent = 'Location ready';
  if (observer && satellite) {
    byId('observer').textContent = fresh
      ? pass ? 'Predicted local pass above 10°' : 'No completed pass above 10° found in the next 72 hours.'
      : 'Fresh orbital elements are needed for local predictions.';
  }
  if (pass) {
    byId('rise').textContent = now >= pass.rise ? 'In progress' : timeLabel.format(pass.rise);
    byId('peak').textContent = timeLabel.format(pass.peak) + ' · ' + formatAngle(pass.max);
    byId('set').textContent = timeLabel.format(pass.set);
  }
  if (!earthMode) drawCamera(now, clock);
}

function satellitesAbove(now, clock) {
  const dark = skyIsDark(observer, clock);
  const targets = [];
  for (const satellite of catalog.values()) {
    if (!isFresh(satellite, now)) continue;
    const look = lookAt(satellite.record, observer, now, clock);
    if (look?.elevation >= 0) targets.push({ satellite, look, lit: dark && look.sunlit });
  }
  return targets;
}

function drawCamera(now, clock) {
  const overlay = byId('satellite-overlay');
  const guidance = byId('guidance');
  const matchLabel = byId('matching');
  if (!stream || !observer || !pose || performance.now() - pose.received > 2500) {
    guidance.textContent = !stream ? arError || 'Start the camera and point it at the sky.'
      : !observer ? 'Allow location to see satellites in your camera view.'
        : 'Compass unavailable. Try 3D Earth.';
    matchLabel.textContent = '';
    byId('sky-summary').textContent = '';
    samples = [];
    matches = [];
    skyTargets = [];
    lastScan = 0;
    overlay.replaceChildren();
    renderList(byId('candidates'), []);
    return;
  }
  const width = view.clientWidth;
  const height = view.clientHeight;
  const rotation = (screen.orientation?.angle ?? window.orientation ?? 0) * radians;
  const radius = Math.min(width, height) * .15;
  const scan = now - lastScan >= 850;
  let light;
  if (now - lastLightSample >= 240) {
    lastLightSample = now;
    light = centerLight(video, view, radius);
    samples = samples.filter(sample => now - sample.time <= 3500);
    if (light) samples.push({ time: now, light, pose, width, height, rotation });
  }
  if (scan) {
    lastScan = now;
    skyTargets = satellitesAbove(now, clock);
  }
  const inFrame = [];
  for (const target of skyTargets) {
    const point = project(target.look, pose, width, height, rotation);
    if (!point.visible) continue;
    inFrame.push({ ...target, point, center: Math.hypot(point.x - width / 2, point.y - height / 2) });
  }
  inFrame.sort((a, b) => a.center - b.center);
  if (scan) matches = rankMatches(inFrame, radius);
  const [best, second] = matches;
  const latest = samples.at(-1);
  const likely = best && latest && now - latest.time < 550 && best.samples >= 6 && best.lit &&
    best.score < radius * .5 && (!second || second.score - best.score > radius * .2) &&
    inFrame.some(target => target.satellite.id === best.satellite.id);
  const featured = likely ? best.satellite.id : null;
  if (featured && selectedId !== featured) {
    selectedId = featured;
    lastPosition = 0;
  }
  paintTargets(overlay, inFrame, featured);
  const count = inFrame.length;
  byId('sky-summary').textContent = skyTargets.length + ' above your horizon · ' + count + ' in view';
  guidance.textContent = count ? count + (count === 1 ? ' predicted satellite in view' : ' predicted satellites in view')
    : catalog.size ? 'No predicted satellites in this direction' : 'Waiting for orbital data';
  matchLabel.textContent = likely ? 'Likely match · ' + best.satellite.name
    : latest && now - latest.time < 550
      ? best ? 'Possible matches · keep the light centered' : 'No confident satellite match'
      : 'Center a moving light to identify it';
  renderList(byId('candidates'), matches.map(match => match.satellite));
}

function paintTargets(overlay, targets, featured) {
  const shown = targets.slice(0, 24);
  const match = targets.find(target => target.satellite.id === featured);
  if (match && !shown.includes(match)) shown.unshift(match);
  const positions = new Map(shown.map((target, index) => [target.satellite.id, { target, index }]));
  for (const marker of overlay.children) {
    if (!positions.has(marker.dataset.id)) marker.hidden = true;
  }
  const existing = new Map(Array.from(overlay.children, marker => [marker.dataset.id, marker]));
  for (const [id, { target, index }] of positions) {
    let marker = existing.get(id);
    if (!marker) {
      marker = document.createElement('button');
      marker.type = 'button';
      marker.dataset.id = id;
      marker.className = 'sky-target';
      marker.addEventListener('click', () => selectSatellite(id));
      overlay.append(marker);
    }
    marker.hidden = false;
    marker.style.left = target.point.x + 'px';
    marker.style.top = target.point.y + 'px';
    marker.classList.toggle('likely', id === featured);
    marker.classList.toggle('illuminated', target.lit);
    marker.setAttribute('aria-label', target.satellite.name + (id === featured ? ', likely match' : ', predicted position'));
    marker.textContent = index < 5 || id === featured ? target.satellite.name : '•';
  }
  for (const marker of Array.from(overlay.children)) {
    if (marker.hidden && document.activeElement !== marker) marker.remove();
  }
}

function rankMatches(inFrame, radius) {
  const recent = samples.slice(-10);
  if (!recent.length) return [];
  const target = recent.at(-1).light;
  const nearby = inFrame
    .map(candidate => ({ ...candidate, score: Math.hypot(candidate.point.x - target.x, candidate.point.y - target.y) }))
    .filter(candidate => candidate.score <= radius)
    .sort((a, b) => a.score - b.score).slice(0, 16);
  const clocks = recent.map(sample => skyClock(sample.time));
  for (const candidate of nearby) {
    let sum = 0;
    for (const [index, sample] of recent.entries()) {
      const look = lookAt(candidate.satellite.record, observer, sample.time, clocks[index]);
      const point = look && project(look, sample.pose, sample.width, sample.height, sample.rotation);
      sum += point?.visible ? Math.hypot(point.x - sample.light.x, point.y - sample.light.y) : radius * 2;
    }
    candidate.samples = recent.length;
    candidate.score = sum / recent.length + (candidate.lit ? 0 : radius * .3);
  }
  return nearby.sort((a, b) => a.score - b.score).slice(0, 3);
}

function receivePose(event) {
  if ((event.absolute || event.type === 'deviceorientationabsolute') &&
      [event.alpha, event.beta, event.gamma].every(Number.isFinite)) {
    pose = { alpha: event.alpha * radians, beta: event.beta * radians, gamma: event.gamma * radians, received: performance.now() };
  }
}
function requestLocation() {
  if (!navigator.geolocation) {
    byId('observer').textContent = 'Location requires a supported browser over HTTPS.';
    return;
  }
  byId('observer').textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    observer = { latitude: coords.latitude * radians, longitude: coords.longitude * radians, height: (coords.altitude ?? 0) / 1000 };
    passCache.clear();
    lastPosition = 0;
    update();
  }, () => {
    byId('observer').textContent = 'Location unavailable. Check browser permissions and try again.';
  }, { timeout: 12000 });
}
byId('location').onclick = requestLocation;
function stopCamera() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  byId('camera').textContent = 'Start camera';
}
function route() {
  earthMode = ['#earth', '#map'].includes(window.location.hash);
  if (window.location.hash === '#map') history.replaceState(null, '', '#earth');
  byId('earth').hidden = !earthMode;
  byId('ar').hidden = earthMode;
  byId('satellite-search').hidden = !earthMode;
  byId('ar-link').setAttribute('aria-current', earthMode ? 'false' : 'page');
  byId('earth-link').setAttribute('aria-current', earthMode ? 'page' : 'false');
  if (earthMode) stopCamera();
  lastPosition = 0;
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
    if (document.hidden || earthMode) { camera.getTracks().forEach(track => track.stop()); return; }
    stream = camera;
    video.srcObject = stream;
    await video.play();
    button.textContent = 'Stop camera';
    if (!observer) requestLocation();
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
setInterval(update, 120);
setInterval(() => {
  if (!document.hidden && Date.now() - Math.max(Number(read('active-gp-attempt')), feedAttempts.get('active-gp') ?? 0) >= twoHours &&
      !read('active-gp-paused') && !feedPaused.has('active-gp')) void loadCatalog();
}, 60_000);
route();
void loadLand().then(() => { lastPosition = 0; update(); }).catch(() => { byId('earth-map-error').textContent = 'Earth texture unavailable.'; });
void loadCatalog();
