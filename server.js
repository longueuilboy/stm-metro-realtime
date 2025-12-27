/**
 * STM Metro (théorique) — 2 prochains passages
 * - Sans clé API
 * - Télécharge le GTFS statique STM en ligne (ZIP)
 * - Calcule les départs métro via frequencies.txt (métro = fréquences dans le GTFS STM)
 *
 * Endpoints:
 *   GET /health  -> "ok"
 *   GET /next    -> texte 2 lignes ("Arrive\n6 min" ou "Hors période de service\n—")
 *   GET /panel   -> page HTML style panneau
 */

const express = require("express");
const fetch = require("node-fetch");
const unzipper = require("unzipper");
const csv = require("csv-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// URL stable du GTFS statique STM
const GTFS_ZIP_URL =
  process.env.GTFS_ZIP_URL || "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip";

// Paramètres pour ton cas
const ROUTE_ID = "4";            // ligne jaune = 4 (souvent route_id "4" dans GTFS)
const DIRECTION_ID = "0";        // direction vers Montréal (souvent 0/1)
const TIMEZONE = "America/Toronto";

// Petite cache en mémoire (très légère)
let cache = {
  loadedAt: 0,
  // services actifs pour aujourd'hui (set)
  activeServiceIds: new Set(),
  // trip_ids (ligne 4 + direction + service actif)
  tripIds: new Set(),
  // liste de blocs de fréquence pertinents [{startSec,endSec,headwaySec}]
  freqBlocks: [],
  // date YYYYMMDD pour laquelle le cache est calculé
  ymd: "",
};

function torontoNowParts() {
  // Extraire proprement date/heure à Toronto sans dépendance externe
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const weekday = get("weekday"); // "Mon", "Tue", ...

  const ymd = `${year}${month}${day}`; // YYYYMMDD
  const secSinceMidnight = Number(hour) * 3600 + Number(minute) * 60 + Number(second);

  return { ymd, weekday, secSinceMidnight };
}

function weekdayToCalendarField(weekdayShort) {
  // GTFS calendar.txt: monday..sunday (0/1)
  const map = {
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday",
    Sun: "sunday",
  };
  return map[weekdayShort] || "monday";
}

function parseTimeToSec(t) {
  // GTFS time peut dépasser 24:00:00, ex 25:12:00
  // On accepte ça (secondes depuis minuit)
  const [hh, mm, ss] = String(t).split(":").map(Number);
  return hh * 3600 + mm * 60 + ss;
}

async function streamCsvFromZip(zipStream, filename, onRow) {
  // Ouvre une entrée du zip et stream les lignes CSV
  const directory = await unzipper.Open.stream(zipStream);
  const file = directory.files.find((f) => f.path.toLowerCase() === filename.toLowerCase());
  if (!file) throw new Error(`Fichier manquant dans GTFS: ${filename}`);

  return new Promise((resolve, reject) => {
    file
      .stream()
      .pipe(csv())
      .on("data", onRow)
      .on("end", resolve)
      .on("error", reject);
  });
}

async function downloadGtfsZipStream() {
  const resp = await fetch(GTFS_ZIP_URL, { timeout: 20000 });
  if (!resp.ok) throw new Error(`GTFS download failed: ${resp.status}`);
  return resp.body; // stream
}

async function rebuildCacheIfNeeded() {
  const { ymd, weekday } = torontoNowParts();
  const cacheFresh = cache.ymd === ymd && (Date.now() - cache.loadedAt) < 6 * 60 * 60 * 1000; // 6h
  if (cacheFresh) return;

  // Reset cache
  cache = {
    loadedAt: Date.now(),
    activeServiceIds: new Set(),
    tripIds: new Set(),
    freqBlocks: [],
    ymd,
  };

  const weekdayField = weekdayToCalendarField(weekday);

  // Télécharge une fois, puis on re-télécharge pour chaque fichier (simple + robuste en streaming)
  // (On évite de stocker le zip entier en RAM)
  // 1) calendar.txt -> services actifs selon la date + jour de semaine
  {
    const zipStream = await downloadGtfsZipStream();
    await streamCsvFromZip(zipStream, "calendar.txt", (row) => {
      // calendar.txt: service_id, monday..sunday, start_date, end_date
      if (!row.service_id) return;
      const inRange = row.start_date <= ymd && ymd <= row.end_date;
      const runsToday = row[weekdayField] === "1";
      if (inRange && runsToday) cache.activeServiceIds.add(row.service_id);
    });
  }

  // 2) calendar_dates.txt -> exceptions (add/remove)
  {
    const zipStream = await downloadGtfsZipStream();
    await streamCsvFromZip(zipStream, "calendar_dates.txt", (row) => {
      // exception_type: 1=added, 2=removed
      if (row.date !== ymd) return;
      if (row.exception_type === "1") cache.activeServiceIds.add(row.service_id);
      if (row.exception_type === "2") cache.activeServiceIds.delete(row.service_id);
    });
  }

  // 3) trips.txt -> trip_ids route=4, direction=0, service_id actif
  // On garde un set de trip_ids pertinents (faible pour une seule ligne)
  {
    const zipStream = await downloadGtfsZipStream();
    await streamCsvFromZip(zipStream, "trips.txt", (row) => {
      if (!row.trip_id || !row.route_id || !row.service_id) return;
      if (row.route_id !== ROUTE_ID) return;
      if (String(row.direction_id ?? "") !== DIRECTION_ID) return;
      if (!cache.activeServiceIds.has(row.service_id)) return;
      cache.tripIds.add(row.trip_id);
    });
  }

  // 4) frequencies.txt -> blocs de fréquence pour ces trip_ids
  // frequencies.txt: trip_id,start_time,end_time,headway_secs,exact_times
  {
    const zipStream = await downloadGtfsZipStream();
    await streamCsvFromZip(zipStream, "frequencies.txt", (row) => {
      if (!row.trip_id || !row.start_time || !row.end_time || !row.headway_secs) return;
      if (!cache.tripIds.has(row.trip_id)) return;

      const startSec = parseTimeToSec(row.start_time);
      const endSec = parseTimeToSec(row.end_time);
      const headwaySec = Number(row.headway_secs);

      if (Number.isFinite(startSec) && Number.isFinite(endSec) && Number.isFinite(headwaySec) && headwaySec > 0) {
        cache.freqBlocks.push({ startSec, endSec, headwaySec });
      }
    });
  }

  // Si aucun bloc, on ne pourra rien afficher
  cache.freqBlocks.sort((a, b) => a.startSec - b.startSec);
}

function computeNextTwoDepartures() {
  const { secSinceMidnight } = torontoNowParts();

  const candidates = [];
  for (const b of cache.freqBlocks) {
    // Si on est avant la fenêtre
    if (secSinceMidnight <= b.startSec) {
      candidates.push(b.startSec);
      continue;
    }
    // Si on est après la fenêtre
    if (secSinceMidnight > b.endSec) continue;

    // On est dans la fenêtre: prochain départ = start + ceil((now-start)/headway)*headway
    const k = Math.ceil((secSinceMidnight - b.startSec) / b.headwaySec);
    const next = b.startSec + k * b.headwaySec;
    if (next <= b.endSec) candidates.push(next);
  }

  candidates.sort((a, b) => a - b);

  // On prend les 2 plus proches, et si le 2e manque, on essaie le suivant à +headway
  const nextTwo = [];
  for (let i = 0; i < candidates.length && nextTwo.length < 2; i++) {
    const t = candidates[i];
    if (!nextTwo.includes(t)) nextTwo.push(t);
  }

  // Si on n'a qu'un seul, on tente de générer un second à partir du même bloc (approx)
  if (nextTwo.length === 1) {
    // essaye le +headway à partir d'un bloc qui contient ce temps
    const t1 = nextTwo[0];
    const block = cache.freqBlocks.find((b) => t1 >= b.startSec && t1 <= b.endSec);
    if (block) {
      const t2 = t1 + block.headwaySec;
      if (t2 <= block.endSec) nextTwo.push(t2);
    }
  }

  return nextTwo;
}

function formatAsArriveOrMinutes(departSec) {
  const { secSinceMidnight } = torontoNowParts();
  const delta = departSec - secSinceMidnight;
  if (delta <= 60) return "Arrive";
  const mins = Math.round(delta / 60);
  return `${mins} min`;
}

// Healthcheck utile pour Render
app.get("/health", (req, res) => res.type("text").send("ok"));

app.get("/next", async (req, res) => {
  try {
    await rebuildCacheIfNeeded();

    const nextTimes = computeNextTwoDepartures();

    if (!nextTimes.length) {
      return res.type("text").send("Hors période de service\n—");
    }

    const line1 = formatAsArriveOrMinutes(nextTimes[0]);
    const line2 = nextTimes[1] ? formatAsArriveOrMinutes(nextTimes[1]) : "—";
    res.type("text").send(`${line1}\n${line2}`);
  } catch (e) {
    console.error(e);
    res.status(500).type("text").send("Données indisponibles\n—");
  }
});

app.get("/panel", async (req, res) => {
  let l1 = "—", l2 = "—";
  try {
    await rebuildCacheIfNeeded();
    const nextTimes = computeNextTwoDepartures();
    if (!nextTimes.length) {
      l1 = "Hors période de service";
      l2 = "—";
    } else {
      l1 = formatAsArriveOrMinutes(nextTimes[0]);
      l2 = nextTimes[1] ? formatAsArriveOrMinutes(nextTimes[1]) : "—";
    }
  } catch {
    l1 = "Données indisponibles";
    l2 = "—";
  }

  res.send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Métro – Ligne jaune</title>
<style>
  body{margin:0;background:#000;color:#FFD200;font-family:Arial,Helvetica,sans-serif}
  .wrap{padding:18px}
  .h{font-size:20px;font-weight:700;margin-bottom:6px}
  .sub{color:#fff;font-size:16px;margin-bottom:18px}
  .row{display:flex;align-items:center;gap:10px;font-size:44px;margin:14px 0}
  .rt{width:18px;height:18px;border-radius:50%;background:#FFD200;animation:pulse 1.5s infinite}
  @keyframes pulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}
  .foot{color:#fff;font-size:12px;margin-top:18px;opacity:.85}
</style>
</head>
<body>
  <div class="wrap">
    <div class="h">MÉTRO – LONGUEUIL–UdeS</div>
    <div class="sub">Direction Berri-UQAM (horaire théorique)</div>
    <div class="row"><span class="rt"></span><span>${l1}</span></div>
    <div class="row"><span class="rt"></span><span>${l2}</span></div>
    <div class="foot">Source: GTFS statique STM (${cache.ymd})</div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log("Serveur STM (GTFS théorique) lancé");
  console.log("GTFS ZIP:", GTFS_ZIP_URL);
});
