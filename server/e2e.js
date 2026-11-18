// Starts the real server on a temporary database and runs an employee's day
// against it. Play Integrity can't be reached from here, so the first server
// runs in test mode and a second one checks that strict mode blocks.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PASSWORD = "testpassword123";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-e2e-"));
const running = [];

async function start(port, name, extraEnv) {
  const env = { ...process.env, ADMIN_PASSWORD: PASSWORD, PORT: String(port), DB_FILE: path.join(dir, name + ".db"), ...extraEnv };
  const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: "inherit" });
  running.push(proc);
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error("Server stopped with exit code " + proc.exitCode);
    try { await fetch(base + "/", { redirect: "manual" }); return { base, proc }; }
    catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error("Server didn't start");
}

const adminAuth = "Basic " + Buffer.from("manager:" + PASSWORD).toString("base64");
async function call(base, method, url, { auth, body } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function enroll(base, name, dept) {
  const added = await call(base, "POST", "/admin/api/employees", { auth: adminAuth, body: { name, dept } });
  assert.strictEqual(added.status, 200);
  const e = await call(base, "POST", "/api/enroll", { body: { code: added.json.code } });
  assert.strictEqual(e.status, 200);
  return "Bearer " + e.json.token;
}
const nonce = async (base, auth) => (await call(base, "GET", "/api/nonce", { auth })).json.nonce;
const selfie = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
// 1 millionth of a degree of latitude is about 0.11 m. The office is at 10,76.
async function clock(base, auth, action, latE6, extra) {
  return call(base, "POST", "/api/clock", { auth, body: { action, latE6, lngE6: 76000000, acc: 12, mock: false, serverNonce: await nonce(base, auth), integrityToken: "", photo: selfie.toString("base64"), ...extra } });
}
async function track(base, auth, points) {
  return call(base, "POST", "/api/track", { auth, body: { serverNonce: await nonce(base, auth), integrityToken: "", points } });
}
const alerts = async base => (await call(base, "GET", "/admin/api/alerts", { auth: adminAuth })).json.map(a => a.text);

async function main() {
  const { base, proc } = await start(3101, "test", { ALLOW_UNVERIFIED: "1" });

  // Dashboard sign-in
  assert.strictEqual((await call(base, "GET", "/admin")).status, 401);
  assert.strictEqual((await call(base, "GET", "/admin/api/office", { auth: "Basic " + Buffer.from("x:wrongpassword").toString("base64") })).status, 401);
  assert.strictEqual((await call(base, "GET", "/admin/api/employees", { auth: adminAuth })).status, 200);

  // Enrollment
  assert.strictEqual((await call(base, "POST", "/api/enroll", { body: { code: "00000000" } })).status, 400);
  const added = await call(base, "POST", "/admin/api/employees", { auth: adminAuth, body: { name: "Asha", dept: "Sales" } });
  const enrolled = await call(base, "POST", "/api/enroll", { body: { code: added.json.code, device: "Google sdk_gphone64 <b>" } });
  assert.strictEqual(enrolled.json.name, "Asha");
  assert((await alerts(base)).includes("Enrolled a phone: Google sdk_gphone64 b"), "the manager sees each enrollment and the phone model");
  assert.strictEqual((await call(base, "GET", "/admin/api/employees", { auth: adminAuth })).json[0].device, "Google sdk_gphone64 b");
  assert.strictEqual((await call(base, "POST", "/api/enroll", { body: { code: added.json.code } })).status, 400, "a code works once");
  const auth = "Bearer " + enrolled.json.token;
  assert.strictEqual((await call(base, "GET", "/api/me")).status, 401);

  // Nothing works until the office is set
  let r = await clock(base, auth, "in", 10000000);
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await call(base, "POST", "/admin/api/office", { auth: adminAuth, body: { lat: 10, lng: 76, radius: 5 } })).status, 400);
  assert.strictEqual((await call(base, "POST", "/admin/api/office", { auth: adminAuth, body: { lat: 10, lng: 76, radius: 100 } })).status, 200);
  assert.strictEqual((await call(base, "GET", "/admin/api/office", { auth: adminAuth })).json.maxAcc, 50, "accuracy limit starts at 50 m");
  assert.strictEqual((await call(base, "POST", "/admin/api/office", { auth: adminAuth, body: { lat: 10, lng: 76, radius: 100, maxAcc: 5 } })).status, 400);
  assert.strictEqual((await call(base, "POST", "/admin/api/office", { auth: adminAuth, body: { lat: 10, lng: 76, radius: 100, maxAcc: 40 } })).status, 200);

  // A selfie is required, and it must be a real JPEG
  r = await clock(base, auth, "in", 10000000, { photo: undefined });
  assert.strictEqual(r.status, 400);
  assert(r.json.error.includes("selfie"));
  assert.strictEqual((await clock(base, auth, "in", 10000000, { photo: Buffer.alloc(3000).toString("base64") })).status, 400);

  // The manager's accuracy limit
  r = await clock(base, auth, "in", 10000000, { acc: 45 });
  assert.strictEqual(r.status, 400);
  assert(r.json.error.includes("too imprecise"));
  assert((await alerts(base)).some(t => t.includes("GPS too imprecise (±45 m, limit ±40 m)")));

  // Requirement 3: clock-in is blocked outside the radius
  r = await clock(base, auth, "in", 10010000);
  assert.strictEqual(r.status, 403);
  assert(r.json.error.includes("from the office"));
  assert((await alerts(base)).some(t => t.includes("Tried to clock in")));
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).json.clockedIn, false, "pressing the button alone gives no hours");

  // Requirement 6: a mock location is blocked and the manager sees it
  r = await clock(base, auth, "in", 10000000, { mock: true });
  assert.strictEqual(r.status, 403);
  assert((await alerts(base)).some(t => t.includes("mock location")));

  // Other refusals
  assert.strictEqual((await clock(base, auth, "out", 10000000)).status, 409, "can't clock out before clocking in");
  const usedNonce = await nonce(base, auth);
  await clock(base, auth, "in", 10010000, { serverNonce: usedNonce });
  assert.strictEqual((await clock(base, auth, "in", 10000000, { serverNonce: usedNonce })).status, 400, "a nonce works once");
  assert.strictEqual((await clock(base, auth, "in", 10000000, { serverNonce: "made-up" })).status, 400);

  // Inside the radius
  r = await clock(base, auth, "in", 10000100);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).json.clockedIn, true);
  assert.strictEqual((await clock(base, auth, "in", 10000100)).status, 409);

  // A trip upload
  const now = Date.now(), min = 60000;
  const pt = (ago, latE6) => ({ t: now - ago * min + 1, latE6, lngE6: 76000000, acc: 10 + (ago % 5), mock: false });
  r = await track(base, auth, [pt(40, 10010000)]);
  assert.strictEqual(r.json.stored, 0, "points from before the clock-in are ignored");

  // Malformed uploads must get an error and leave the server running
  for (const points of [[null], [{}], ["x"], [{ t: "1", latE6: 1, lngE6: 1, acc: 1 }], [{ t: 1, latE6: 999999999, lngE6: 1, acc: 1 }], Array(201).fill(pt(0, 10000000)), []]) {
    assert.strictEqual((await track(base, auth, points)).status, 400);
  }
  assert.strictEqual((await call(base, "POST", "/api/clock", { auth, body: "{not json" })).status, 400);
  assert.strictEqual(proc.exitCode, null, "server is still running");

  const atts = () => call(base, "GET", "/admin/api/attendance", { auth: adminAuth }).then(x => x.json);
  const [{ id }] = await atts();
  const future = t => now + t * 1000;
  const live = [
    { t: future(1), latE6: 10010000, lngE6: 76000000, acc: 11, mock: false },
    { t: future(2), latE6: 10010000, lngE6: 76000000, acc: 12, mock: false },
    { t: future(3), latE6: 10010000, lngE6: 76000000, acc: 13, mock: true },
  ];
  r = await track(base, auth, live);
  assert.strictEqual(r.json.stored, 3);
  r = await track(base, auth, live);
  assert.strictEqual(r.json.stored, 0, "a repeated upload adds nothing");
  assert((await alerts(base)).some(t => t.includes("Trip upload contained 1 mock")));

  // Switching location off while clocked in is reported to the manager
  const event = body => call(base, "POST", "/api/event", { auth, body });
  assert.strictEqual((await event({ type: "nonsense", t: now })).status, 400);
  assert.strictEqual((await event({ type: "location_off", t: now + 1 })).status, 200);
  await event({ type: "location_off", t: now + 1 }); // sent twice, counted once
  await event({ type: "location_on", t: now + 2 });
  assert((await alerts(base)).filter(t => t.includes("Switched off location")).length === 1);

  let trip = (await call(base, "GET", "/admin/api/trip/" + id, { auth: adminAuth })).json;
  assert.strictEqual(trip.points.length, 4);
  assert(trip.stats.distanceM > 1000, "travelled about 1.1 km");
  assert(trip.stats.farthestM > 1000);
  assert(trip.flags.some(f => f.includes("mock")));
  assert(trip.flags.some(f => f.includes("not verified")), "test mode records unverified points and flags them");
  assert.strictEqual(trip.attendance.name, "Asha");
  assert.strictEqual(trip.attendance.dept, "Sales");
  assert(trip.flags.some(f => f.includes("switched off 1 time(s)")));
  assert.deepStrictEqual(trip.events.map(e => e.type), ["location_off", "location_on"]);
  assert.deepStrictEqual(trip.photos, ["in"]);
  const photoRes = await fetch(base + "/admin/api/photo/" + id + "/in", { headers: { Authorization: adminAuth } });
  assert.strictEqual(photoRes.headers.get("content-type"), "image/jpeg");
  assert(Buffer.from(await photoRes.arrayBuffer()).equals(selfie), "the manager sees the exact selfie");
  assert.strictEqual((await fetch(base + "/admin/api/photo/" + id + "/in")).status, 401, "selfies need the dashboard password");

  // Requirement 3: clock-out outside the radius is allowed but flagged
  r = await clock(base, auth, "out", 10010000);
  assert.strictEqual(r.status, 200);
  assert(r.json.message.includes("flagged"));
  const [row] = await atts();
  assert(row.out_at >= row.in_at);
  assert(row.out_dist > 1000);
  assert.strictEqual(row.out_acc, 12);
  assert.strictEqual(row.in_acc, 12);
  assert(row.flags.some(f => f.includes("Clocked out")));
  assert.strictEqual(typeof row.stats.awayMs, "number");
  assert(Array.isArray(row.stats.gaps));
  trip = (await call(base, "GET", "/admin/api/trip/" + id, { auth: adminAuth })).json;
  assert(trip.flags.some(f => f.includes("Clocked out")), "the trip panel shows the same flags as the table");
  assert.deepStrictEqual(trip.photos.sort(), ["in", "out"]);
  assert.strictEqual(typeof trip.attendance.out_lat, "number", "clock-out position is available for the map");

  // Resetting a phone signs the old one out
  await call(base, "POST", "/admin/api/employees/" + row.employee_id + "/reset", { auth: adminAuth, body: {} });
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).status, 401);
  assert.strictEqual((await call(base, "POST", "/api/event", { auth, body: { type: "location_off", t: now } })).status, 401);

  // Too many wrong dashboard passwords are refused, even if the password is then right
  for (let i = 0; i < 20; i++) await call(base, "GET", "/admin/api/office", { auth: "Basic " + Buffer.from("x:wrong" + i).toString("base64") });
  assert.strictEqual((await call(base, "GET", "/admin/api/office", { auth: adminAuth })).status, 429);

  // Strict mode, which is what runs once Google Play is set up: no valid token, no clocking
  const strict = await start(3102, "strict", {});
  await call(strict.base, "POST", "/admin/api/office", { auth: adminAuth, body: { lat: 10, lng: 76, radius: 100 } });
  const strictAuth = await enroll(strict.base, "Ravi", "Ops");
  r = await clock(strict.base, strictAuth, "in", 10000100);
  assert.strictEqual(r.status, 403);
  assert(r.json.error.includes("can't be verified"));
  assert((await alerts(strict.base)).some(t => t.includes("failed verification")));
  assert.strictEqual((await call(strict.base, "GET", "/api/me", { auth: strictAuth })).json.clockedIn, false);

  console.log("end-to-end tests passed");
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  running.forEach(p => p.kill());
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 300);
});
