const assert = require("assert");
const { dist, nonceFor, pointKey, integrityProblem, analyze, tripStats, stops, shiftFlags, jpegFrom } = require("./lib");
assert(Math.abs(dist(0, 0, 0, 1) - 111195) < 200, "1 degree of longitude at the equator is about 111 km");
assert.strictEqual(nonceFor(["a", "in", 1, 2, 3]), nonceFor(["a", "in", 1, 2, 3]));
assert.notStrictEqual(nonceFor(["a", "in", 1, 2, 3]), nonceFor(["a", "in", 1, 2, 4]));
// The same values are checked against the app's code in android/app/src/test.
assert.strictEqual(nonceFor(["abc", "in", 10000000, 76000000, 12, "/9j/AA=="]), "jVAY1Ad9u2Kf1aHGcGAMnbZRoMirR1K_WiTsLNoI3N0");
const keyed = pointKey({ t: 1700000000000, latE6: 10000000, lngE6: -76000000, acc: 8, mock: false });
assert.strictEqual(keyed, "1700000000000,10000000,-76000000,8,0");
assert.strictEqual(nonceFor(["abc", "track", keyed]), "mV774Uq6mKwJNbbmJ-EJIZCyaRuEnkTORxr43vW1O-Q");

const t0 = 1700000000000;
const walk = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 30000, lat: 10 + i * 0.00005, lng: 76 + (i % 3) * 0.00001, acc: 8 + (i % 4), mock: 0, ver: 1 }));
assert.deepStrictEqual(analyze(walk), []);
const jump = walk.concat([{ t: t0 + 12 * 30000, lat: 10.5, lng: 76, acc: 9, mock: 0, ver: 1 }]);
assert(analyze(jump).some(s => s.includes("impossible jump")));
const lateJump = walk.concat([{ t: t0 + 3600000, lat: 13, lng: 76, acc: 9, mock: 0, ver: 1 }]);
assert(analyze(lateJump).some(s => s.includes("impossible jump")), "a jump across a long gap is still impossible");
const poorFix = walk.concat([{ t: t0 + 11 * 30000 + 5000, lat: 10.0035, lng: 76, acc: 150, mock: 0, ver: 1 }]);
assert(!analyze(poorFix).some(s => s.includes("impossible jump")), "one imprecise fix is not a jump");
assert(analyze([{ ...walk[0], mock: 1 }]).some(s => s.includes("mock")));
assert(analyze([{ ...walk[0], ver: 0 }]).some(s => s.includes("not verified")));
assert(analyze(walk.map(p => ({ ...p, acc: 5 }))).some(s => s.includes("same accuracy")));
const still = Array.from({ length: 50 }, (_, i) => ({ t: t0 + i * 30000, lat: 10, lng: 76, acc: 8 + (i % 4), mock: 0, ver: 1 }));
assert(analyze(still).some(s => s.includes("never changed")));
assert(analyze(walk.map(p => ({ ...p, acc: 1 + (p.t % 2) }))).some(s => s.includes("unrealistically")));

