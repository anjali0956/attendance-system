const express = require("express");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");
const { dist, nonceFor, pointKey, integrityProblem, analyze, tripStats, shiftFlags, jpegFrom } = require("./lib");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // only Caddy, on this same machine, may connect directly
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PACKAGE_NAME = process.env.PACKAGE_NAME || "io.github.anjali0956.attendance";
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED === "1";
const DEFAULT_MAX_ACC = 50;   // worst GPS accuracy accepted, for employees without a branch
const CUSTOMER_RADIUS = 150;  // a visit further than this from the customer's saved location is flagged
const DAY = 86400000;
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
CREATE TABLE IF NOT EXISTS events(attendance_id INTEGER NOT NULL, t INTEGER NOT NULL, type TEXT NOT NULL, PRIMARY KEY(attendance_id, t, type));
CREATE TABLE IF NOT EXISTS photos(attendance_id INTEGER NOT NULL, kind TEXT NOT NULL, jpeg BLOB NOT NULL, PRIMARY KEY(attendance_id, kind));
CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, employee_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, employee_id INTEGER, at INTEGER, text TEXT);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, radius INTEGER NOT NULL, max_acc INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, place TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, created_by INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, attendance_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
  start_at INTEGER NOT NULL, start_lat REAL, start_lng REAL, start_acc INTEGER, start_dist INTEGER,
  end_at INTEGER, end_lat REAL, end_lng REAL, end_acc INTEGER, end_dist INTEGER, flags TEXT DEFAULT '[]');
