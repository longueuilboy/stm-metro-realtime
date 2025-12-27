// server.js — STM GTFS (théorique) : 2 prochains passages métro (ligne 4) à STOP_ID
//
// Dépendances requises dans package.json:
//   express, node-fetch (v2), unzipper, csv-parse
//
// Variables d'environnement conseillées (Render > Environment):
//   STOP_ID=STATION_M454
//   ROUTE_SHORT_NAME=4
//   GTFS_ZIP_URL=https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip
//   TZ=America/Toronto
//
// Endpoints:
//   GET /health  -> OK
//   GET /next    -> texte (2 lignes) : "Arrive\n6 min" ou "Hors période de service\n—"
//   GET /panel   -> page web style panneau simple

const express = require("express");
const fetch = require("node-fetch"); // v2
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = process.env.PORT || 3000;

const GTFS_ZIP_URL =
  process.env.GTFS_ZIP_URL ||
  "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip";

const STOP_ID = process.env.STOP_ID || "STATION_M454";
const ROUTE_SHORT_NAME = process.env.ROUTE_SHORT_NAME || "4";

// Cache en mémoire (chargé au démarrage)
let GTFS = {
  loadedAt: null,
  routesById: new Map(),       // route_id -> route record
  tripsById: new Map(),        // trip_id -> {route_id, service_id}
  // Pour le stop visé : liste de départs théoriques par (service_id) avec heure (sec depuis minuit)
  // Map service_id -> [ { depSec, trip_id } ... ] triés
  departuresByService: new Map(),
  calendar: [],                // calendar.txt rows
  calendarDates: [],           // calendar_dates.txt rows
};

// --------- helpers temps / date (timezone safe sans lib externe) ----------
function getLocalPartsToronto(date = new Date()) {
  // Utilise l'API Intl pour produire les "parts" dans le fuseau Toronto (même que Montréal)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  // weekday: Mon/Tue...
  return {
    yyyy: obj.year,
    mm: obj.month,
    dd: obj.day,
    weekday: obj.weekday, // Mon Tue Wed Thu Fri Sat Sun
    hh: obj.hour,
    min: obj.minute,
    ss: obj.second,
  };
}

function yyyymmddToronto(date = new Date()) {
  const p = getLocalPartsToronto(date);
  return `${p.yyyy}${p.mm}${p.dd}`; // ex: 20251227
}

function secondsSinceMidnightToronto(date = new Date()) {
  const p = getLocalPartsToronto(date);
  const h = Number(p.hh);
  const m = Number(p.min);
  const s = Number(p.ss);
  return h * 3600 + m * 60 + s;
}

function weekdayKeyToronto(date = new Date()) {
  // calendar.txt uses monday/tuesday/... flags
  const wk = getLocalPartsToronto(date).weekday;
  const map = {
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday",
    Sun: "sunday",
  };
  return map[wk] || "monday";
}

function parseGtfsTimeToSeconds(t) {
  // GTFS times can be > 24:00:00 (ex 25:10:00)
  // We'll allow it by converting directly.
  if (!t || typeof t !== "string") return null;
  const [hh, mm, ss] = t.split(":").map((x) => Number(x));
  if ([hh, mm, ss].some((n) => Number.isNaN(n))) return null;
  return hh * 3600 + mm * 60 + ss;
}

function formatDeltaToLabel(deltaSec) {
  if (deltaSec < 60) return "Arrive";
  const mins = Math.round(deltaSec / 60);
  return `${mins} min`;
}

// --------- GTFS load ----------
async function downloadAndExtractGtfsZip(destDir) {
  // download zip to buffer then extract
  const resp = await fetch(GTFS_ZIP_URL, { timeout: 30000 });
  if (!resp.ok) {
    throw new Error(`GTFS zip fetch failed: ${resp.status}`);
  }

  await fs.promises.mkdir(destDir, { recursive: true });

  // Stream unzip to files (no need to keep whole zip)
  await new Promise((resolve, reject) => {
    resp.body
      .pipe(unzipper.Extract({ path: destDir }))
      .on("close", resolve)
      .on("error", reject);
  });
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
  });
}

