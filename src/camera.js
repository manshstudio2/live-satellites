import { radians } from './orbit.js';

export function project(look, pose, width, height, screenAngle) {
  const { alpha, beta, gamma } = pose;
  const east = Math.sin(look.azimuth) * Math.cos(look.elevation);
  const north = Math.cos(look.azimuth) * Math.cos(look.elevation);
  const up = Math.sin(look.elevation);
  // Invert the device's intrinsic Z-X'-Y'' rotation from the earth frame.
  const east1 = Math.cos(alpha) * east + Math.sin(alpha) * north;
  const north1 = -Math.sin(alpha) * east + Math.cos(alpha) * north;
  const y = Math.cos(beta) * north1 + Math.sin(beta) * up;
  const up1 = -Math.sin(beta) * north1 + Math.cos(beta) * up;
  const x = Math.cos(gamma) * east1 - Math.sin(gamma) * up1;
  const forward = -(Math.sin(gamma) * east1 + Math.cos(gamma) * up1);
  const screenX = Math.cos(screenAngle) * x - Math.sin(screenAngle) * y;
  const screenY = Math.sin(screenAngle) * x + Math.cos(screenAngle) * y;

  // Rear camera faces along device -Z. Browser camera intrinsics are unavailable.
  const focal = Math.min(width, height) / (2 * Math.tan(25 * radians));
  const offsetX = focal * screenX / Math.max(forward, 0.01);
  const offsetY = -focal * screenY / Math.max(forward, 0.01);
  const edgeScale = Math.max(1, Math.abs(offsetX) / Math.max(1, width / 2 - 40),
                                 Math.abs(offsetY) / Math.max(1, height / 2 - 35));
  return {
    x: width / 2 + offsetX / edgeScale,
    y: height / 2 + offsetY / edgeScale,
    visible: forward > 0 && edgeScale === 1,
    behind: forward <= 0,
    angle: Math.atan2(offsetY, offsetX) / radians,
  };
}

// Safari provides compass heading alongside orientation in a relative frame.
export function orientationAngles(event, offset) {
  const { alpha, beta, gamma, webkitCompassHeading: heading, webkitCompassAccuracy: accuracy } = event;
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;
  if (event.absolute || event.type === 'deviceorientationabsolute') {
    return { alpha: alpha * radians, beta: beta * radians, gamma: gamma * radians, offset };
  }
  if (Number.isFinite(heading) && heading >= 0 && !(Number.isFinite(accuracy) && accuracy < 0) &&
      Math.abs(beta) < 35 && Math.abs(gamma) < 35) {
    offset = (-heading - alpha) * radians;
  }
  if (offset === undefined) return null;
  return { alpha: alpha * radians + offset, beta: beta * radians, gamma: gamma * radians, offset };
}

export function manualAngles(bearing, elevation) {
  return { alpha: -bearing * radians, beta: (90 + elevation) * radians, gamma: 0 };
}
