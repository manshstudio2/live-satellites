import './style.css';
import { findPass, groundAt, lookAt, parseCatalog, radians, skyClock, skyIsDark } from './orbit.js';
import { project, orientationAngles, manualAngles } from './camera.js';
import { updateGlobe, loadEarthTextures } from './globe.js';
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
let motionRequested = false;
let compassOffset;
let motionMessage = '';
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
const feedKey = 'active-gp';
let catalogStatus = 'Loading CelesTrak catalog…';
let catalogRequest;
let lastFeedAttempt = 0;

function setCatalogStatus(message) {
  catalogStatus = message;
  byId('feed').textContent = message;
}
function useCatalog(csv, cached) {
  const next = parseCatalog(csv);
  next.delete('25544');
  const now = Date.now();
  for (const [id, satellite] of next) {
    if (!isFresh(satellite, now)) next.delete(id);
  }
  if (!next.size) return false;
  catalog = next;
  if (!catalog.has(selectedId)) selectedId = undefined;
  passCache.clear();
  lastPosition = lastScan = 0;
  setCatalogStatus(catalog.size.toLocaleString() + ' active satellites · ' + (cached ? 'saved CelesTrak data' : 'CelesTrak'));
  showSearch();
  update();
  return true;
}
function loadCatalog() {
  if (!catalogRequest) catalogRequest = refreshCatalog().finally(() => { catalogRequest = null; });
  return catalogRequest;
}
async function refreshCatalog() {
  const storage = await window.caches?.open('live-satellites-orbits-v1').catch(() => null);
  if (!catalog.size) {
    const cached = await storage?.match(activeUrl).catch(() => null);
    if (cached) {
      try { useCatalog(await cached.text(), true); } catch { /* A malformed cache can be replaced. */ }
    }
  }
  const paused = read(feedKey + '-paused');
  if (paused) {
    if (!catalog.size) setCatalogStatus('CelesTrak rejected the catalog request. Refresh is paused.');
    return;
  }
  const lastAttempt = Math.max(Number(read(feedKey + '-attempt')), lastFeedAttempt);
  if (Date.now() - lastAttempt < twoHours) {
    if (!catalog.size) setCatalogStatus('No saved orbital data. The next download is eligible after ' + timeLabel.format(lastAttempt + twoHours) + '.');
    return;
  }
  lastFeedAttempt = Date.now();
  write(feedKey + '-attempt', String(lastFeedAttempt));
  if (!catalog.size) setCatalogStatus('Downloading the full CelesTrak catalog…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const slow = setTimeout(() => {
    if (!catalog.size) setCatalogStatus('The CelesTrak download is slow. Still downloading…');
  }, 8000);
  try {
    const response = await fetch(activeUrl, { signal: controller.signal });
    if (!response.ok) {
      write(feedKey + '-paused', String(response.status));
      setCatalogStatus((catalog.size ? 'Using saved orbital data. ' : '') +
        'CelesTrak returned HTTP ' + response.status + '. Refresh is paused.');
      return;
    }
    const copy = response.clone();
    if (!useCatalog(await response.text(), false)) throw new Error('No current orbital data');
    await storage?.put(activeUrl, copy).catch(() => {});
  } catch (error) {
    setCatalogStatus((catalog.size ? 'Using saved orbital data. ' : '') +
      (controller.signal.aborted ? 'The CelesTrak download timed out.' : 'Could not load current orbital data.'));
  } finally {
    clearTimeout(slow);
    clearTimeout(timeout);
  }
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
      updateGlobe(observer, targets, now, selectedId, selectSatellite, clock.sunEcf);
      byId('earth-status').textContent = observer
        ? catalog.size ? targets.length + ' predicted above your horizon' : catalogStatus
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
  const manual = byId('manual-aim').open;
  const bearing = Number(byId('aim-bearing').value);
  const elevation = Number(byId('aim-elevation').value);
  const cameraPose = manual ? manualAngles(bearing, elevation) : pose;
  byId('aim-values').textContent = bearing + '° true · ' + elevation + '° elevation';
  byId('motion-state').textContent = motionRequested || stream ? manual ? 'Manual aim' : pose ? 'Phone motion active' : motionMessage : '';
  const scan = now - lastScan >= 850;
  if (scan && observer) {
    lastScan = now;
    skyTargets = satellitesAbove(now, clock);
    const next = [...skyTargets].sort((a, b) => b.look.elevation - a.look.elevation);
    renderList(byId('overhead-list'), next.slice(0, 6).map(target => target.satellite));
  }
  byId('overhead').hidden = !observer || !skyTargets.length;
  if (!stream || !observer || !cameraPose) {
    guidance.textContent = !stream ? arError || 'Start the camera and point it at the sky.'
      : !observer ? 'Allow location to see satellites in your camera view.'
        : 'Allow phone motion or use Manual aim.';
    matchLabel.textContent = '';
    byId('sky-summary').textContent = '';
    samples = [];
    matches = [];
    overlay.replaceChildren();
    renderList(byId('candidates'), []);
    return;
  }
  const width = view.clientWidth;
  const height = view.clientHeight;
  const rotation = (screen.orientation?.angle ?? window.orientation ?? 0) * radians;
  const radius = Math.min(width, height) * .15;
  let light;
  if (!manual && now - lastLightSample >= 240) {
    lastLightSample = now;
    light = centerLight(video, view, radius);
    samples = samples.filter(sample => now - sample.time <= 3500);
    if (light) samples.push({ time: now, light, pose: cameraPose, width, height, rotation });
  }
  const inFrame = [];
  for (const target of skyTargets) {
    const point = project(target.look, cameraPose, width, height, rotation);
    if (!point.visible) continue;
    inFrame.push({ ...target, point, center: Math.hypot(point.x - width / 2, point.y - height / 2) });
  }
  inFrame.sort((a, b) => a.center - b.center);
  if (scan) matches = rankMatches(inFrame, radius);
  const [best, second] = matches;
  const latest = samples[samples.length - 1];
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
    : catalog.size ? 'No predicted satellites in this direction' : catalogStatus;
  matchLabel.textContent = manual ? 'Align bearing and elevation with where the camera is pointed.' : likely ? 'Likely match · ' + best.satellite.name
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
  const target = recent[recent.length - 1].light;
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
  if (!stream && !motionRequested) return;
  const angles = orientationAngles(event, compassOffset);
  if (!angles) return;
  compassOffset = angles.offset;
  pose = angles;
}

