// Geometry helpers. Points are [lat, lng] arrays unless a name says LngLat.
// Pure functions only: no DOM, no shared state.

const EARTH_RADIUS_METERS = 6371000;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two [lat, lng] points. */
export function haversineMeters([lat1, lng1], [lat2, lng2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function midpoint([lat1, lng1], [lat2, lng2]) {
  return [(lat1 + lat2) / 2, (lng1 + lng2) / 2];
}

/** Converts a [lat, lng] pair or a {lng, lat} object to MapLibre's [lng, lat]. */
export function toLngLat(point) {
  if (Array.isArray(point) && point.length >= 2) return [point[1], point[0]];
  if (point && Number.isFinite(point.lng) && Number.isFinite(point.lat))
    return [point.lng, point.lat];
  return null;
}

/** Cumulative distance along a polyline. totalMeters is at least 1 to avoid division by zero. */
export function measureRoute(points) {
  const cumulativeMeters = [0];
  let totalMeters = 0;
  for (let i = 1; i < points.length; i += 1) {
    totalMeters += haversineMeters(points[i - 1], points[i]);
    cumulativeMeters.push(totalMeters);
  }
  return { cumulativeMeters, totalMeters: Math.max(totalMeters, 1) };
}

/**
 * Interpolated point at a distance along a measured corridor
 * ({ points, cumulativeMeters }). Distances past the end return the last point.
 */
export function getPointAtDistance(corridor, distanceMeters) {
  const { points, cumulativeMeters } = corridor;
  if (points.length === 1) return points[0];

  // First index i >= 1 with cumulativeMeters[i] >= distanceMeters (binary search).
  let low = 1;
  let high = cumulativeMeters.length - 1;
  if (cumulativeMeters[high] < distanceMeters) return points[points.length - 1];
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulativeMeters[mid] >= distanceMeters) high = mid;
    else low = mid + 1;
  }

  const previous = cumulativeMeters[low - 1];
  const next = cumulativeMeters[low];
  const t = (distanceMeters - previous) / Math.max(next - previous, 0.0001);
  return [lerp(points[low - 1][0], points[low][0], t), lerp(points[low - 1][1], points[low][1], t)];
}

function removeConsecutiveDuplicates(points) {
  return points.filter(
    (point, index, list) =>
      index === 0 || point[0] !== list[index - 1][0] || point[1] !== list[index - 1][1],
  );
}

function corridorLength(corridor) {
  return (
    corridor.totalMeters || corridor.cumulativeMeters[corridor.cumulativeMeters.length - 1] || 0
  );
}

/** Polyline between two distances along a corridor, with interpolated end points. */
export function getCorridorSliceByMeters(
  corridor,
  startMeters = 0,
  endMeters = corridor?.totalMeters || 0,
) {
  if (!corridor?.points?.length || !corridor?.cumulativeMeters?.length) return [];

  const totalMeters = corridorLength(corridor);
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) return corridor.points.slice();

  const start = clamp(startMeters, 0, totalMeters);
  const end = clamp(Math.max(endMeters, start), 0, totalMeters);
  const sliced = [getPointAtDistance(corridor, start)];
  corridor.points.forEach((point, index) => {
    const distance = corridor.cumulativeMeters[index];
    if (distance > start && distance < end) sliced.push(point);
  });
  sliced.push(getPointAtDistance(corridor, end));
  return removeConsecutiveDuplicates(sliced);
}

/** Polyline between two ratios (0..1) of a corridor; the span is at least 2 % long. */
export function getCorridorSlice(corridor, startRatio = 0, endRatio = 1) {
  if (!corridor?.points?.length || !corridor?.cumulativeMeters?.length) return [];

  const totalMeters = corridorLength(corridor);
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) return corridor.points.slice();

  const start = clamp(startRatio, 0, 1) * totalMeters;
  const end = clamp(Math.max(endRatio, startRatio + 0.02), 0, 1) * totalMeters;
  return getCorridorSliceByMeters(corridor, start, end);
}

