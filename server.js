const express = require("express");
const fetch = require("node-fetch");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = process.env.PORT || 3000;

// GTFS officiel STM (planifié)
const GTFS_URL = "http://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip";

// On vise la ligne jaune (route_id "4").
// Dans le GTFS STM, le métro est surtout décrit par fréquences (frequencies.txt).
let frequencies = []; // rows of frequencies.txt
let trips = [];       // rows of trips.txt
let routes = [];      // rows of routes.txt
let calendar = [];    // rows of calendar.txt
let calendarDates = []; // rows of calendar_dates.txt

function hhmmssToSec(t) {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}
function secToMinCeil(seconds) {
  return Math.max(0, Math.ceil(seconds / 60));
}
function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function weekdayIndex() {
  // JS: 0 Sunday .. 6 Saturday, GTFS: monday..sunday
  const js = new Date().getDay();
  return js === 0 ? "sunday" : ["monday","tuesday","wednesday","thursday","friday","saturday"][js-1];
}

function isServiceActive(service_id) {
  const today = todayYYYYMMDD();
  const wd = weekdayIndex();

  // Exceptions first (calendar_dates)
  const ex = calendarDates.find(r => r.service_id === service_id && r.date === today);
  if (ex) {
    // exception_type: 1 = added, 2 = removed
    return ex.exception_type === "1";
  }

  const c = calendar.find(r => r.service_id === service_id);
  if (!c) return false;

  if (today < c.start_date || today > c.end_date) return false;
  return c[wd] === "1";
}

async function loadGtfs() {
  const resp = await fetch(GTFS_URL);
  if (!resp.ok) throw new Error(`GTFS download failed: ${resp.status}`);
  const buf = await resp.buffer();

  const zip = new AdmZip(buf);
  const getCsv = (name) => {
    const entry = zip.getEntry(name);
    if (!entry) return [];
    const text = entry.getData().toString("utf8");
    return parse(text, { columns: true, skip_empty_lines: true });
  };

  // fichiers principaux
  routes = getCsv("routes.txt");
  trips = getCsv("trips.txt");
  frequencies = getCsv("frequencies.txt");
  calendar = getCsv("calendar.txt");
  calendarDates = getCsv("calendar_dates.txt");

  console.log("GTFS loaded:", {
    routes: routes.length,
    trips: trips.length,
    frequencies: frequencies.length
  });
}

// Retourne la meilleure fréquence planifiée pour route_id=4, maintenant
function getHeadwaySecondsForYellowLineNow() {
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  // trouver route_id "4"
  const route = routes.find(r => String(r.route_id) === "4" || String(r.route_short_name) === "4");
  if (!route) return null;

  // trouver des trips de cette route
  const tripIds = new Set(
    trips
      .filter(t => String(t.route_id) === String(route.route_id))
      .filter(t => isServiceActive(t.service_id))
      .map(t => String(t.trip_id))
  );

  if (tripIds.size === 0) return null;

  // filter frequencies rows for those trip_ids and current time
  const candidates = frequencies
    .filter(f => tripIds.has(String(f.trip_id)))
    .map(f => ({
      start: hhmmssToSec(f.start_time),
      end: hhmmssToSec(f.end_time),
      headway: Number(f.headway_secs)
    }))
    .filter(f => nowSec >= f.start && nowSec <= f.end)
    .sort((a,b) => a.headway - b.headway);

  if (candidates.length === 0) return null;
  return candidates[0].headway; // smallest headway (most frequent) at this time
}

// Calcule 2 prochains passages théoriques à partir de headway (fréquence)
function computeNextTwoFromHeadway(headway) {
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  const next1 = headway - (nowSec % headway);
  const next2 = next1 + headway;

  const fmt = (sec) => {
    if (sec < 60) return "Arrive";
    return `${secToMinCeil(sec)} min`;
  };

  return [fmt(next1), fmt(next2)];
}

// Endpoint texte pour raccourci iPhone
app.get("/next", async (req, res) => {
  try {
    const headway = getHeadwaySecondsForYellowLineNow();
    if (!headway) return res.type("text").send("Données indisponibles\n—");

    const [a, b] = computeNextTwoFromHeadway(headway);
    res.type("text").send(`${a}\n${b}`);
  } catch (e) {
    console.error(e);
    res.status(500).type("text").send("Données indisponibles\n—");
  }
});

// Page “panneau” simple (QR)
app.get("/panel", async (req, res) => {
  const headway = getHeadwaySecondsForYellowLineNow();
  const next = headway ? computeNextTwoFromHeadway(headway) : ["—", "—"];

  res.send(`
  <html>
    <head><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
    <body style="margin:0;background:black;color:#FFD200;font-family:Arial;padding:20px">
      <div style="color:white;font-size:18px;margin-bottom:6px">MÉTRO – LONGUEUIL–UdeS</div>
      <div style="color:#ddd;font-size:16px;margin-bottom:18px">Direction Berri-UQAM (théorique GTFS)</div>
      <div style="display:flex;align-items:center;gap:10px;font-size:46px;margin-bottom:16px">
        <span style="width:18px;height:18px;border-radius:50%;background:#FFD200;display:inline-block"></span>
        <span>${next[0]}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;font-size:46px">
        <span style="width:18px;height:18px;border-radius:50%;background:#FFD200;display:inline-block"></span>
        <span>${next[1]}</span>
      </div>
      <div style="color:#aaa;font-size:12px;margin-top:18px">Source: GTFS planifié STM</div>
    </body>
  </html>
  `);
});

app.get("/", (req, res) => res.redirect("/panel"));

(async () => {
  try {
    await loadGtfs();
    app.listen(PORT, () => console.log("Serveur STM (GTFS théorique) lancé"));
  } catch (e) {
    console.error("Failed to start:", e);
    // On démarre quand même (pour avoir une réponse claire)
    app.listen(PORT, () => console.log("Serveur lancé mais GTFS indisponible"));
  }
})();
