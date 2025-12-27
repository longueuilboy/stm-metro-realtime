const express = require("express");
const fetch = require("node-fetch");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");

const app = express();
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;

// GTFS STM officiel (statique)
const GTFS_ZIP_URL = "http://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"; // :contentReference[oaicite:2]{index=2}

// Dossier de travail sur Render
const GTFS_DIR = "/tmp/gtfs_stm";

// Helpers CSV
function parseCSV(filePath) {
  const txt = fs.readFileSync(filePath, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split(",");
  return lines.map(line => {
    // simple split CSV (ok for STM GTFS in practice for these files)
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => (obj[h] = cols[i]));
    return obj;
  });
}

function hmsToSeconds(hms) {
  const [h, m, s] = hms.split(":").map(Number);
  return (h * 3600) + (m * 60) + (s || 0);
}

function secondsToMinRange(headwaySec) {
  const m = Math.max(1, Math.round(headwaySec / 60));
  return `0–${m} min`;
}

// ---- GTFS load (download + unzip) ----
let GTFS = null;

async function downloadAndUnzipGTFS() {
  fs.mkdirSync(GTFS_DIR, { recursive: true });

  const zipPath = path.join(GTFS_DIR, "gtfs_stm.zip");
  const res = await fetch(GTFS_ZIP_URL);
  if (!res.ok) throw new Error("Download GTFS failed: " + res.status);

  const fileStream = fs.createWriteStream(zipPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  // unzip
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: GTFS_DIR }))
    .promise();

  // Load only what we need
  const routes = parseCSV(path.join(GTFS_DIR, "routes.txt"));
  const trips = parseCSV(path.join(GTFS_DIR, "trips.txt"));
  const frequencies = fs.existsSync(path.join(GTFS_DIR, "frequencies.txt"))
    ? parseCSV(path.join(GTFS_DIR, "frequencies.txt"))
    : [];
  const calendar = fs.existsSync(path.join(GTFS_DIR, "calendar.txt"))
    ? parseCSV(path.join(GTFS_DIR, "calendar.txt"))
    : [];

  GTFS = { routes, trips, frequencies, calendar };
  console.log("GTFS loaded:", {
    routes: routes.length,
    trips: trips.length,
    frequencies: frequencies.length
  });
}

// Determine active service_id today (very simple)
function getTodayServiceIds(calendar) {
  // Render is UTC by default; set TZ in Render to America/Toronto (see step 2)
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const yyyymmdd = `${y}${m}${d}`;

  const weekday = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][now.getDay()];

  return calendar
    .filter(r => r.start_date <= yyyymmdd && r.end_date >= yyyymmdd && r[weekday] === "1")
    .map(r => r.service_id);
}

// Find headway for line 4 around now using frequencies.txt
function getYellowLineHeadway(nowSec) {
  if (!GTFS) throw new Error("GTFS not loaded yet");

  const serviceIds = getTodayServiceIds(GTFS.calendar);

  // route_id "4" (ligne jaune) — on prend les trips route_id=4 et service_id actif
  const tripIds = new Set(
    GTFS.trips
      .filter(t => t.route_id === "4" && serviceIds.includes(t.service_id))
      .map(t => t.trip_id)
  );

  // Find frequencies rows matching these trips and current time window
  const matches = GTFS.frequencies
    .filter(f => tripIds.has(f.trip_id))
    .map(f => ({
      start: hmsToSeconds(f.start_time),
      end: hmsToSeconds(f.end_time),
      headway: Number(f.headway_secs)
    }))
    .filter(f => nowSec >= f.start && nowSec <= f.end);

  if (!matches.length) return null;

  // Use the smallest headway (best case)
  matches.sort((a, b) => a.headway - b.headway);
  return matches[0].headway;
}

// ---- endpoints ----
app.get("/next", async (req, res) => {
  try {
    if (!GTFS) {
      return res.status(503).type("text").send("Données indisponibles\n—");
    }

    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    const headway = getYellowLineHeadway(nowSec);
    if (!headway) {
      return res.type("text").send("Hors période de service\n—");
    }

    // On affiche 2 “prochains” estimés par fréquence
    const first = `≈ dans ${secondsToMinRange(headway)}`;
    const second = `≈ dans ${Math.round(headway/60)}–${Math.round((2*headway)/60)} min`;

    res.type("text").send(`${first}\n${second}`);
  } catch (e) {
    console.error("ERROR /next:", e);
    res.status(500).type("text").send("Données indisponibles\n—");
  }
});

// Page simple (utile pour QR)
app.get("/panel", async (req, res) => {
  const r = await fetch(`${req.protocol}://${req.get("host")}/next`);
  const txt = await r.text();
  const [a,b] = txt.split("\n");
  res.send(`
    <html>
      <body style="background:black;color:#FFD200;font-family:Arial;padding:20px">
        <div style="color:white;margin-bottom:8px">MÉTRO — Ligne jaune</div>
        <div style="color:white;margin-bottom:16px">Longueuil–UdeS → Berri-UQAM</div>
        <div style="font-size:44px;margin:12px 0">● ${a || "-"}</div>
        <div style="font-size:44px;margin:12px 0">● ${b || "-"}</div>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => res.json({ ok: true, gtfsLoaded: !!GTFS }));

downloadAndUnzipGTFS()
  .then(() => console.log("Serveur STM (GTFS théorique – fréquence métro) lancé"))
  .catch(err => console.error("GTFS init failed:", err));

app.listen(PORT, () => console.log("Listening on", PORT));