// Play Integrity verdicts
const good = { requestDetails: { requestPackageName: "pkg", nonce: "n", timestampMillis: String(t0) }, appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" }, deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] } };
assert.strictEqual(integrityProblem(good, "n", "pkg", t0), null);
assert.strictEqual(integrityProblem({ ...good, requestDetails: { ...good.requestDetails, nonce: "n==" } }, "n", "pkg", t0), null, "padding on the nonce doesn't matter");
assert(integrityProblem(good, "n", "other", t0).includes("different app"));
assert(integrityProblem(good, "other", "pkg", t0).includes("does not match"));
assert(integrityProblem(good, "n", "pkg", t0 + 6 * 60000).includes("too old"));
assert(integrityProblem({ ...good, requestDetails: { requestPackageName: "pkg", nonce: "n" } }, "n", "pkg", t0).includes("too old"), "a missing timestamp fails");
assert(integrityProblem({ ...good, appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }, "n", "pkg", t0).includes("genuine"));
assert(integrityProblem({ ...good, deviceIntegrity: {} }, "n", "pkg", t0).includes("device integrity"));
assert(integrityProblem({}, "n", "pkg", t0));

// Trip statistics. The office is at 10,76 with a 100 m radius; 0.01 degrees of latitude is about 1.1 km.
const office = { lat: 10, lng: 76, radius: 100 };
const at = (min, lat) => ({ t: t0 + min * 60000, lat, lng: 76, acc: 10, mock: 0, ver: 1 });
const trip = [at(0, 10), at(1, 10), at(2, 10.01), at(3, 10.01), at(4, 10), at(5, 10)];
let s = tripStats(trip, office, false, t0);
assert(Math.abs(s.distanceM - 2224) < 10, "there and back is about 2.2 km, got " + s.distanceM);
assert.strictEqual(s.awayMs, 2 * 60000, "away for minutes 2 to 3 plus half of each trip out and back");
assert(Math.abs(s.farthestM - 1112) < 5);
assert.deepStrictEqual(s.gaps, []);
const drift = Array.from({ length: 100 }, (_, i) => ({ ...at(i, 10 + (i % 2) * 0.00005) }));
assert.strictEqual(tripStats(drift, office, false, t0).distanceM, 0, "GPS drift while standing still isn't travel");
assert.strictEqual(tripStats(drift, office, false, t0).awayMs, 0);
s = tripStats([at(0, 10), at(1, 10), at(30, 10), at(31, 10)], office, false, t0);
assert.deepStrictEqual(s.gaps, [{ from: t0 + 60000, to: t0 + 30 * 60000 }]);
assert.strictEqual(s.gapMs, 29 * 60000);
s = tripStats([at(0, 10.01), at(30, 10.01)], office, false, t0);
assert.strictEqual(s.awayMs, 0, "time inside a gap is unknown, not away");
s = tripStats([at(0, 10)], office, true, t0 + 60 * 60000);
assert.strictEqual(s.gaps.length, 1, "still clocked in but nothing received for an hour");
assert.strictEqual(s.gaps[0].ongoing, true);
assert.strictEqual(tripStats([at(0, 10)], office, true, t0 + 5 * 60000).gaps.length, 0, "recent points may still be uploading");
assert.strictEqual(tripStats([at(0, 10)], office, false, t0 + 60 * 60000).gaps.length, 0);
assert.strictEqual(tripStats(trip, null, false, t0).awayMs, 0, "works before the office is set");
assert.strictEqual(tripStats([], office, true, t0).distanceM, 0);

// Stops: 15 minutes in one place, a drive, then 5 minutes (too short) and 20 minutes somewhere else
const stay = (from, n, lat) => Array.from({ length: n }, (_, i) => at(from + i, lat + (i % 2) * 0.00003));
const day = [...stay(0, 16, 10), at(17, 10.005), at(18, 10.01), ...stay(19, 6, 10.02), at(26, 10.03), ...stay(27, 21, 10.04)];
const found = stops(day);
assert.strictEqual(found.length, 2);
assert.deepStrictEqual([found[0].from, found[0].to], [t0, t0 + 15 * 60000]);
assert(Math.abs(found[1].lat - 10.04) < 0.0001);
assert.strictEqual(found[1].to - found[1].from, 20 * 60000);
assert.deepStrictEqual(stops([at(0, 10), at(30, 10)]), [], "a gap with no readings isn't a stop");
assert.deepStrictEqual(stops([]), []);

// Whole-shift flags
const shift = { in_at: t0, out_at: t0 + 8 * 3600000 };
const noGaps = { gaps: [] };
assert.deepStrictEqual(shiftFlags(shift, noGaps, [], t0), []);
assert.deepStrictEqual(shiftFlags(shift, { gaps: [{ from: t0, to: t0 + 20 * 60000 }] }, [], t0), [], "a 20-minute gap is shown but not flagged");
assert(shiftFlags(shift, { gaps: [{ from: t0, to: t0 + 20 * 60000 }, { from: t0 + 3600000, to: t0 + 3600000 + 45 * 60000 }] }, [], t0)[0].startsWith("1 gap(s) of over 30 min with no location, the longest 45 min"));
assert(shiftFlags(shift, noGaps, [{ t: t0, type: "location_off" }, { t: t0 + 1, type: "location_on" }, { t: t0 + 2, type: "location_off" }], t0)[0].includes("switched off 2 time(s)"));
assert(shiftFlags({ in_at: t0, out_at: t0 + 13 * 3600000 }, noGaps, [], t0)[0].includes("Shift lasted 13.0 hours"));
assert(shiftFlags({ in_at: t0, out_at: null }, noGaps, [], t0 + 15 * 3600000)[0].includes("Still clocked in after 15.0 hours"));
assert.deepStrictEqual(shiftFlags({ in_at: t0, out_at: null }, noGaps, [], t0 + 3600000), []);

// Selfies
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000)]);
assert(jpegFrom(jpeg.toString("base64")).equals(jpeg));
assert.strictEqual(jpegFrom(undefined), null);
assert.strictEqual(jpegFrom(""), null);
assert.strictEqual(jpegFrom(Buffer.alloc(2000).toString("base64")), null, "not a JPEG");
assert.strictEqual(jpegFrom(Buffer.from([0xff, 0xd8]).toString("base64")), null, "too small");
assert.strictEqual(jpegFrom("A".repeat(400001)), null, "too large");
console.log("lib tests passed");
