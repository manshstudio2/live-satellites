import { ecfToLookAngles, eciToEcf, eciToGeodetic, gstime, jday, json2satrec, propagate, sunPos } from 'satellite.js';

export const radians = Math.PI / 180;
const minute = 60_000;
const minimumElevation = 10 * radians;
export function parseCatalog(csv) {
  const rows = csv.trim().replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = rows.shift().split(',');
  const required = ['BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'ECCENTRICITY', 'ARG_OF_PERICENTER', 'INCLINATION', 'MEAN_ANOMALY', 'MEAN_MOTION', 'RA_OF_ASC_NODE'];
  const catalog = new Map();
  for (const row of rows) {
    const values = Array.from(row.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g),
      match => match[1] === undefined ? match[2] : match[1].replace(/""/g, '"'));
    const fields = Object.fromEntries(header.map((key, index) => [key, values[index]]));
    const id = fields.NORAD_CAT_ID;
    const epoch = Date.parse(fields.EPOCH?.endsWith('Z') ? fields.EPOCH : fields.EPOCH + 'Z');
    if (!/^\d{1,9}$/.test(id) || !Number.isFinite(epoch) ||
        required.some(key => !fields[key]?.trim() || !Number.isFinite(Number(fields[key])))) continue;
    const record = json2satrec(fields);
    if (!record.error && epoch > (catalog.get(id)?.epoch ?? -Infinity)) {
      catalog.set(id, { id, name: fields.OBJECT_NAME || 'Satellite ' + id, record, epoch });
    }
  }
  if (!catalog.size) throw new Error('No valid orbital elements');
  return catalog;
}
export function groundAt(record, time) {
  const date = new Date(time);
  const result = propagate(record, date);
  if (!result?.position) return null;
  const point = eciToGeodetic(result.position, gstime(date));
  const velocity = result.velocity;
  return { ...point, speed: velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : null };
}
export function skyClock(time) {
  const date = new Date(time);
  const sidereal = gstime(date);
  const sun = sunPos(jday(date)).rsun;
  const scale = 149597870.7;
  const sunEci = { x: sun[0] * scale, y: sun[1] * scale, z: sun[2] * scale };
  return { date, sidereal, sunEci, sunEcf: eciToEcf(sunEci, sidereal) };
}
export function lookAt(record, observer, time, clock = skyClock(time)) {
  const position = propagate(record, clock.date)?.position;
  if (!position) return null;
  const look = ecfToLookAngles(observer, eciToEcf(position, clock.sidereal));
  if (!Number.isFinite(look.elevation) || !Number.isFinite(look.azimuth)) return null;
  const sun = clock.sunEci;
  const along = (position.x * sun.x + position.y * sun.y + position.z * sun.z) / Math.hypot(sun.x, sun.y, sun.z);
  const sunlit = along >= 0 || Math.sqrt(Math.max(0, position.x**2 + position.y**2 + position.z**2 - along**2)) > 6378.137;
  return { ...look, sunlit };
}
export function skyIsDark(observer, clock) {
  return ecfToLookAngles(observer, clock.sunEcf).elevation < -6 * radians;
}

export function findPass(record, observer, now) {
  const elevationAt = time => {
    const date = new Date(time);
    const position = propagate(record, date)?.position;
    return position ? ecfToLookAngles(observer, eciToEcf(position, gstime(date))).elevation : -Infinity;
  };
  function crossing(start, end, rising) {
    while (end - start > 1000) {
      const mid = (start + end) / 2;
      if ((elevationAt(mid) >= minimumElevation) === rising) end = mid;
      else start = mid;
    }
    return end;
  }
  let rise = elevationAt(now) >= minimumElevation ? now : null;
  let peak = now;
  let max = rise === null ? -Infinity : elevationAt(now);
  const inProgress = rise !== null;
  for (let time = now + minute / 2; time <= now + 72 * 60 * minute; time += minute / 2) {
    const elevation = elevationAt(time);
    if (rise === null && elevation >= minimumElevation) {
      rise = crossing(time - minute / 2, time, true);
    }
    if (rise === null) continue;
    if (elevation > max) {
      max = elevation;
      peak = time;
    }
    if (elevation < minimumElevation) {
      const set = crossing(time - minute / 2, time, false);
      let left = Math.max(rise, peak - minute / 2);
      let right = Math.min(set, peak + minute / 2);
      while (right - left > 1000) {
        const a = (2 * left + right) / 3;
        const b = (left + 2 * right) / 3;
        if (elevationAt(a) < elevationAt(b)) left = a;
        else right = b;
      }
      peak = (left + right) / 2;
      return { rise, peak, set, max: elevationAt(peak), inProgress };
    }
  }
  return null;
}