function buildIndexesFromGtfsDir(dir) {
  const routesPath = path.join(dir, "routes.txt");
  const tripsPath = path.join(dir, "trips.txt");
  const stopTimesPath = path.join(dir, "stop_times.txt");
  const calendarPath = path.join(dir, "calendar.txt");
  const calendarDatesPath = path.join(dir, "calendar_dates.txt");

  const routes = readCsv(routesPath);
  const trips = readCsv(tripsPath);
  const calendar = fs.existsSync(calendarPath) ? readCsv(calendarPath) : [];
  const calendarDates = fs.existsSync(calendarDatesPath)
    ? readCsv(calendarDatesPath)
    : [];

  const routesById = new Map();
  for (const r of routes) routesById.set(String(r.route_id), r);

  // route filter: metro line 4 by route_short_name == "4"
  const wantedRouteIds = new Set(
    routes
      .filter((r) => String(r.route_short_name || "").trim() === String(ROUTE_SHORT_NAME))
      .map((r) => String(r.route_id))
  );

  const tripsById = new Map();
  for (const t of trips) {
    const tripId = String(t.trip_id);
    const routeId = String(t.route_id);
    if (!wantedRouteIds.has(routeId)) continue;
    tripsById.set(tripId, { route_id: routeId, service_id: String(t.service_id) });
  }

  // Build departures at the stop for those trips
  // We'll scan stop_times and keep only lines where stop_id matches AND trip_id is in tripsById
  const departuresByService = new Map();

  // stop_times is big; read+parse is simplest. Render free tier can handle once at boot.
  const stopTimes = readCsv(stopTimesPath);

  for (const st of stopTimes) {
    if (String(st.stop_id) !== String(STOP_ID)) continue;
    const tripId = String(st.trip_id);
    const trip = tripsById.get(tripId);
    if (!trip) continue;

    // prefer departure_time if present, else arrival_time
    const depTime = st.departure_time || st.arrival_time;
    const depSec = parseGtfsTimeToSeconds(depTime);
    if (depSec == null) continue;

    const sid = trip.service_id;
    if (!departuresByService.has(sid)) departuresByService.set(sid, []);
    departuresByService.get(sid).push({ depSec, trip_id: tripId });
  }

  // Sort each service list
  for (const [sid, list] of departuresByService.entries()) {
    list.sort((a, b) => a.depSec - b.depSec);
  }

  GTFS.routesById = routesById;
  GTFS.tripsById = tripsById;
  GTFS.departuresByService = departuresByService;
  GTFS.calendar = calendar;
  GTFS.calendarDates = calendarDates;
  GTFS.loadedAt = new Date().toISOString();

  console.log("GTFS loaded:", {
    routes: routes.length,
    tripsFiltered: tripsById.size,
    stopId: STOP_ID,
    routeShortName: ROUTE_SHORT_NAME,
  });
}

function activeServiceIdsForToday() {
  const today = yyyymmddToronto(new Date());
  const weekdayKey = weekdayKeyToronto(new Date());

  const active = new Set();

  // 1) calendar.txt (regular schedule)
  for (const c of GTFS.calendar) {
    const start = String(c.start_date);
    const end = String(c.end_date);
    if (today < start || today > end) continue;
    if (String(c[weekdayKey]) !== "1") continue;
    active.add(String(c.service_id));
  }

  // 2) calendar_dates.txt exceptions
  // exception_type=1 add, exception_type=2 remove
  for (const cd of GTFS.calendarDates) {
    if (String(cd.date) !== today) continue;
    const sid = String(cd.service_id);
    const ex = String(cd.exception_type);
    if (ex === "1") active.add(sid);
    if (ex === "2") active.delete(sid);
  }

  return active;
}

