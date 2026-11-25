// Starts the real server on a temporary database and runs an employee's day
// against it. Play Integrity can't be reached from here, so the first server
// runs in test mode and a second one checks that strict mode blocks.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");

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
const adminGet = (base, url) => call(base, "GET", "/admin/api" + url, { auth: adminAuth }).then(r => r.json);
const adminPost = (base, url, body) => call(base, "POST", "/admin/api" + url, { auth: adminAuth, body });

async function enroll(base, name, extra) {
  const added = await adminPost(base, "/employees", { name, ...extra });
  assert.strictEqual(added.status, 200);
  const e = await call(base, "POST", "/api/enroll", { body: { code: added.json.code } });
  assert.strictEqual(e.status, 200);
  return "Bearer " + e.json.token;
}
const nonce = async (base, auth) => (await call(base, "GET", "/api/nonce", { auth })).json.nonce;
const selfie = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
// 1 millionth of a degree of latitude is about 0.11 m. The branch is at 10,76.
const fixAt = latE6 => ({ latE6, lngE6: 76000000, acc: 12, mock: false, integrityToken: "" });
async function clock(base, auth, action, latE6, extra) {
  return call(base, "POST", "/api/clock", { auth, body: { action, ...fixAt(latE6), serverNonce: await nonce(base, auth), photo: selfie.toString("base64"), ...extra } });
}
async function visit(base, auth, step, latE6, extra) {
  return call(base, "POST", "/api/visit/" + step, { auth, body: { ...fixAt(latE6), serverNonce: await nonce(base, auth), ...extra } });
}
async function track(base, auth, points) {
  return call(base, "POST", "/api/track", { auth, body: { serverNonce: await nonce(base, auth), integrityToken: "", points } });
}
const alerts = async base => (await adminGet(base, "/alerts")).map(a => a.text);
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

