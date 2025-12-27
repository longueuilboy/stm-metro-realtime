const express = require("express");
const fetch = require("node-fetch");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIGURATION ===
const STM_API_KEY = process.env.STM_API_KEY;

// Ligne jaune – métro
const GTFS_RT_URL =
  "https://api.stm.info/pub/od/gtfs-rt/metro/tripupdates.pb";

// Stop ID Longueuil–UdeS (ligne jaune direction Berri-UQAM)
const STOP_ID = "UdeS"; // simplifié, on filtre par ligne/direction

// ======================

async function getNextMetros() {
  const response = await fetch(GTFS_RT_URL, {
    headers: {
      "Ocp-Apim-Subscription-Key": STM_API_KEY
    }
  });

  const buffer = await response.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  const now = Math.floor(Date.now() / 1000);

  const times = [];

  feed.entity.forEach(entity => {
    if (!entity.tripUpdate) return;

    const trip = entity.tripUpdate.trip;

    // Ligne jaune uniquement
    if (trip.routeId !== "4") return;

    entity.tripUpdate.stopTimeUpdate.forEach(stop => {
      if (!stop.departure || !stop.departure.time) return;

      const delta = stop.departure.time - now;
      if (delta > 0 && delta < 3600) {
        times.push(delta);
      }
    });
  });

  times.sort((a, b) => a - b);

  return times.slice(0, 2).map(sec => {
    if (sec < 60) return "Arrive";
    return `${Math.round(sec / 60)} min`;
  });
}

// === ENDPOINT POUR IPHONE / QR ===
app.get("/next", async (req, res) => {
  try {
    const next = await getNextMetros();
    res.type("text").send(next.join("\n"));
  } catch (err) {
    console.error(err);
    res.status(500).send("Données indisponibles");
  }
});

// === PAGE SIMPLE (optionnelle, pour QR / test) ===
app.get("/panel", async (req, res) => {
  const next = await getNextMetros();
  res.send(`
    <html>
      <body style="background:black;color:#FFD200;font-family:Arial;padding:20px">
        <h2>MÉTRO – LONGUEUIL–UdeS</h2>
        <p>Direction Berri-UQAM</p>
        <h1>${next[0] || "-"}</h1>
        <h1>${next[1] || "-"}</h1>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log("Serveur STM lancé");
});