function nextTwoDepartures() {
  const nowSec = secondsSinceMidnightToronto(new Date());
  const activeServices = activeServiceIdsForToday();

  // Collect candidates from active services
  const candidates = [];

  for (const sid of activeServices) {
    const list = GTFS.departuresByService.get(sid);
    if (!list || list.length === 0) continue;

    // Find first departure after nowSec (binary search)
    let lo = 0, hi = list.length - 1, idx = list.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].depSec >= nowSec) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    for (let i = idx; i < Math.min(idx + 6, list.length); i++) {
      candidates.push(list[i].depSec);
    }
  }

  candidates.sort((a, b) => a - b);

  // take first 2 unique-ish (sometimes duplicates across services)
  const uniq = [];
  for (const c of candidates) {
    if (uniq.length === 0 || Math.abs(c - uniq[uniq.length - 1]) > 10) uniq.push(c);
    if (uniq.length >= 2) break;
  }

  if (uniq.length === 0) return null;

  // delta seconds from now
  const deltas = uniq.map((depSec) => Math.max(0, depSec - nowSec));
  return deltas;
}

// --------- routes ----------
app.get("/health", (req, res) => res.status(200).type("text").send("OK"));

app.get("/next", (req, res) => {
  try {
    const deltas = nextTwoDepartures();

    if (!deltas || deltas.length === 0) {
      return res.type("text").send("Hors période de service\n—");
    }

    const line1 = formatDeltaToLabel(deltas[0]);
    const line2 = deltas[1] != null ? formatDeltaToLabel(deltas[1]) : "—";
    return res.type("text").send(`${line1}\n${line2}`);
  } catch (e) {
    console.error(e);
    return res.status(500).type("text").send("Données indisponibles\n—");
  }
});

app.get("/panel", (req, res) => {
  const deltas = nextTwoDepartures();
  const l1 = deltas && deltas[0] != null ? formatDeltaToLabel(deltas[0]) : "—";
  const l2 = deltas && deltas[1] != null ? formatDeltaToLabel(deltas[1]) : "—";
  res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Métro — Longueuil</title>
<style>
  body{margin:0;background:#000;color:#FFD200;font-family:Arial,Helvetica,sans-serif}
  .wrap{padding:18px}
  .h1{font-size:20px;font-weight:700;margin-bottom:6px}
  .sub{color:#fff;opacity:.9;margin-bottom:18px}
  .row{display:flex;align-items:center;gap:10px;font-size:44px;margin:14px 0}
  .rt{width:18px;height:18px;border-radius:50%;background:#FFD200;animation:pulse 1.4s infinite}
  @keyframes pulse{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}
  .foot{color:#fff;opacity:.8;margin-top:18px;font-size:13px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="h1">MÉTRO — LONGUEUIL–UdeS</div>
    <div class="sub">Direction Berri-UQAM (horaire théorique)</div>

    <div class="row"><span class="rt"></span><span>${l1}</span></div>
    <div class="row"><span class="rt"></span><span>${l2}</span></div>

    <div class="foot">STOP_ID: ${STOP_ID} • GTFS chargé: ${GTFS.loadedAt || "—"}</div>
  </div>
</body>
</html>`);
});

// --------- bootstrap ----------
async function boot() {
  const workDir = "/tmp/gtfs_stm";
  try {
    console.log("Downloading GTFS zip from:", GTFS_ZIP_URL);
    await downloadAndExtractGtfsZip(workDir);
    buildIndexesFromGtfsDir(workDir);
    console.log("Serveur STM (GTFS théorique) lancé");
  } catch (e) {
    console.error("GTFS boot failed:", e);
    // We still start server so /health responds and /next returns "Données indisponibles"
  }

  app.listen(PORT, () => {
    console.log("Listening on", PORT);
  });
}

boot();
