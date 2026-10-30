# Attendance system

Two parts:

- `server/`: Node.js server and manager dashboard. Stores attendance and trips, checks the geofence, and verifies Google Play Integrity tokens.
- `android/`: the employee app (Kotlin). Clocks in and out by GPS and records the trip while clocked in.

Tests: `npm test` in `server/` runs the logic tests and an end-to-end run of the server. GitHub Actions runs these and the Android unit tests, and builds the APK, on every push to `main`.

## How the anti-spoofing works

1. The app refuses to use a stale or imprecise fix. A fix Android marks as a mock location is sent to the server, which refuses it and shows the attempt to the manager.
2. Every clock-in, clock-out and trip upload carries a Play Integrity token. The token's nonce is a hash of the request (one-time server nonce, action, and all coordinates), so it can't be replayed with other coordinates.
3. The server decodes the token with Google and requires: the right package name, the matching nonce, a genuine Play-installed app (`PLAY_RECOGNIZED`), and a device that meets `MEETS_DEVICE_INTEGRITY` (not rooted, not an emulator, not modified). A failed check blocks a clock-in or clock-out. Trip points that fail are kept but flagged, so the manager still sees the route.
4. The server does the geofence maths itself. The phone only sends coordinates.
5. The dashboard flags impossible jumps, identical accuracy values, motionless positions, mock points and unverified points. Blocked attempts are listed under "Blocked and failed attempts".

## Test setup: server on a DigitalOcean Droplet, APK from GitHub

This needs no software on your computer beyond a browser. It runs with `ALLOW_UNVERIFIED=1`, because an APK that wasn't installed from Google Play can't pass Play Integrity. In this mode, every record shows "Review" and failed checks are flagged instead of blocked.

1. Put this project in a public GitHub repository. The folder containing this README must be the top level of the repository.
2. Create an Ubuntu 24.04 Droplet. In its web console, run:
   ```
   curl -fsSL https://raw.githubusercontent.com/YOUR-NAME/YOUR-REPO/main/deploy/setup.sh -o setup.sh
   bash setup.sh https://github.com/YOUR-NAME/YOUR-REPO.git YOUR-ADMIN-PASSWORD
   ```
   The password must be at least 10 letters and numbers. The script prints your `https://….sslip.io` address.
3. In `android/app/build.gradle.kts`, set `SERVER_URL` to that address and push to `main`.
4. On GitHub, open **Actions**, open the latest **Build APK** run, and download `attendance-apk`. Unzip it and install `app-debug.apk` on the phone.
5. Open `https://your-address/admin` (any username, your password). Set the **office location** and add employees. Each employee gets an 8-digit enrollment code to enter in the app. "Use my location" is only accurate on a phone at the office; a computer's location can be far off.

To update the server later:
```
cd /opt/attendance && git pull && cd server && npm ci --omit=dev && systemctl restart attendance
```

Data is in `/var/lib/attendance/attendance.db` (SQLite) and nowhere else, so back it up.

## Full setup: Google Play and Play Integrity

1. Create (or pick) a Google Cloud project and enable the **Play Integrity API**. Note the **project number**.
2. In the Play Console, open your app, then **Test and release > App integrity**, and link that Cloud project.
3. In the same Cloud project, create a **service account** and download a JSON key. The server uses it to decode tokens. Never put this file on GitHub.
4. In `android/app/build.gradle.kts`, set `CLOUD_PROJECT_NUMBER`. Play doesn't accept a `com.example` application ID, so change `applicationId` and set the same value as `PACKAGE_NAME` in `/etc/attendance.env` on the server.
5. Build a signed release, upload it to at least an **internal testing** track, and install from Google Play. Sideloaded builds are reported as unrecognised and fail verification.
6. On the server, add `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` to `/etc/attendance.env`, remove `ALLOW_UNVERIFIED=1`, and run `systemctl restart attendance`. The `attendance` user must be able to read the key file.

## Known limits

- **iPhone:** there is no iOS app, and iOS has no equivalent of Android's mock-location flag.
- **Trip gaps:** if the phone is switched off, loses signal, or the system kills the app, points are missing, and the dashboard shows the gap. The service doesn't restart by itself on Android 12 and newer; tracking resumes when the employee next opens the app. Points are held in memory and lost if the app is killed before an upload.
- **Clock-out off-site** is allowed but flagged. Clock-in off-site is blocked.
- **Play Integrity is strong but not perfect.** It raises the cost of faking a location a lot. It does not stop an employee carrying their phone to work and leaving it there, or handing it to someone else.
- **Login is a device token** stored in app preferences. For stronger sign-in, add a PIN or biometric prompt.
- There is no record editing, shift schedule, or leave tracking. A forgotten clock-out keeps counting hours until the employee clocks out.
- Times inside "impossible jump" flags are shown in UTC. Everything else on the dashboard uses the viewer's local time.
- Tell employees that their location is recorded while clocked in. Check what your local law requires for employee location tracking and consent.
