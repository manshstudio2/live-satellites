import { radians } from './orbit.js';

export function project(look, pose, width, height, screenAngle) {
  const east = Math.sin(look.azimuth) * Math.cos(look.elevation);
  const north = Math.cos(look.azimuth) * Math.cos(look.elevation);
  const up = Math.sin(look.elevation);
  let x, y, forward;
  if (pose.basis) {
    const m = pose.basis;
    x = m[0] * east + m[1] * north + m[2] * up;
    y = m[3] * east + m[4] * north + m[5] * up;
    forward = -(m[6] * east + m[7] * north + m[8] * up);
  } else {
    const { alpha, beta, gamma } = pose;
    // Invert the device's intrinsic Z-X'-Y'' rotation.
    const east1 = Math.cos(alpha) * east + Math.sin(alpha) * north;
    const north1 = -Math.sin(alpha) * east + Math.cos(alpha) * north;
    y = Math.cos(beta) * north1 + Math.sin(beta) * up;
    const up1 = -Math.sin(beta) * north1 + Math.cos(beta) * up;
    x = Math.cos(gamma) * east1 - Math.sin(gamma) * up1;
    forward = -(Math.sin(gamma) * east1 + Math.cos(gamma) * up1);
  }
  const screenX = Math.cos(screenAngle) * x - Math.sin(screenAngle) * y;
  const screenY = Math.sin(screenAngle) * x + Math.cos(screenAngle) * y;

  // Rear camera faces along device -Z. Browser camera intrinsics are unavailable.
  const focal = Math.min(width, height) / (2 * Math.tan(25 * radians));
  const offsetX = focal * screenX / Math.max(forward, 0.01);
  const offsetY = -focal * screenY / Math.max(forward, 0.01);
  return {
    x: width / 2 + offsetX,
    y: height / 2 + offsetY,
    visible: forward > 0 && Math.abs(offsetX) <= width / 2 && Math.abs(offsetY) <= height / 2,
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
  const topProjection = Math.cos(beta * radians);
  // When the top of the phone tilts past vertical its projected heading reverses.
  // Near vertical the projection is unstable, so retain the previous calibration.
  if (Number.isFinite(heading) && heading >= 0 && !(Number.isFinite(accuracy) && accuracy < 0) &&
      Math.abs(topProjection) > .25 && (offset === undefined || Math.abs(beta) < 35)) {
    const topHeading = heading + (topProjection < 0 ? 180 : 0);
    offset = (-topHeading - alpha) * radians;
  }
  if (offset === undefined) return null;
  return { alpha: alpha * radians + offset, beta: beta * radians, gamma: gamma * radians, offset };
}

export function quaternionPose(quaternion) {
  if (!quaternion || quaternion.length !== 4 || !Array.from(quaternion).every(Number.isFinite)) return null;
  const length = Math.hypot(...quaternion);
  if (!length) return null;
  const [a, b, c, d] = Array.from(quaternion, component => component / length);
  // Columns give device axes in the Earth's east, north and up frame.
  return { basis: [
    1 - 2 * (b*b + c*c), 2 * (a*b + c*d), 2 * (a*c - b*d),
    2 * (a*b - c*d), 1 - 2 * (a*a + c*c), 2 * (b*c + a*d),
    2 * (a*c + b*d), 2 * (b*c - a*d), 1 - 2 * (a*a + b*b),
  ] };
}

export function manualAngles(bearing, elevation) {
  return { alpha: -bearing * radians, beta: (90 + elevation) * radians, gamma: 0 };
}
