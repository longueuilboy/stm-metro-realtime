const express = require("express");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = process.env.PORT || 3000;

// GTFS planifié STM (zip officiel)
const GTFS_ZIP_URL = "http://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip";

// Ligne jaune
const ROUTE_ID = "4";
const TARGET_HEADSIGN = "Berri"; // on cherche une destination contenant “Berri” (Berri-UQAM)

// Cache en mémoire (on recharge de temps en temps)
let gtfs = null;
let gtfsLoadedAt = 0;
const GTFS_CACHE_MS = 6 * 60 * 60 * 1000; // 6h

function nowMontrealDate() {
  // Render tourne souvent en UTC; on reste simple: on utilise l’heure locale du serveur
  // (si tu veux, on peut forcer America/Toronto plus tard)
  return new Date();
}

function hhmmssToSeconds(s) {
  // ex: "13:05:00" (GTFS permet >24h pour services de nuit)
  const [h, m, sec] = s.split(":").map(Number);
  return (h * 3600) + (m * 60) + (sec || 0);
}

function secondsSinceMidnight(d) {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function parseCsvFromZip(zip, filename) {
  const entry = zip.getEntry(filename);
  if (!entry) return [];
  const txt = zip.readAsText(entry);
  return parse(txt, { columns: true, skip_empty_lines: true });
}

async function loadGtfsIfNeeded() {
  const now = Date.now();
  if (gtfs && (now - gtfsLoadedAt) < GTFS_CACHE_MS) return;

  const buf = await downloadBuffer(GTFS_ZIP_URL);
  const zip = new AdmZip(buf);

  const routes = parseCsvFromZip(zip, "routes.txt");
  const trips = parseCsvFromZip(zip, "trips.txt");
  const frequencies = parseCsvFromZip(zip, "frequencies.txt");
  const calendar = parseCsvFromZip(zip, "calendar.txt");
  const calendarDates = parseCsvFromZip(zip, "calendar_dates.txt");

  gtfs = { routes, trips, frequencies, calendar, calendarDates };
  gtfsLoadedAt = now;
}

// Détermine si un service_id est actif aujourd’hui (calendar + calendar_dates)
function isServiceActive(serviceId, dateStr, jsDate, calendar, calendarDates) {
  // exceptions (calendar_dates) d’abord
  const ex = calendarDates.filter(r => r.service_id === serviceId && r.date === dateStr);
  // exception_type: 1 = ajouté, 2 = supprimé
  if (ex.some(r => r.exception_type === "2")) return false;
  if (ex.some(r => r.exception_type === "1")) return true;

  // sinon calendar.txt
  const cal = calendar.find(r => r.service_id === serviceId);
  if (!cal) return false;

  if (dateStr < cal.start_date || dateStr > cal.end_date) return false;

  const dow = jsDate.getDay(); // 0=dim
  const map = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  return cal[map[dow]] === "1";
}

function pickMetroTripForRoute(trips) {
  // On prend un trip de la route 4 dont le headsign contient “Berri”
  const candidates = trips.filter(t =>
    String(t.route_id) === ROUTE_ID &&
    (t.trip_headsign || "").toLowerCase().includes(TARGET_HEADSIGN.toLowerCase())
  );
  return candidates[0] || null;
}

function getCurrentHeadwaySeconds(gtfsData, jsDate) {
  const { trips, frequencies, calendar, calendarDates } = gtfsData;

  const trip = pickMetroTripForRoute(trips);
  if (!trip) throw new Error("Trip métro ligne 4 introuvable dans le GTFS.");

  const serviceId = trip.service_id;
  const dateStr = yyyymmdd(jsDate);
  if (!isServiceActive(serviceId, dateStr, jsDate, calendar, calendarDates)) {
    // service pas actif (ex: fermeture de nuit), on renvoie null
    return null;
  }

  const tSec = secondsSinceMidnight(jsDate);

  // Cherche une entrée frequencies qui couvre l’heure actuelle pour CE trip
  const freq = frequencies.find(f =>
    f.trip_id === trip.trip_id &&
    hhmmssToSeconds(f.start_time) <= tSec &&
    tSec < hhmmssToSeconds(f.end_time)
  );

  if (!freq) return null;
  return Number(freq.headway_secs);
}

function computeNextTwoFromHeadway(headwaySec) {
  if (!headwaySec || headwaySec <= 0) return ["Données indisponibles", "—"];

  // Sans heure exacte, on estime: prochain = dans [0..headway)
  // Pour une estimation stable, on ancre sur l'horloge unix
  const now = Math.floor(Date.now() / 1000);
  const mod = now % headwaySec;
  const nextIn = (headwaySec - mod) % headwaySec; // 0..headway-1
  const next2In = nextIn + headwaySec;

  const format = (sec) => {
    if (sec < 60) return "Arrive";
    const min = Math.round(sec / 60);
    return `~${min} min`;
  };

  return [format(nextIn), format(next2In)];
}

// Endpoint Siri (texte brut sur 2 lignes)
app.get("/next", async (req, res) => {
  try {
    await loadGtfsIfNeeded();
    const headway = getCurrentHeadwaySeconds(gtfs, nowMontrealDate());
    const nextTwo = computeNextTwoFromHeadway(headway);
    res.type("text").send(nextTwo.join("\n"));
  } catch (e) {
    console.error(e);
    res.status(500).type("text").send("Données indisponibles\n—");
  }
});

// Panel simple (pour QR / écran)
app.get("/panel", async (req, res) => {
  try {
    await loadGtfsIfNeeded();
    const headway = getCurrentHeadwaySeconds(gtfs, nowMontrealDate());
    const nextTwo = computeNextTwoFromHeadway(headway);
    res.send(`
      <html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
      <body style="background:black;color:#FFD200;font-family:Arial;padding:20px">
        <div style="font-size:18px;color:white">Métro – Ligne jaune (estimé)</div>
        <div style="font-size:22px;margin-top:6px">Longueuil–UdeS → Berri-UQAM</div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:18px;font-size:54px">
          <span style="width:16px;height:16px;border-radius:50%;background:#FFD200;display:inline-block"></span>
          <span>${nextTwo[0]}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:10px;font-size:54px">
          <span style="width:16px;height:16px;border-radius:50%;background:#FFD200;display:inline-block"></span>
          <span>${nextTwo[1]}</span>
        </div>
        <div style="margin-top:16px;color:white;font-size:13px">Source: GTFS planifié STM (fréquences métro)</div>
      </body></html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send("Données indisponibles");
  }
});

app.get("/", (req, res) => res.redirect("/panel"));

app.listen(PORT, () => console.log("Serveur STM lancé (GTFS planifié)"));
