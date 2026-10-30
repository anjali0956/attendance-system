const crypto = require("crypto");

// Distance in metres between two lat/lng points.
function dist(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const x = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

// The nonce the app must put in its Play Integrity request. It binds the
// attestation to this exact request, so a captured token can't be reused
// with different coordinates.
function nonceFor(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("base64url");
}

// One trip point as it goes into the nonce. Must match Integrity.pointKey in the app.
const pointKey = p => [p.t, p.latE6, p.lngE6, p.acc, p.mock ? 1 : 0].join(",");

// Checks a decoded Play Integrity payload. Returns the reason it fails, or null if it passes.
function integrityProblem(p, expectedNonce, packageName, now = Date.now()) {
  const rd = p.requestDetails || {}, app = p.appIntegrity || {}, dev = p.deviceIntegrity || {};
  if (rd.requestPackageName !== packageName) return "Token was issued for a different app";
  if (String(rd.nonce || "").replace(/=+$/, "") !== expectedNonce) return "Token does not match this request";
  if (!(Math.abs(now - Number(rd.timestampMillis)) <= 5 * 60000)) return "Token is too old";
  if (app.appRecognitionVerdict !== "PLAY_RECOGNIZED") return "App is not the genuine version from Google Play";
  if (!(dev.deviceRecognitionVerdict || []).includes("MEETS_DEVICE_INTEGRITY")) return "Phone failed device integrity (rooted, emulator or modified)";
  return null;
}

const hhmm = t => new Date(t).toISOString().slice(11, 16) + " UTC";

// Looks for patterns typical of fake-GPS tools. pts: [{t, lat, lng, acc, mock, ver}]
function analyze(pts) {
  const out = [];
  const mock = pts.filter(p => p.mock).length;
  if (mock) out.push(mock + " point(s) reported by the phone as a mock location");
  const unver = pts.filter(p => !p.ver).length;
  if (unver) out.push(unver + " point(s) were not verified by Play Integrity");
  let jumps = 0, first = "";
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = (b.t - a.t) / 1000;
    if (dt > 0) {
      // Allow for each reading's accuracy, so one poor fix isn't reported as a jump.
      const d = dist(a.lat, a.lng, b.lat, b.lng) - a.acc - b.acc;
      if (d > 200 && d / dt > 40) { jumps++; if (!first) first = hhmm(b.t) + " (" + Math.round(d) + " m in " + Math.round(dt) + " s)"; }
    }
  }
  if (jumps) out.push(jumps + " impossible jump(s), first at " + first);
  if (pts.length >= 10) {
    if (new Set(pts.map(p => p.acc)).size === 1) out.push("Every reading reports the same accuracy (±" + pts[0].acc + " m)");
    if (new Set(pts.map(p => p.lat + "," + p.lng)).size <= 2 && pts[pts.length - 1].t - pts[0].t > 1200000) out.push("Position never changed, not even by normal GPS drift");
    if (pts.filter(p => p.acc <= 2).length / pts.length > 0.8) out.push("Accuracy is unrealistically precise for most readings");
  }
  return out;
}

const GAP_MS = 5 * 60000;        // the phone records about every 30 s, so 5 min of silence is a real gap
const OPEN_GAP_MS = 11 * 60000;  // the phone uploads every 5 min, so recent points may still be on their way

// Trip summary for the dashboard. open: the employee hasn't clocked out yet.
function tripStats(pts, office, open, now = Date.now()) {
  let distanceM = 0, awayMs = 0, farthestM = 0;
  const gaps = [];
  // A reading only counts as away if it is outside the radius even after allowing for its accuracy.
  const away = p => dist(p.lat, p.lng, office.lat, office.lng) - p.acc > office.radius;
  let anchor = pts[0];
  pts.forEach((p, i) => {
    if (office) farthestM = Math.max(farthestM, dist(p.lat, p.lng, office.lat, office.lng));
    if (!i) return;
    const a = pts[i - 1], dt = p.t - a.t;
    if (dt > GAP_MS) gaps.push({ from: a.t, to: p.t });
    else if (office) awayMs += dt * ((away(a) ? 1 : 0) + (away(p) ? 1 : 0)) / 2;
    // Only count real movement. A phone lying still drifts by a few metres each reading.
    const d = dist(anchor.lat, anchor.lng, p.lat, p.lng);
    if (d > Math.max(25, anchor.acc, p.acc)) { distanceM += d; anchor = p; }
  });
  const last = pts[pts.length - 1];
  if (open && last && now - last.t > OPEN_GAP_MS) gaps.push({ from: last.t, to: now, ongoing: true });
  return {
    distanceM: Math.round(distanceM), awayMs: Math.round(awayMs), farthestM: Math.round(farthestM),
    gaps, gapMs: gaps.reduce((sum, g) => sum + g.to - g.from, 0),
  };
}

module.exports = { dist, nonceFor, pointKey, integrityProblem, analyze, tripStats };