CREATE INDEX IF NOT EXISTS visits_start ON visits(start_at);
CREATE INDEX IF NOT EXISTS att_in ON attendance(in_at);
`);
// Upgrades for databases made by earlier versions.
const hasColumn = (table, col) => db.prepare("PRAGMA table_info(" + table + ")").all().some(c => c.name === col);
if (!hasColumn("employees", "device")) db.exec("ALTER TABLE employees ADD COLUMN device TEXT DEFAULT ''");
if (!hasColumn("employees", "branch_id")) {
  db.transaction(() => {
    db.exec("ALTER TABLE employees ADD COLUMN branch_id INTEGER; ALTER TABLE employees ADD COLUMN team_id INTEGER");
    // The single office location becomes the first branch.
    const office = db.prepare("SELECT value FROM config WHERE key='office'").get();
    if (office) {
      const o = JSON.parse(office.value);
      const b = db.prepare("INSERT INTO branches(name,lat,lng,radius,max_acc) VALUES('Main branch',?,?,?,?)").run(o.lat, o.lng, o.radius, o.maxAcc || DEFAULT_MAX_ACC);
      db.prepare("UPDATE employees SET branch_id=?").run(b.lastInsertRowid);
    }
    // Departments become teams.
    for (const { dept } of db.prepare("SELECT DISTINCT dept FROM employees WHERE dept<>''").all()) {
      const t = db.prepare("INSERT INTO teams(name) VALUES(?)").run(dept);
      db.prepare("UPDATE employees SET team_id=? WHERE dept=?").run(t.lastInsertRowid, dept);
    }
  })();
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const q = sql => db.prepare(sql);
const branchById = id => id == null ? null : q("SELECT * FROM branches WHERE id=?").get(id) || null;
// tripStats wants {lat, lng, radius}; a branch row has those fields.
const officeOf = branchId => branchById(branchId);
const openShift = id => q("SELECT * FROM attendance WHERE employee_id=? AND out_at IS NULL ORDER BY id DESC LIMIT 1").get(id);
const openVisit = id => q("SELECT v.*,c.name AS customer,c.place FROM visits v JOIN customers c ON c.id=v.customer_id WHERE v.employee_id=? AND v.end_at IS NULL ORDER BY v.id DESC LIMIT 1").get(id);
const alertFor = (empId, text) => q("INSERT INTO alerts(employee_id,at,text) VALUES(?,?,?)").run(empId, Date.now(), text);
// The shift that uploads from the phone belong to: the open one, or one that ended in the last 10 minutes.
const recentShift = (empId, now) => {
  const att = q("SELECT * FROM attendance WHERE employee_id=? ORDER BY id DESC LIMIT 1").get(empId);
  return att && !(att.out_at && now - att.out_at > 10 * 60000) ? att : null;
};
const capital = s => s[0].toUpperCase() + s.slice(1);

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
app.use(express.json({ limit: "512kb" })); // a clock-in carries a selfie

// Express 4 doesn't catch errors in async handlers, and an uncaught one stops the server.
const safe = fn => (req, res, next) => fn(req, res, next).catch(next);
const validCoords = (latE6, lngE6) => Math.abs(latE6) <= 90e6 && Math.abs(lngE6) <= 180e6;
const validPoint = p => p && [p.t, p.latE6, p.lngE6, p.acc].every(Number.isInteger) && validCoords(p.latE6, p.lngE6);

/**
 * Checks the position, one-time nonce and Play Integrity token sent with a clock or visit request.
 * extra: the request's other values, in the order the app puts them in its nonce.
 * Sends the refusal and returns null, or returns the checked position.
 */
async function checkFix(req, res, what, extra) {
  const { latE6, lngE6, acc, mock, serverNonce, integrityToken } = req.body;
  if (![latE6, lngE6, acc].every(Number.isInteger) || !validCoords(latE6, lngE6)) { res.status(400).json({ error: "Bad request" }); return null; }
  if (!takeNonce(serverNonce, req.emp.id)) { res.status(400).json({ error: "Request expired. Try again." }); return null; }
  if (mock) {
    alertFor(req.emp.id, "Blocked " + what + ": phone reported a mock location");
    res.status(403).json({ error: "Your phone reports a mock location. Turn off any fake-GPS app and try again." });
    return null;
  }
  const maxAcc = (branchById(req.emp.branch_id) || { max_acc: DEFAULT_MAX_ACC }).max_acc;
  if (acc > maxAcc) {
    alertFor(req.emp.id, capital(what) + " refused: GPS too imprecise (±" + acc + " m, limit ±" + maxAcc + " m)");
    res.status(400).json({ error: "Your location is too imprecise (±" + acc + " m). Move near a window, wait a few seconds and try again." });
    return null;
  }
  const flags = [];
  const integ = await verifyIntegrity(integrityToken, nonceFor([serverNonce, ...extra(latE6, lngE6, acc)]));
  if (!integ.ok) {
    alertFor(req.emp.id, capital(what) + " attempt failed verification: " + integ.reason);
    if (!ALLOW_UNVERIFIED) { res.status(403).json({ error: "This phone can't be verified. " + integ.reason + "." }); return null; }
    flags.push("Not verified: " + integ.reason);
  }
  return { lat: latE6 / 1e6, lng: lngE6 / 1e6, acc, flags, ver: integ.ok ? 1 : 0 };
}

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
  const device = String((req.body || {}).device || "").replace(/[^\w .,()+-]/g, "").slice(0, 80);
  const e = code && q("SELECT * FROM employees WHERE enroll_code=? AND active=1").get(code);
  if (!e) return res.status(400).json({ error: "That code isn't valid." });
  const token = crypto.randomBytes(32).toString("hex");
  q("UPDATE employees SET token=?, enroll_code=NULL, device=? WHERE id=?").run(sha(token), device, e.id);
  alertFor(e.id, "Enrolled a phone" + (device ? ": " + device : ""));
  res.json({ token, name: e.name });
});

app.get("/api/me", auth, (req, res) => {
  const v = openVisit(req.emp.id);
  res.json({ name: req.emp.name, clockedIn: !!openShift(req.emp.id), visit: v ? { id: v.id, customer: v.customer, place: v.place, startAt: v.start_at } : null });
});

app.get("/api/nonce", auth, (req, res) => {
  const n = crypto.randomBytes(24).toString("hex");
  q("INSERT INTO nonces VALUES(?,?,?)").run(n, req.emp.id, Date.now());
  q("DELETE FROM nonces WHERE created<?").run(Date.now() - 10 * 60000);
  res.json({ nonce: n });
});

// Closes a visit at the given position. Used by "End visit" and by clocking out.
function endVisit(v, lat, lng, acc, now, flags) {
  const c = q("SELECT * FROM customers WHERE id=?").get(v.customer_id);
  const d = Math.round(dist(lat, lng, c.lat, c.lng));
  if (d > CUSTOMER_RADIUS) flags.push("Ended " + d + " m from the customer's location");
  q("UPDATE visits SET end_at=?,end_lat=?,end_lng=?,end_acc=?,end_dist=?,flags=? WHERE id=?")
    .run(now, lat, lng, acc, d, JSON.stringify([...JSON.parse(v.flags), ...flags]), v.id);
}

// Clocking in and out is allowed anywhere. The distance from the employee's branch is recorded for the manager.
app.post("/api/clock", auth, safe(async (req, res) => {
  const { action, photo } = req.body || {};
  if (!["in", "out"].includes(action)) return res.status(400).json({ error: "Bad request" });
  const jpeg = jpegFrom(photo);
  if (!jpeg) return res.status(400).json({ error: "A selfie is needed to clock in and out. Update the app and try again." });
  const fix = await checkFix(req, res, "clock-" + action, (la, ln, ac) => [action, la, ln, ac, photo]);
  if (!fix) return;

  const { lat, lng, acc, flags, ver } = fix;
  const branch = branchById(req.emp.branch_id);
  const d = branch ? Math.round(dist(lat, lng, branch.lat, branch.lng)) : null;
  const where = branch ? " (" + d + " m from " + branch.name + ")" : "";
  const cur = openShift(req.emp.id), now = Date.now();
  const savePhoto = (attId, kind) => q("INSERT OR REPLACE INTO photos(attendance_id,kind,jpeg) VALUES(?,?,?)").run(attId, kind, jpeg);
  const addPoint = attId => q("INSERT OR IGNORE INTO points(attendance_id,t,lat,lng,acc,mock,ver) VALUES(?,?,?,?,?,0,?)").run(attId, now, lat, lng, acc, ver);
  if (action === "in") {
    if (cur) return res.status(409).json({ error: "You are already clocked in." });
    const r = q("INSERT INTO attendance(employee_id,in_at,in_lat,in_lng,in_acc,in_dist,in_flags) VALUES(?,?,?,?,?,?,?)")
      .run(req.emp.id, now, lat, lng, acc, d, JSON.stringify(flags));
    addPoint(r.lastInsertRowid);
    savePhoto(r.lastInsertRowid, "in");
    return res.json({ ok: true, message: "Clocked in. Location verified" + where + "." });
  }
  if (!cur) return res.status(409).json({ error: "You are not clocked in." });
  const v = openVisit(req.emp.id);
  if (v) endVisit(v, lat, lng, acc, now, ["Ended automatically at clock-out"]);
  q("UPDATE attendance SET out_at=?,out_lat=?,out_lng=?,out_acc=?,out_dist=?,out_flags=? WHERE id=?").run(now, lat, lng, acc, d, JSON.stringify(flags), cur.id);
  addPoint(cur.id);
  savePhoto(cur.id, "out");
  res.json({ ok: true, message: "Clocked out" + where + "." + (v ? " Your visit to " + v.customer + " was ended too." : "") });
}));

// Customers nearest the employee first, so the one they're at is near the top.
app.get("/api/customers", auth, (req, res) => {
  const lat = Number(req.query.latE6) / 1e6, lng = Number(req.query.lngE6) / 1e6;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Bad request" });
  const list = q("SELECT id,name,place,lat,lng FROM customers").all()
    .map(c => ({ id: c.id, name: c.name, place: c.place, distM: Math.round(dist(lat, lng, c.lat, c.lng)) }))
    .sort((a, b) => a.distM - b.distM).slice(0, 30);
  res.json({ customers: list });
});

app.post("/api/visit/start", auth, safe(async (req, res) => {
  const { customerId, name, place } = req.body || {};
  const isNew = customerId == null;
  const cleanName = String(name || "").trim().slice(0, 80), cleanPlace = String(place || "").trim().slice(0, 120);
  if (isNew ? !cleanName || !cleanPlace : !Number.isInteger(customerId)) return res.status(400).json({ error: "Enter the customer's name and place." });
  const existing = isNew ? null : q("SELECT * FROM customers WHERE id=?").get(customerId);
  if (!isNew && !existing) return res.status(400).json({ error: "That customer no longer exists. Choose again." });
  const fix = await checkFix(req, res, "visit start", (la, ln, ac) => ["visit_start", la, ln, ac, isNew ? "" : customerId, name ?? "", place ?? ""]);
  if (!fix) return;

  const att = openShift(req.emp.id), now = Date.now();
  if (!att) return res.status(409).json({ error: "Clock in before starting a visit." });
  const busy = openVisit(req.emp.id);
  if (busy) return res.status(409).json({ error: "You are already visiting " + busy.customer + ". End that visit first." });
  const { lat, lng, acc, flags } = fix;
  let customer = existing;
  if (isNew) {
    // The same name close by is the same customer, so a repeated "new customer" doesn't create a duplicate.
    customer = q("SELECT * FROM customers WHERE lower(name)=lower(?)").all(cleanName).find(c => dist(lat, lng, c.lat, c.lng) < 300);
    if (!customer) {
      const r = q("INSERT INTO customers(name,place,lat,lng,created_by,created_at) VALUES(?,?,?,?,?,?)").run(cleanName, cleanPlace, lat, lng, req.emp.id, now);
      customer = q("SELECT * FROM customers WHERE id=?").get(r.lastInsertRowid);
    }
  }
  const d = Math.round(dist(lat, lng, customer.lat, customer.lng));
  if (d > CUSTOMER_RADIUS) {
    flags.push("Started " + d + " m from the customer's location");
    alertFor(req.emp.id, "Started a visit to " + customer.name + " " + d + " m from the customer's location");
  }
  const r = q("INSERT INTO visits(employee_id,attendance_id,customer_id,start_at,start_lat,start_lng,start_acc,start_dist,flags) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(req.emp.id, att.id, customer.id, now, lat, lng, acc, d, JSON.stringify(flags));
  res.json({ ok: true, visit: { id: r.lastInsertRowid, customer: customer.name, place: customer.place, startAt: now },
    message: "Visit to " + customer.name + " started" + (d > CUSTOMER_RADIUS ? ". You are " + d + " m from this customer's saved location, so this was flagged." : ".") });
}));

app.post("/api/visit/end", auth, safe(async (req, res) => {
  const fix = await checkFix(req, res, "visit end", (la, ln, ac) => ["visit_end", la, ln, ac]);
  if (!fix) return;
  const v = openVisit(req.emp.id);
  if (!v) return res.status(409).json({ error: "You don't have a visit in progress." });
  endVisit(v, fix.lat, fix.lng, fix.acc, Date.now(), fix.flags);
  res.json({ ok: true, message: "Visit to " + v.customer + " ended." });
}));

app.post("/api/track", auth, safe(async (req, res) => {
  const { serverNonce, integrityToken, points } = req.body || {};
  if (!Array.isArray(points) || !points.length || points.length > 200 || !points.every(validPoint)) return res.status(400).json({ error: "Bad request" });
  if (!takeNonce(serverNonce, req.emp.id)) return res.status(400).json({ error: "Request expired." });
  const now = Date.now();
  const att = recentShift(req.emp.id, now);
  if (!att) return res.json({ ok: true, stored: 0 });
  const integ = await verifyIntegrity(integrityToken, nonceFor([serverNonce, "track", ...points.map(pointKey)]));
  const ver = integ.ok ? 1 : 0;
  // OR IGNORE: if the phone never got our reply it sends the same points again.
  const ins = q("INSERT OR IGNORE INTO points(attendance_id,t,lat,lng,acc,mock,ver) VALUES(?,?,?,?,?,?,?)");
  let stored = 0, mocks = 0;
  db.transaction(() => {
    for (const p of points) {
      if (p.t > now + 60000 || p.t < now - DAY || p.t < att.in_at - 60000) continue;
      if (att.out_at && p.t > att.out_at + 30000) continue;
      const added = ins.run(att.id, p.t, p.latE6 / 1e6, p.lngE6 / 1e6, p.acc, p.mock ? 1 : 0, ver).changes;
      stored += added;
      if (p.mock) mocks += added;
    }
  })();
  if (mocks) alertFor(req.emp.id, "Trip upload contained " + mocks + " mock location point(s)");
  res.json({ ok: true, stored });
}));

// The phone reports when location is switched off or back on while clocked in.
app.post("/api/event", auth, (req, res) => {
  const { type, t } = req.body || {};
  if (!["location_off", "location_on"].includes(type) || !Number.isInteger(t)) return res.status(400).json({ error: "Bad request" });
  const now = Date.now(), att = recentShift(req.emp.id, now);
  if (!att) return res.json({ ok: true });
  const at = Math.min(Math.max(t, att.in_at), att.out_at || now);
  const added = q("INSERT OR IGNORE INTO events(attendance_id,t,type) VALUES(?,?,?)").run(att.id, at, type).changes;
  if (added && type === "location_off") alertFor(req.emp.id, "Switched off location while clocked in");
  res.json({ ok: true });
});

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
const bad = (res, error) => res.status(400).json({ error });
const idOrNull = v => (v === "" || v == null ? null : Number(v));

// Branches and teams
api.get("/branches", (req, res) => res.json(q("SELECT * FROM branches ORDER BY name").all()));
api.post("/branches", (req, res) => {
  const { id, name, lat, lng, radius, maxAcc } = req.body || {};
  const n = String(name || "").trim();
  if (!n || ![lat, lng, radius, maxAcc].every(Number.isFinite) || radius < 30 || radius > 2000 || maxAcc < 10 || maxAcc > 150 || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return bad(res, "Enter a name, a valid latitude and longitude, a radius of 30 to 2000 m, and an accuracy limit of 10 to 150 m.");
  if (id) q("UPDATE branches SET name=?,lat=?,lng=?,radius=?,max_acc=? WHERE id=?").run(n, lat, lng, radius, maxAcc, id);
  else q("INSERT INTO branches(name,lat,lng,radius,max_acc) VALUES(?,?,?,?,?)").run(n, lat, lng, radius, maxAcc);
  res.json({ ok: true });
});
api.get("/teams", (req, res) => res.json(q("SELECT * FROM teams ORDER BY name").all()));
api.post("/teams", (req, res) => {
  const { id, name } = req.body || {};
  const n = String(name || "").trim();
  if (!n) return bad(res, "Enter a team name.");
  if (id) q("UPDATE teams SET name=? WHERE id=?").run(n, id);
  else q("INSERT INTO teams(name) VALUES(?)").run(n);
  res.json({ ok: true });
});

// Employees
const newCode = () => String(crypto.randomInt(10000000, 100000000));
api.get("/employees", (req, res) => res.json(q(`SELECT e.id,e.name,e.device,e.branch_id,e.team_id,b.name AS branch,t.name AS team,e.enroll_code AS code,e.token IS NOT NULL AS enrolled
  FROM employees e LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN teams t ON t.id=e.team_id WHERE e.active=1 ORDER BY e.name`).all()));
api.post("/employees", (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (!name) return bad(res, "Enter a name.");
  const code = newCode();
  q("INSERT INTO employees(name,enroll_code,branch_id,team_id) VALUES(?,?,?,?)").run(name, code, idOrNull(req.body.branchId), idOrNull(req.body.teamId));
  res.json({ code });
});
api.post("/employees/:id", (req, res) => {
  const { branchId, teamId } = req.body || {};
  q("UPDATE employees SET branch_id=?, team_id=? WHERE id=?").run(idOrNull(branchId), idOrNull(teamId), req.params.id);
  res.json({ ok: true });
});
api.post("/employees/:id/reset", (req, res) => {
  const code = newCode();
  q("UPDATE employees SET enroll_code=?, token=NULL, device='' WHERE id=?").run(code, req.params.id);
  res.json({ code });
});

// Customers
api.get("/customers", (req, res) => res.json(q(`SELECT c.*,e.name AS added_by,COUNT(v.id) AS visits,MAX(v.start_at) AS last_visit
  FROM customers c LEFT JOIN employees e ON e.id=c.created_by LEFT JOIN visits v ON v.customer_id=c.id GROUP BY c.id ORDER BY c.name`).all()));
api.post("/customers/:id", (req, res) => {
  const { name, place, lat, lng } = req.body || {};
  const n = String(name || "").trim(), p = String(place || "").trim();
  if (!n || !p || ![lat, lng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad(res, "Enter a name, place, latitude and longitude.");
  q("UPDATE customers SET name=?,place=?,lat=?,lng=? WHERE id=?").run(n, p, lat, lng, req.params.id);
  res.json({ ok: true });
});

// Everything the manager needs to judge one shift.
const pointsOf = id => q("SELECT t,lat,lng,acc,mock,ver FROM points WHERE attendance_id=? ORDER BY t").all(id);
const eventsOf = id => q("SELECT t,type FROM events WHERE attendance_id=? ORDER BY t").all(id);
function review(r) {
  const office = officeOf(r.branch_id);
  const pts = pointsOf(r.id), stats = tripStats(pts, office, !r.out_at), events = eventsOf(r.id);
  const flags = [...JSON.parse(r.in_flags), ...JSON.parse(r.out_flags), ...analyze(pts), ...shiftFlags(r, stats, events)];
  return { pts, stats, events, flags, office };
}
const SHIFT = `SELECT a.*,e.name,e.branch_id,e.team_id,b.name AS branch,t.name AS team FROM attendance a JOIN employees e ON e.id=a.employee_id
  LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN teams t ON t.id=e.team_id`;
const VISIT = `SELECT v.*,c.name AS customer,c.place,c.lat AS c_lat,c.lng AS c_lng,e.name AS employee,e.branch_id,e.team_id,b.name AS branch,t.name AS team
  FROM visits v JOIN customers c ON c.id=v.customer_id JOIN employees e ON e.id=v.employee_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN teams t ON t.id=e.team_id`;
// The branch and team filters from the dashboard, as SQL on the employees table "e".
function scope(query) {
  const where = ["e.active=1"], args = [];
  for (const [param, col] of [["branch", "e.branch_id"], ["team", "e.team_id"]]) {
    const v = query[param];
    if (v === "none") where.push(col + " IS NULL");
    else if (v && v !== "all") { where.push(col + "=?"); args.push(Number(v)); }
  }
  return { where: where.join(" AND "), args };
}
const dayOf = query => { const from = Number(query.from) || Date.now() - DAY; return { from, to: from + DAY }; };

api.get("/attendance", (req, res) => {
  const { from, to } = dayOf(req.query), s = scope(req.query);
  const rows = q(SHIFT + " WHERE " + s.where + " AND a.in_at>=? AND a.in_at<? ORDER BY a.in_at DESC LIMIT 500").all(...s.args, from, to);
  res.json(rows.map(r => {
    const { pts, stats, flags } = review(r);
    return { ...r, points: pts.length, flags, stats };
  }));
});
api.get("/trip/:id", (req, res) => {
  const a = q(SHIFT + " WHERE a.id=?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  const { pts, stats, events, flags, office } = review(a);
  const photos = q("SELECT kind FROM photos WHERE attendance_id=?").all(a.id).map(p => p.kind);
  const visits = q(VISIT + " WHERE v.attendance_id=? ORDER BY v.start_at").all(a.id);
  res.json({ attendance: a, points: pts, flags, stats, events, photos, office, visits });
});

// One employee's day: every shift, the path, and each customer visited in order.
api.get("/employee-day", (req, res) => {
  const { from, to } = dayOf(req.query);
  const emp = q("SELECT e.id,e.name,b.name AS branch,t.name AS team,e.branch_id FROM employees e LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN teams t ON t.id=e.team_id WHERE e.id=?").get(req.query.employee);
  if (!emp) return res.status(404).json({ error: "Not found" });
  const shifts = q(SHIFT + " WHERE a.employee_id=? AND a.in_at>=? AND a.in_at<? ORDER BY a.in_at").all(emp.id, from, to).map(a => {
    const { pts, stats, flags } = review(a);
    const photos = q("SELECT kind FROM photos WHERE attendance_id=?").all(a.id).map(p => p.kind);
    return { attendance: a, points: pts, stats, flags, photos };
  });
  const visits = q(VISIT + " WHERE v.employee_id=? AND v.start_at>=? AND v.start_at<? ORDER BY v.start_at").all(emp.id, from, to)
    .map(v => ({ ...v, flags: JSON.parse(v.flags) }));
  res.json({ employee: emp, office: officeOf(emp.branch_id), shifts, visits });
});

// The overview: totals, the 7-day chart, branch and team tables, recent visits and location problems.
api.get("/summary", (req, res) => {
  const { from, to } = dayOf(req.query), s = scope(req.query), now = Date.now();
  const emps = q("SELECT e.id,e.name,e.branch_id,e.team_id FROM employees e WHERE " + s.where).all(...s.args);
  const shifts = q(SHIFT + " WHERE " + s.where + " AND a.in_at>=? AND a.in_at<?").all(...s.args, from, to);
  const dayVisits = q(VISIT + " WHERE " + s.where + " AND v.start_at>=? AND v.start_at<? ORDER BY v.start_at DESC").all(...s.args, from, to);
  const checkedIn = new Set(shifts.map(a => a.employee_id));
  const engaged = q(VISIT + " WHERE " + s.where + " AND v.end_at IS NULL").all(...s.args).length;

  const countVisits = (a, b) => q("SELECT COUNT(*) AS n FROM visits v JOIN employees e ON e.id=v.employee_id WHERE " + s.where + " AND v.start_at>=? AND v.start_at<?").get(...s.args, a, b).n;
  const chart = [];
  for (let k = 6; k >= 0; k--) chart.push({ day: from - k * DAY, visits: countVisits(from - k * DAY, from - (k - 1) * DAY) });
  const previous = countVisits(from - 13 * DAY, from - 6 * DAY);

  // A row for each branch or team: people, how many checked in, and their visits on the day.
  const groupRows = (key, list) => {
    const rows = list.map(g => ({ id: g.id, name: g.name })).concat(emps.some(e => e[key] == null) ? [{ id: null, name: "Not assigned" }] : []);
    return rows.map(g => {
      const members = emps.filter(e => e[key] === g.id);
      const ids = new Set(members.map(e => e.id));
      const visits = dayVisits.filter(v => ids.has(v.employee_id));
      return { ...g, active: members.length, checkedIn: members.filter(e => checkedIn.has(e.id)).length,
        withVisits: new Set(visits.map(v => v.employee_id)).size, visits: visits.length };
    }).filter(g => g.active > 0);
  };

  // People clocked in right now whose location looks wrong.
  const exceptions = [];
  for (const a of q(SHIFT + " WHERE " + s.where + " AND a.out_at IS NULL").all(...s.args)) {
    const last = q("SELECT t FROM points WHERE attendance_id=? ORDER BY t DESC LIMIT 1").get(a.id);
    const lastT = last ? last.t : a.in_at;
    const lastEvent = q("SELECT type FROM events WHERE attendance_id=? ORDER BY t DESC LIMIT 1").get(a.id);
    const mocks = q("SELECT COUNT(*) AS n FROM points WHERE attendance_id=? AND mock=1").get(a.id).n;
    const row = text => exceptions.push({ attendanceId: a.id, employeeId: a.employee_id, name: a.name, branch: a.branch, team: a.team, text, inAt: a.in_at, lastT });
    if (lastEvent && lastEvent.type === "location_off") row("Location switched off");
    else if (now - lastT > 3600000) row("No location update for over 1 hour");
    if (mocks) row(mocks + " mock location point(s)");
  }

  const earlierOpen = q(SHIFT + " WHERE " + s.where + " AND a.out_at IS NULL AND a.in_at<?").all(...s.args, from).length;
  const flagged = shifts.filter(a => review(a).flags.length).length;
  res.json({
    active: emps.length, checkedIn: checkedIn.size, visits: dayVisits.length, engaged,
    withVisits: new Set(dayVisits.map(v => v.employee_id)).size,
    chart, previous, earlierOpen, flagged,
    branches: groupRows("branch_id", q("SELECT id,name FROM branches ORDER BY name").all()),
    teams: groupRows("team_id", q("SELECT id,name FROM teams ORDER BY name").all()),
    recentVisits: dayVisits.slice(0, 10).map(v => ({ id: v.id, employeeId: v.employee_id, employee: v.employee, customer: v.customer, place: v.place,
      branch: v.branch, team: v.team, startAt: v.start_at, endAt: v.end_at, flagged: JSON.parse(v.flags).length > 0 })),
    exceptions,
  });
});

api.get("/photo/:id/:kind", (req, res) => {
  const p = q("SELECT jpeg FROM photos WHERE attendance_id=? AND kind=?").get(req.params.id, req.params.kind);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.set("Cache-Control", "private, max-age=86400").type("jpeg").send(p.jpeg);
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