async function main() {
  // A database made by the previous version, with one office and departments, is upgraded in place.
  const old = new Database(path.join(dir, "test.db"));
  old.exec(`CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT DEFAULT '', enroll_code TEXT, token TEXT, active INTEGER DEFAULT 1, device TEXT DEFAULT '');
    CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO config VALUES('office','{"lat":10,"lng":76,"radius":100,"maxAcc":40}');
    INSERT INTO employees(name,dept,enroll_code) VALUES('Asha','Sales','11112222'),('Old timer','Collection','33334444');`);
  old.close();
  const { base, proc } = await start(3101, "test", { ALLOW_UNVERIFIED: "1" });
  const [main] = await adminGet(base, "/branches");
  assert.deepStrictEqual([main.name, main.lat, main.radius, main.max_acc], ["Main branch", 10, 100, 40], "the old office became the first branch");
  assert.deepStrictEqual((await adminGet(base, "/teams")).map(t => t.name), ["Collection", "Sales"], "departments became teams");
  const asha = (await adminGet(base, "/employees")).find(e => e.name === "Asha");
  assert.deepStrictEqual([asha.branch, asha.team], ["Main branch", "Sales"]);

  // Dashboard sign-in
  assert.strictEqual((await call(base, "GET", "/admin")).status, 401);
  assert.strictEqual((await call(base, "GET", "/admin/api/branches", { auth: "Basic " + Buffer.from("x:wrongpassword").toString("base64") })).status, 401);

  // Branches and teams
  assert.strictEqual((await adminPost(base, "/branches", { name: "Bad", lat: 10, lng: 76, radius: 5, maxAcc: 50 })).status, 400);
  assert.strictEqual((await adminPost(base, "/branches", { name: "Thrissur", lat: 10.5, lng: 76.2, radius: 100, maxAcc: 50 })).status, 200);
  assert.strictEqual((await adminPost(base, "/teams", { name: "" })).status, 400);
  const thrissur = (await adminGet(base, "/branches")).find(b => b.name === "Thrissur");
  const sales = (await adminGet(base, "/teams")).find(t => t.name === "Sales");

  // Enrollment
  assert.strictEqual((await call(base, "POST", "/api/enroll", { body: { code: "00000000" } })).status, 400);
  const enrolled = await call(base, "POST", "/api/enroll", { body: { code: "11112222", device: "Google sdk_gphone64 <b>" } });
  assert.strictEqual(enrolled.json.name, "Asha");
  assert((await alerts(base)).includes("Enrolled a phone: Google sdk_gphone64 b"), "the manager sees each enrollment and the phone model");
  assert.strictEqual((await adminGet(base, "/employees")).find(e => e.name === "Asha").device, "Google sdk_gphone64 b");
  assert.strictEqual((await call(base, "POST", "/api/enroll", { body: { code: "11112222" } })).status, 400, "a code works once");
  const auth = "Bearer " + enrolled.json.token;
  assert.strictEqual((await call(base, "GET", "/api/me")).status, 401);

  // A selfie is required, and it must be a real JPEG
  let r = await clock(base, auth, "in", 10000000, { photo: undefined });
  assert.strictEqual(r.status, 400);
  assert(r.json.error.includes("selfie"));
  assert.strictEqual((await clock(base, auth, "in", 10000000, { photo: Buffer.alloc(3000).toString("base64") })).status, 400);

  // The branch's accuracy limit
  r = await clock(base, auth, "in", 10000000, { acc: 45 });
  assert.strictEqual(r.status, 400);
  assert(r.json.error.includes("too imprecise"));
  assert((await alerts(base)).some(t => t.includes("Clock-in refused: GPS too imprecise (±45 m, limit ±40 m)")));

  // A mock location is blocked and the manager sees it
  r = await clock(base, auth, "in", 10000000, { mock: true });
  assert.strictEqual(r.status, 403);
  assert((await alerts(base)).some(t => t.includes("Blocked clock-in: phone reported a mock location")));
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).json.clockedIn, false, "pressing the button alone gives no hours");

  // Other refusals
  assert.strictEqual((await clock(base, auth, "out", 10000000)).status, 409, "can't clock out before clocking in");
  const usedNonce = await nonce(base, auth);
  await clock(base, auth, "in", 10000000, { serverNonce: usedNonce, mock: true });
  assert.strictEqual((await clock(base, auth, "in", 10000000, { serverNonce: usedNonce })).status, 400, "a nonce works once");
  assert.strictEqual((await clock(base, auth, "in", 10000000, { serverNonce: "made-up" })).status, 400);
  assert.strictEqual((await visit(base, auth, "start", 10000000, { name: "A", place: "B" })).status, 409, "no visits before clocking in");

  // Clocking in works anywhere; the distance from the branch is recorded
  r = await clock(base, auth, "in", 10010000);
  assert.strictEqual(r.status, 200);
  assert(r.json.message.includes("1112 m from Main branch"), r.json.message);
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).json.clockedIn, true);
  assert.strictEqual((await clock(base, auth, "in", 10000100)).status, 409);

  // Visits: a new customer gets the employee's position as its location
  assert.strictEqual((await visit(base, auth, "start", 10020000, { name: "  ", place: "X" })).status, 400);
  r = await visit(base, auth, "start", 10020000, { name: "Ravi Traders", place: "MG Road" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.visit.customer, "Ravi Traders");
  let me = (await call(base, "GET", "/api/me", { auth })).json;
  assert.strictEqual(me.visit.customer, "Ravi Traders", "the app knows a visit is in progress");
  assert.strictEqual((await visit(base, auth, "start", 10020000, { name: "Other", place: "Y" })).status, 409, "one visit at a time");
  r = await visit(base, auth, "end", 10020100);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await visit(base, auth, "end", 10020100)).status, 409);
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).json.visit, null);

  // Typing the same customer again nearby doesn't make a duplicate
  await visit(base, auth, "start", 10020200, { name: "ravi traders", place: "MG Road" });
  await visit(base, auth, "end", 10020200);
  let customers = await adminGet(base, "/customers");
  assert.strictEqual(customers.length, 1);
  assert.strictEqual(customers[0].visits, 2);
  assert.strictEqual(customers[0].added_by, "Asha");

  // The customer list in the app is sorted nearest first
  await visit(base, auth, "start", 10100000, { name: "Far Away Stores", place: "Highway" });
  await visit(base, auth, "end", 10100000);
  const near = (await call(base, "GET", "/api/customers?latE6=10020000&lngE6=76000000", { auth })).json.customers;
  assert.deepStrictEqual(near.map(c => c.name), ["Ravi Traders", "Far Away Stores"]);
  assert.strictEqual(near[0].distM, 0);

  // Choosing an existing customer from far away is flagged and alerted
  r = await visit(base, auth, "start", 10040000, { customerId: near[0].id });
  assert.strictEqual(r.status, 200);
  assert(r.json.message.includes("flagged"));
  assert((await alerts(base)).some(t => t.includes("Started a visit to Ravi Traders 2224 m from the customer's location")));
  assert.strictEqual((await visit(base, auth, "start", 10040000, { customerId: 99999 })).status, 400);

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
  assert.strictEqual((await call(base, "GET", "/api/customers?latE6=x", { auth })).status, 400);
  assert.strictEqual(proc.exitCode, null, "server is still running");

  const today = startOfToday();
  const atts = () => adminGet(base, "/attendance?from=" + today);
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
  assert((await alerts(base)).filter(t => t.includes("Switched off location")).length === 1);

  // The overview, for all branches and filtered
  let sum = await adminGet(base, "/summary?from=" + today);
  assert.deepStrictEqual([sum.active, sum.checkedIn, sum.visits, sum.engaged, sum.withVisits], [2, 1, 4, 1, 1]);
  assert.strictEqual(sum.chart.length, 7);
  assert.strictEqual(sum.chart[6].visits, 4);
  assert.deepStrictEqual(sum.branches.map(b => [b.name, b.active, b.checkedIn, b.visits]), [["Main branch", 2, 1, 4]]);
  assert.deepStrictEqual(sum.teams.map(t => [t.name, t.checkedIn]), [["Collection", 0], ["Sales", 1]]);
  assert.strictEqual(sum.recentVisits[0].customer, "Ravi Traders");
  assert.strictEqual(sum.recentVisits[0].branch, "Main branch");
  assert(sum.recentVisits[0].flagged);
  assert(sum.exceptions.some(x => x.text === "Location switched off" && x.branch === "Main branch"));
  assert(sum.exceptions.some(x => x.text.includes("mock location")));
  sum = await adminGet(base, "/summary?from=" + today + "&branch=" + thrissur.id);
  assert.deepStrictEqual([sum.active, sum.checkedIn, sum.visits], [0, 0, 0], "another branch's report is separate");
  sum = await adminGet(base, "/summary?from=" + today + "&team=" + sales.id);
  assert.deepStrictEqual([sum.active, sum.checkedIn, sum.visits], [1, 1, 4]);
  assert.strictEqual((await adminGet(base, "/attendance?from=" + today + "&branch=" + thrissur.id)).length, 0);

  // Clocking out anywhere is allowed, and ends the visit in progress
  await event({ type: "location_on", t: now + 2 });
  r = await clock(base, auth, "out", 10040000);
  assert.strictEqual(r.status, 200);
  assert(r.json.message.includes("Your visit to Ravi Traders was ended too"));
  const [row] = await atts();
  assert(row.out_at >= row.in_at);
  assert.strictEqual(row.out_dist, 4448);
  assert.deepStrictEqual([row.branch, row.team], ["Main branch", "Sales"]);
  assert(!row.flags.some(f => f.includes("Clocked out")), "clocking out away from the branch isn't flagged");

  // The trip and the employee's day report
  const trip = await adminGet(base, "/trip/" + id);
  assert.deepStrictEqual(trip.photos.sort(), ["in", "out"]);
  assert.strictEqual(trip.visits.length, 4);
  assert(trip.flags.some(f => f.includes("switched off 1 time(s)")));
  const photoRes = await fetch(base + "/admin/api/photo/" + id + "/in", { headers: { Authorization: adminAuth } });
  assert(Buffer.from(await photoRes.arrayBuffer()).equals(selfie), "the manager sees the exact selfie");
  assert.strictEqual((await fetch(base + "/admin/api/photo/" + id + "/in")).status, 401, "selfies need the dashboard password");
  const day = await adminGet(base, "/employee-day?employee=" + asha.id + "&from=" + today);
  assert.strictEqual(day.employee.name, "Asha");
  assert.strictEqual(day.shifts.length, 1);
  assert(Array.isArray(day.shifts[0].stops));
  assert.deepStrictEqual(day.shifts[0].events.map(e => e.type), ["location_off", "location_on"]);
  assert.deepStrictEqual(day.visits.map(v => v.customer), ["Ravi Traders", "Ravi Traders", "Far Away Stores", "Ravi Traders"]);
  const last = day.visits[3];
  assert.strictEqual(last.start_dist, 2224);
  assert(last.flags.includes("Ended automatically at clock-out"));
  assert(last.flags.some(f => f.includes("Ended 2224 m")));
  assert.strictEqual(day.visits[0].end_dist, 11);

  // The manager can move an employee and correct a customer
  await adminPost(base, "/employees/" + asha.id, { branchId: thrissur.id, teamId: "" });
  const moved = (await adminGet(base, "/employees")).find(e => e.name === "Asha");
  assert.deepStrictEqual([moved.branch, moved.team], ["Thrissur", null]);
  assert.strictEqual((await adminPost(base, "/customers/" + near[0].id, { name: "Ravi Traders Ltd", place: "MG Road", lat: 10.02, lng: 76 })).status, 200);
  assert.strictEqual((await adminPost(base, "/customers/" + near[0].id, { name: "", place: "x", lat: 1, lng: 1 })).status, 400);
  assert((await adminGet(base, "/customers")).some(c => c.name === "Ravi Traders Ltd"));

  // Resetting a phone signs the old one out
  await adminPost(base, "/employees/" + asha.id + "/reset", {});
  assert.strictEqual((await call(base, "GET", "/api/me", { auth })).status, 401);
  assert.strictEqual((await call(base, "POST", "/api/event", { auth, body: { type: "location_off", t: now } })).status, 401);

  // Too many wrong dashboard passwords are refused, even if the password is then right
  for (let i = 0; i < 20; i++) await call(base, "GET", "/admin/api/branches", { auth: "Basic " + Buffer.from("x:wrong" + i).toString("base64") });
  assert.strictEqual((await call(base, "GET", "/admin/api/branches", { auth: adminAuth })).status, 429);

  // Strict mode, which is what runs once Google Play is set up: no valid token, no clocking or visits
  const strict = await start(3102, "strict", {});
  const strictAuth = await enroll(strict.base, "Ravi", {});
  r = await clock(strict.base, strictAuth, "in", 10000100);
  assert.strictEqual(r.status, 403);
  assert(r.json.error.includes("can't be verified"));
  assert((await alerts(strict.base)).some(t => t.includes("Clock-in attempt failed verification")));
  assert.strictEqual((await call(strict.base, "GET", "/api/me", { auth: strictAuth })).json.clockedIn, false);
  assert.strictEqual((await visit(strict.base, strictAuth, "start", 10000000, { name: "A", place: "B" })).status, 403);

  console.log("end-to-end tests passed");
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  running.forEach(p => p.kill());
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 300);
});
