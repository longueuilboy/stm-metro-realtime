// server.js — STM métro (horaire théorique) via GTFS frequencies.txt
// Important: STM GTFS: bus schedules + metro frequency; metro is in frequencies.txt. :contentReference[oaicite:2]{index=2}

const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");
const { parse } = require("csv-parse");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIG ---
const GTFS_URL =
  process.env.GTFS_URL ||
  "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"; // referenced as current static GTFS. :contentReference[oaicite:3]{index=3}

const ROUTE_ID = process.env.METRO_ROUTE_ID || "4"; // Ligne jaune = 4 (dans le feed STM)
const DIRECTION_ID = process.env.METRO_DIRECTION_ID || "0"; // parfois 0/1; si c’est inversé, change à "1"

const CACHE_PATH = "/tmp/gtfs_stm.zip";
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

// --- Helpers: time ---
function pad2(n) { return String(n).padStart(2, "0"); }
function yyyymmdd(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}
function secondsSinceMidnight(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}
function parseHMS(hms) {
  // GTFS peut dépasser 24:00:00, ex 25:10:00
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}
function formatNext(secFromNow) {
  if (secFromNow <= 60) return "Arrive";
  return `${Math.round(secFromNow / 60)} min`;
}

// --- Download GTFS ZIP to disk (streaming) ---
async function ensureGtfsZip() {
  try {
    const stat = fs.existsSync(CACHE_PATH) ? fs.statSync(CACHE_PATH) : null;
    const fresh = stat && (Date.now() - stat.mtimeMs) < CACHE_MAX_AGE_MS;
    if (fresh) return;

    await new Promise(async (resolve, reject) => {
      const resp = await fetch(GTFS_URL);
      if (!resp.ok) return reject(new Error(`GTFS download failed: ${resp.status}`));
      const file = fs.createWriteStream(CACHE_PATH);
      resp.body.pipe(file);
      resp.body.on("error", reject);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
  } catch (e) {
    // If download fails but file exists, keep going with cached
    if (!fs.existsSync(CACHE_PATH)) throw e;
  }
}

// --- Read a specific file inside the ZIP as a stream ---
function openZipEntryStream(zipPath, wantedName) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();

      zipfile.on("entry", (entry) => {
        const name = entry.fileName.toLowerCase();
        if (name === wantedName.toLowerCase()) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2) return reject(err2);
            // close zipfile when stream ends
            stream.on("end", () => zipfile.close());
            return resolve(stream);
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => reject(new Error(`File not found in ZIP: ${wantedName}`)));
      zipfile.on("error", reject);
    });
  });
}

// --- Parse calendar + calendar_dates to know active service_ids today ---
async function loadServiceIdsForToday(dateObj) {
  const today = yyyymmdd(dateObj);
  const dow = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dateObj.getDay()];

  const calendar = new Map(); // service_id -> {start_date,end_date, dowFlags}
  const exceptions = new Map(); // service_id -> exception_type (for today)

  // calendar.txt
  {
    const stream = await openZipEntryStream(CACHE_PATH, "calendar.txt");
    await new Promise((resolve, reject) => {
      stream
        .pipe(parse({ columns: true, relax_quotes: true, trim: true }))
        .on("data", (r) => {
          calendar.set(r.service_id, {
            start: r.start_date,
            end: r.end_date,
            monday: r.monday, tuesday: r.tuesday, wednesday: r.wednesday,
            thursday: r.thursday, friday: r.friday, saturday: r.saturday, sunday: r.sunday
          });
        })
        .on("end", resolve)
        .on("error", reject);
    });
  }

  // calendar_dates.txt (exceptions)
  {
    const stream = await openZipEntryStream(CACHE_PATH, "calendar_dates.txt");
    await new Promise((resolve, reject) => {
      stream
        .pipe(parse({ columns: true, relax_quotes: true, trim: true }))
        .on("data", (r) => {
          if (r.date === today) exceptions.set(r.service_id, r.exception_type);
        })
        .on("end", resolve)
        .on("error", reject);
    });
  }

  const active = new Set();
  for (const [serviceId, info] of calendar.entries()) {
    if (!(info.start <= today && today <= info.end)) continue;

    const dowOk = String(info[dow]) === "1";
    const ex = exceptions.get(serviceId);

    // exception_type: 1 = add, 2 = remove
    if (ex === "2") continue;
    if (ex === "1") { active.add(serviceId); continue; }

    if (dowOk) active.add(serviceId);
  }

  return active;
}