async function enableMotion() {
  motionRequested = true;
  pose = undefined;
  compassOffset = undefined;
  motionMessage = 'Move your phone slowly so the compass can align.';
  try {
    if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      const permission = await window.DeviceOrientationEvent.requestPermission(true);
      if (permission !== 'granted') motionMessage = 'Motion permission denied. Allow it in browser settings or use Manual aim.';
    }
  } catch {
    motionMessage = 'Motion access is unavailable. Open this link directly in Safari or Chrome, or use Manual aim.';
  }
  if (!pose && motionMessage.startsWith('Move')) {
    motionMessage = 'Tilt the phone a little forward or back to get a compass reading. If motion is blocked, use Manual aim.';
  }
  update();
}
byId('enable-motion').onclick = () => {
  byId('manual-aim').open = false;
  void enableMotion();
};
byId('manual-aim').addEventListener('toggle', () => {
  samples = [];
  matches = [];
  lastScan = 0;
  update();
});

function requestLocation() {
  if (!navigator.geolocation) {
    byId('observer').textContent = 'Location requires a supported browser over HTTPS.';
    return;
  }
  byId('observer').textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    observer = { latitude: coords.latitude * radians, longitude: coords.longitude * radians, height: (coords.altitude ?? 0) / 1000 };
    passCache.clear();
    lastPosition = lastScan = 0;
    update();
  }, () => {
    byId('observer').textContent = 'Location unavailable. Check browser permissions and try again.';
  }, { timeout: 12000 });
}
byId('location').onclick = requestLocation;
function stopCamera() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  pose = undefined;
  compassOffset = undefined;
  motionRequested = false;
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
    if (!motionRequested && !byId('manual-aim').open) await enableMotion();
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
  if (!document.hidden && Date.now() - Math.max(Number(read(feedKey + '-attempt')), lastFeedAttempt) >= twoHours && !read(feedKey + '-paused')) void loadCatalog();
}, 60_000);
route();
void loadEarthTextures().then(() => { lastPosition = 0; update(); }).catch(() => { byId('earth-map-error').textContent = 'Earth texture unavailable.'; });
void loadCatalog();