/**
 * Projects a point onto a corridor. Uses planar maths on degrees, which is
 * accurate enough at Austrian latitudes for picking the closest segment.
 */
export function findNearestPointOnCorridor(corridor, [lat, lng]) {
  let best = {
    distanceSq: Number.POSITIVE_INFINITY,
    offsetMeters: 0,
    point: corridor?.points?.[0] || [lat, lng],
  };

  for (let i = 1; i < corridor.points.length; i += 1) {
    const [lat1, lng1] = corridor.points[i - 1];
    const [lat2, lng2] = corridor.points[i];
    const dx = lng2 - lng1;
    const dy = lat2 - lat1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq <= 0 ? 0 : clamp(((lng - lng1) * dx + (lat - lat1) * dy) / lengthSq, 0, 1);
    const projLng = lng1 + dx * t;
    const projLat = lat1 + dy * t;
    const distanceSq = (projLng - lng) ** 2 + (projLat - lat) ** 2;

    if (distanceSq < best.distanceSq) {
      const segmentMeters = corridor.cumulativeMeters[i] - corridor.cumulativeMeters[i - 1];
      best = {
        distanceSq,
        offsetMeters: corridor.cumulativeMeters[i - 1] + segmentMeters * t,
        point: [projLat, projLng],
      };
    }
  }

  return best;
}

function bboxOf(lngLatPoints) {
  return lngLatPoints.reduce(
    (acc, [lng, lat]) => ({
      minLng: Math.min(acc.minLng, lng),
      maxLng: Math.max(acc.maxLng, lng),
      minLat: Math.min(acc.minLat, lat),
      maxLat: Math.max(acc.maxLat, lat),
    }),
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity },
  );
}

function isInsideBbox([lng, lat], bbox) {
  return lng >= bbox.minLng && lng <= bbox.maxLng && lat >= bbox.minLat && lat <= bbox.maxLat;
}

function isInsideRing([lng, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Prepares the first Polygon/MultiPolygon feature of a GeoJSON
 * FeatureCollection for fast point-in-polygon tests. Returns null if the
 * collection has no polygon.
 */
export function prepareBoundary(featureCollection) {
  const geometry = featureCollection?.features?.find(
    (feature) => feature?.geometry?.coordinates,
  )?.geometry;
  if (!geometry) return null;

  const polygonSets =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

  const polygons = polygonSets
    .map((rings) => {
      const normalizedRings = rings
        .filter((ring) => Array.isArray(ring) && ring.length >= 4)
        .map((ring) => ring.map(([lng, lat]) => [Number(lng), Number(lat)]));
      if (normalizedRings.length === 0) return null;
      return { rings: normalizedRings, bbox: bboxOf(normalizedRings[0]) };
    })
    .filter(Boolean);

  if (polygons.length === 0) return null;
  return { bbox: bboxOf(polygons.flatMap((polygon) => polygon.rings[0])), polygons };
}

/** True when a [lat, lng] point lies inside the prepared boundary (holes excluded). */
export function isPointInsideBoundary(boundary, point) {
  if (!boundary || !Array.isArray(point) || point.length < 2) return true;

  const lngLat = [point[1], point[0]];
  if (!isInsideBbox(lngLat, boundary.bbox)) return false;

  return boundary.polygons.some((polygon) => {
    if (!isInsideBbox(lngLat, polygon.bbox)) return false;
    if (!isInsideRing(lngLat, polygon.rings[0])) return false;
    return polygon.rings.slice(1).every((hole) => !isInsideRing(lngLat, hole));
  });
}

/** Samples about 56 points of a route (plus its end) against the boundary. */
export function routeStaysInsideBoundary(boundary, points) {
  if (!Array.isArray(points) || points.length < 2) return false;
  const stride = Math.max(1, Math.floor(points.length / 56));
  for (let i = 0; i < points.length; i += stride) {
    if (!isPointInsideBoundary(boundary, points[i])) return false;
  }
  return isPointInsideBoundary(boundary, points[points.length - 1]);
}