// --- Load trip_ids for route 4 + direction ---
async function loadTripIdsForRouteAndDirection() {
  const tripIds = new Map(); // trip_id -> service_id (only for our route/direction)

  const stream = await openZipEntryStream(CACHE_PATH, "trips.txt");
  await new Promise((resolve, reject) => {
    stream
      .pipe(parse({ columns: true, relax_quotes: true, trim: true }))
      .on("data", (r) => {
        // route_id, service_id, trip_id, direction_id
        if (String(r.route_id) !== String(ROUTE_ID)) return;
        if (String(r.direction_id ?? "") !== String(DIRECTION_ID)) return;
        tripIds.set(r.trip_id, r.service_id);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  return tripIds;
}

// --- Load frequency windows for active service_ids ---
async function loadFrequencyWindows(activeServiceIds, tripIdsMap) {
  const windows = []; // {startSec,endSec,headwaySec}

  const stream = await openZipEntryStream(CACHE_PATH, "frequencies.txt");
  await new Promise((resolve, reject) => {
    stream
      .pipe(parse({ columns: true, relax_quotes: true, trim: true }))
      .on("data", (r) => {
        const tripId = r.trip_id;
        const serviceId = tripIdsMap.get(tripId);
        if (!serviceId) return;
        if (!activeServiceIds.has(serviceId)) return;

        const startSec = parseHMS(r.start_time);
        const endSec = parseHMS(r.end_time);
        const headwaySec = Number(r.headway_secs);

        if (!Number.isFinite(headwaySec) || headwaySec <= 0) return;
        windows.push({ startSec, endSec, headwaySec });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  // Sort by start time
  windows.sort((a, b) => a.startSec - b.startSec);
  return windows;
}

// --- Compute next 2 departures from "now" based on frequency windows ---
function nextTwoFromFrequencies(nowSec, windows) {
  const candidates = [];

  for (const w of windows) {
    if (nowSec > w.endSec) continue;

    const start = w.startSec;
    const head = w.headwaySec;

    // If before service window, next is at start
    let next = nowSec <= start ? start : start + Math.ceil((nowSec - start) / head) * head;

    // produce up to 2 within this window
    for (let i = 0; i < 2; i++) {
      const t = next + i * head;
      if (t <= w.endSec) candidates.push(t);
    }
  }

  candidates.sort((a, b) => a - b);
  // unique & keep first two
  const uniq = [];
  for (const t of candidates) {
    if (uniq.length && uniq[uniq.length - 1] === t) continue;
    uniq.push(t);
    if (uniq.length >= 2) break;
  }
  return uniq;
}

// --- Main: get next two as text ---
async function getNextTwoText() {
  await ensureGtfsZip();

  const now = new Date();
  const nowSec = secondsSinceMidnight(now);

  const activeServices = await loadServiceIdsForToday(now);
  const tripIdsMap = await loadTripIdsForRouteAndDirection();
  const windows = await loadFrequencyWindows(activeServices, tripIdsMap);

  if (!windows.length) {
    return { status: "Hors période de service", lines: ["Hors période de service", "—"] };
  }

  const nextTimes = nextTwoFromFrequencies(nowSec, windows);

  if (!nextTimes.length) {
    return { status: "Hors période de service", lines: ["Hors période de service", "—"] };
  }

  const lines = nextTimes.map(t => formatNext(t - nowSec));
  if (lines.length === 1) lines.push("—");
  return { status: "OK", lines };
}

// --- Routes ---
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/next", async (req, res) => {
  try {
    const out = await getNextTwoText();
    res.type("text/plain").send(out.lines.join("\n"));
  } catch (e) {
    console.error(e);
    res.status(500).type("text/plain").send("Données indisponibles\n—");
  }
});

app.get("/panel", async (req, res) => {
  try {
    const out = await getNextTwoText();
    const l1 = out.lines[0] || "—";
    const l2 = out.lines[1] || "—";

    // NOTE: This is theoretical (frequency-based), not real-time.
    res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Métro — Ligne jaune</title>
<style>
  body{margin:0;background:#000;color:#FFD200;font-family:Arial,Helvetica,sans-serif}
  .wrap{padding:20px}
  .h{color:#FFD200;font-weight:700;font-size:18px;margin-bottom:6px}
  .sub{color:#fff;font-size:16px;margin-bottom:18px}
  .row{display:flex;align-items:center;gap:10px;font-size:44px;margin:10px 0}
  .dot{width:18px;height:18px;border-radius:50%;background:#FFD200;opacity:.9}
  .foot{color:#fff;opacity:.8;font-size:13px;margin-top:18px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="h">MÉTRO — LIGNE JAUNE</div>
    <div class="sub">Longueuil–UdeS → Berri-UQAM (horaire planifié)</div>

    <div class="row"><div class="dot"></div><div>${l1}</div></div>
    <div class="row"><div class="dot"></div><div>${l2}</div></div>

    <div class="foot">Source: GTFS STM (frequencies) — pas du temps réel</div>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Données indisponibles");
  }
});

app.listen(PORT, () => console.log("Serveur STM (GTFS théorique) lancé"));
