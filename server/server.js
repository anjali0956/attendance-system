const express = require("express");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");
const { dist, nonceFor, pointKey, integrityProblem, analyze, tripStats } = require("./lib");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // only Caddy, on this same machine, may connect directly
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.example.attendance";
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED === "1";
if (!ADMIN_PASSWORD) { console.error("Set ADMIN_PASSWORD before starting."); process.exit(1); }
if (ALLOW_UNVERIFIED) console.warn("WARNING: ALLOW_UNVERIFIED=1. Play Integrity failures will not block clocking. Use for testing only.");

const db = new Database(process.env.DB_FILE || "attendance.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT DEFAULT '', enroll_code TEXT, token TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL,
  in_at INTEGER NOT NULL, in_lat REAL, in_lng REAL, in_acc INTEGER, in_dist INTEGER, in_flags TEXT DEFAULT '[]',
  out_at INTEGER, out_lat REAL, out_lng REAL, out_acc INTEGER, out_dist INTEGER, out_flags TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS points(id INTEGER PRIMARY KEY, attendance_id INTEGER NOT NULL, t INTEGER, lat REAL, lng REAL, acc INTEGER, mock INTEGER DEFAULT 0, ver INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS pts_att ON points(attendance_id, t);
CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, employee_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, employee_id INTEGER, at INTEGER, text TEXT);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT);
`);

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const q = sql => db.prepare(sql);
const getOffice = () => { const r = q("SELECT value FROM config WHERE key='office'").get(); return r ? JSON.parse(r.value) : null; };
const openShift = id => q("SELECT * FROM attendance WHERE employee_id=? AND out_at IS NULL ORDER BY id DESC LIMIT 1").get(id);
const alertFor = (empId, text) => q("INSERT INTO alerts(employee_id,at,text) VALUES(?,?,?)").run(empId, Date.now(), text);

function takeNonce(n, empId) {
  const r = q("SELECT * FROM nonces WHERE nonce=? AND employee_id=?").get(String(n || ""), empId);
  if (!r) return null;
  q("DELETE FROM nonces WHERE nonce=?").run(r.nonce);
  return Date.now() - r.created > 5 * 60000 ? null : r;
}

// ---- Play Integrity ----
let playintegrity;
async function verifyIntegrity(token, expectedNonce) {
  const fail = reason => ({ ok: false, reason });
  if (!token) return fail("No integrity token from the app");
  try {
    if (!playintegrity) {
      // Loaded on first use: this library is slow to load and uses over 100 MB of memory.
      const { google } = require("googleapis");
      const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/playintegrity"] });
      playintegrity = google.playintegrity({ version: "v1", auth });
    }
    const r = await playintegrity.v1.decodeIntegrityToken({ packageName: PACKAGE_NAME, requestBody: { integrityToken: token } });
    const problem = integrityProblem(r.data.tokenPayloadExternal || {}, expectedNonce, PACKAGE_NAME);
    return problem ? fail(problem) : { ok: true };
  } catch (e) {
    console.error("Integrity check error:", e.message);
    return fail("Integrity check could not be completed");
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

// Express 4 doesn't catch errors in async handlers, and an uncaught one stops the server.
const safe = fn => (req, res, next) => fn(req, res, next).catch(next);
const validCoords = (latE6, lngE6) => Math.abs(latE6) <= 90e6 && Math.abs(lngE6) <= 180e6;
const validPoint = p => p && [p.t, p.latE6, p.lngE6, p.acc].every(Number.isInteger) && validCoords(p.latE6, p.lngE6);

// ---- Employee auth ----
function auth(req, res, next) {
  const t = (req.headers.authorization || "").replace(/^Bearer /, "");
  const e = t && q("SELECT * FROM employees WHERE token=? AND active=1").get(sha(t));
  if (!e) return res.status(401).json({ error: "This phone is not signed in. Enroll again with a new code." });
  req.emp = e; next();
}

const tries = new Map();
const limited = ip => {
  const now = Date.now(), r = (tries.get(ip) || []).filter(t => now - t < 15 * 60000);
  r.push(now); tries.set(ip, r); return r.length > 10;
};

app.post("/api/enroll", (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const code = String((req.body || {}).code || "").trim();
  const e = code && q("SELECT * FROM employees WHERE enroll_code=? AND active=1").get(code);
  if (!e) return res.status(400).json({ error: "That code isn't valid." });
  const token = crypto.randomBytes(32).toString("hex");
  q("UPDATE employees SET token=?, enroll_code=NULL WHERE id=?").run(sha(token), e.id);
  res.json({ token, name: e.name });
});

app.get("/api/me", auth, (req, res) => res.json({ name: req.emp.name, clockedIn: !!openShift(req.emp.id) }));

app.get("/api/nonce", auth, (req, res) => {
  const n = crypto.randomBytes(24).toString("hex");
  q("INSERT INTO nonces VALUES(?,?,?)").run(n, req.emp.id, Date.now());
  q("DELETE FROM nonces WHERE created<?").run(Date.now() - 10 * 60000);
  res.json({ nonce: n });
});

app.post("/api/clock", auth, safe(async (req, res) => {
  const { action, latE6, lngE6, acc, mock, serverNonce, integrityToken } = req.body || {};
  if (!["in", "out"].includes(action) || ![latE6, lngE6, acc].every(Number.isInteger) || !validCoords(latE6, lngE6)) return res.status(400).json({ error: "Bad request" });
  if (!takeNonce(serverNonce, req.emp.id)) return res.status(400).json({ error: "Request expired. Try again." });
  if (mock) {
    alertFor(req.emp.id, "Blocked clock-" + action + ": phone reported a mock location");
    return res.status(403).json({ error: "Your phone reports a mock location. Turn off any fake-GPS app and try again." });
  }
  if (acc > 150) return res.status(400).json({ error: "Your location is too imprecise (±" + acc + " m). Move near a window and try again." });
  const office = getOffice();
  if (!office) return res.status(409).json({ error: "The manager hasn't set the office location yet." });

  const flags = [];
  const integ = await verifyIntegrity(integrityToken, nonceFor([serverNonce, action, latE6, lngE6, acc]));
  if (!integ.ok) {
    alertFor(req.emp.id, "Clock-" + action + " attempt failed verification: " + integ.reason);
    if (!ALLOW_UNVERIFIED) return res.status(403).json({ error: "This phone can't be verified. " + integ.reason + "." });
    flags.push("Not verified: " + integ.reason);
  }

  const lat = latE6 / 1e6, lng = lngE6 / 1e6, d = Math.round(dist(lat, lng, office.lat, office.lng)), off = d > office.radius;
  const cur = openShift(req.emp.id), now = Date.now();
  if (action === "in") {
    if (cur) return res.status(409).json({ error: "You are already clocked in." });
    if (off) {
      alertFor(req.emp.id, "Tried to clock in " + d + " m from the office");
      return res.status(403).json({ error: "You are " + d + " m from the office. You can clock in within " + office.radius + " m." });
    }
    const r = q("INSERT INTO attendance(employee_id,in_at,in_lat,in_lng,in_acc,in_dist,in_flags) VALUES(?,?,?,?,?,?,?)")
      .run(req.emp.id, now, lat, lng, acc, d, JSON.stringify(flags));
    q("INSERT OR IGNORE INTO points(attendance_id,t,lat,lng,acc,mock,ver) VALUES(?,?,?,?,?,0,?)").run(r.lastInsertRowid, now, lat, lng, acc, integ.ok ? 1 : 0);
    return res.json({ ok: true, message: "Clocked in. Location verified (" + d + " m from the office)." });
  }
  if (!cur) return res.status(409).json({ error: "You are not clocked in." });
  if (off) flags.push("Clocked out " + d + " m from the office");
  q("UPDATE attendance SET out_at=?,out_lat=?,out_lng=?,out_acc=?,out_dist=?,out_flags=? WHERE id=?").run(now, lat, lng, acc, d, JSON.stringify(flags), cur.id);
  q("INSERT OR IGNORE INTO points(attendance_id,t,lat,lng,acc,mock,ver) VALUES(?,?,?,?,?,0,?)").run(cur.id, now, lat, lng, acc, integ.ok ? 1 : 0);
  res.json({ ok: true, message: "Clocked out." + (off ? " You were " + d + " m from the office, so this was flagged for your manager." : "") });
}));

app.post("/api/track", auth, safe(async (req, res) => {
  const { serverNonce, integrityToken, points } = req.body || {};
  if (!Array.isArray(points) || !points.length || points.length > 200 || !points.every(validPoint)) return res.status(400).json({ error: "Bad request" });
  if (!takeNonce(serverNonce, req.emp.id)) return res.status(400).json({ error: "Request expired." });
  const now = Date.now();
  const att = q("SELECT * FROM attendance WHERE employee_id=? ORDER BY id DESC LIMIT 1").get(req.emp.id);
  if (!att || (att.out_at && now - att.out_at > 10 * 60000)) return res.json({ ok: true, stored: 0 });
  const integ = await verifyIntegrity(integrityToken, nonceFor([serverNonce, "track", ...points.map(pointKey)]));
  const ver = integ.ok ? 1 : 0;
  // OR IGNORE: if the phone never got our reply it sends the same points again.
  const ins = q("INSERT OR IGNORE INTO points(attendance_id,t,lat,lng,acc,mock,ver) VALUES(?,?,?,?,?,?,?)");
  let stored = 0, mocks = 0;
  db.transaction(() => {
    for (const p of points) {
      if (p.t > now + 60000 || p.t < now - 86400000 || p.t < att.in_at - 60000) continue;
      if (att.out_at && p.t > att.out_at + 30000) continue;
      const added = ins.run(att.id, p.t, p.latE6 / 1e6, p.lngE6 / 1e6, p.acc, p.mock ? 1 : 0, ver).changes;
      stored += added;
      if (p.mock) mocks += added;
    }
  })();
  if (mocks) alertFor(req.emp.id, "Trip upload contained " + mocks + " mock location point(s)");
  res.json({ ok: true, stored });
}));

// ---- Manager dashboard ----
const adminFails = new Map();
function admin(req, res, next) {
  const now = Date.now(), fails = (adminFails.get(req.ip) || []).filter(t => now - t < 15 * 60000);
  if (fails.length >= 20) return res.status(429).send("Too many wrong passwords. Try again in 15 minutes.");
  const [scheme, b64] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && b64) {
    const pw = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    fails.push(now); adminFails.set(req.ip, fails);
  }
  res.set("WWW-Authenticate", 'Basic realm="Attendance admin"').status(401).send("Sign in to continue.");
}
const api = express.Router();
api.get("/office", (req, res) => res.json(getOffice()));
api.post("/office", (req, res) => {
  const { lat, lng, radius } = req.body || {};
  if (![lat, lng, radius].every(Number.isFinite) || radius < 30 || radius > 2000 || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ error: "Enter a valid latitude, longitude and a radius of 30 to 2000 m." });
  q("INSERT INTO config(key,value) VALUES('office',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ lat, lng, radius }));
  res.json({ ok: true });
});
const newCode = () => String(crypto.randomInt(10000000, 100000000));
api.get("/employees", (req, res) => res.json(q("SELECT id,name,dept,enroll_code AS code,token IS NOT NULL AS enrolled FROM employees WHERE active=1 ORDER BY name").all()));
api.post("/employees", (req, res) => {
  const name = String((req.body || {}).name || "").trim(), dept = String((req.body || {}).dept || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a name." });
  const code = newCode();
  q("INSERT INTO employees(name,dept,enroll_code) VALUES(?,?,?)").run(name, dept, code);
  res.json({ code });
});
api.post("/employees/:id/reset", (req, res) => {
  const code = newCode();
  q("UPDATE employees SET enroll_code=?, token=NULL WHERE id=?").run(code, req.params.id);
  res.json({ code });
});
const pointsOf = id => q("SELECT t,lat,lng,acc,mock,ver FROM points WHERE attendance_id=? ORDER BY t").all(id);
const flagsOf = (r, pts) => [...JSON.parse(r.in_flags), ...JSON.parse(r.out_flags), ...analyze(pts)];
api.get("/attendance", (req, res) => {
  const from = Number(req.query.from) || 0, to = Number(req.query.to) || Date.now() + 86400000;
  const rows = q("SELECT a.*,e.name,e.dept FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.in_at>=? AND a.in_at<? ORDER BY a.in_at DESC LIMIT 500").all(from, to);
  const office = getOffice();
  res.json(rows.map(r => {
    const pts = pointsOf(r.id);
    return { ...r, points: pts.length, flags: flagsOf(r, pts), stats: tripStats(pts, office, !r.out_at) };
  }));
});
api.get("/trip/:id", (req, res) => {
  const a = q("SELECT a.*,e.name,e.dept FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.id=?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const pts = pointsOf(a.id), office = getOffice();
  res.json({ attendance: a, points: pts, flags: flagsOf(a, pts), stats: tripStats(pts, office, !a.out_at), office });
});
api.get("/alerts", (req, res) => res.json(q("SELECT al.at,al.text,e.name FROM alerts al LEFT JOIN employees e ON e.id=al.employee_id ORDER BY al.id DESC LIMIT 50").all()));

app.get("/", (req, res) => res.redirect("/admin"));
app.get("/admin", admin, (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use("/admin/api", admin, api);

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? "Bad request" : "Server error" });
});

app.listen(PORT, HOST, () => console.log("Attendance server listening on " + HOST + ":" + PORT));
