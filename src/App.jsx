import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import * as turf from "@turf/turf";

const KEY = import.meta.env.VITE_GEOAPIFY_KEY;
const API = "https://api.geoapify.com/v1";
const COLORS = { a: "#2B6CB0", b: "#D9822B", both: "#1F9D6B" };
const MODES = [
  { id: "drive", label: "Drive" },
  { id: "bicycle", label: "Bike" },
  { id: "walk", label: "Walk" },
];

async function geocode(text) {
  const url = `${API}/geocode/search?text=${encodeURIComponent(text)}&limit=1&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Address lookup failed. Check your API key.");
  const data = await res.json();
  const hit = data.features?.[0];
  if (!hit) throw new Error(`Couldn't find "${text}". Try adding a city or state.`);
  return { lng: hit.geometry.coordinates[0], lat: hit.geometry.coordinates[1], label: hit.properties.formatted };
}

async function isochrone(point, mode, minutes) {
  const url = `${API}/isoline?lat=${point.lat}&lon=${point.lng}&type=time&mode=${mode}&range=${minutes * 60}&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Travel-time lookup failed. Check your API key or try a shorter time.");
  const data = await res.json();
  return data.features[0];
}

async function fetchRestaurants(overlap) {
  const [minX, minY, maxX, maxY] = turf.bbox(overlap);
  const c = turf.centroid(overlap).geometry.coordinates;
  const url =
    `https://api.geoapify.com/v2/places?categories=catering.restaurant` +
    `&filter=rect:${minX},${minY},${maxX},${maxY}` +
    `&bias=proximity:${c[0]},${c[1]}&limit=200&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Restaurant lookup failed (error ${res.status}).`);
  const data = await res.json();
  return (data.features || [])
    .filter((f) => f.properties.name && turf.booleanPointInPolygon(f.geometry, overlap))
    .map((f) => {
      const cuisine = f.properties.catering?.cuisine || f.properties.datasource?.raw?.cuisine || "";
      return {
        name: f.properties.name,
        address: f.properties.address_line2 || "",
        cuisine: cuisine.split(";")[0].replace(/_/g, " "),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      };
    });
}

export default function App() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [mode, setMode] = useState("drive");
  const [status, setStatus] = useState({ kind: "idle" });
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const foodLayer = useRef(null);
  const [restaurants, setRestaurants] = useState([]);
  const [foodNote, setFoodNote] = useState("");
  const [showFood, setShowFood] = useState(true);

  useEffect(() => {
    map.current = L.map(mapEl.current).setView([42.75, -71.4], 8);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    foodLayer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);

  useEffect(() => {
    if (!map.current || !foodLayer.current) return;
    if (showFood) map.current.addLayer(foodLayer.current);
    else map.current.removeLayer(foodLayer.current);
  }, [showFood]);

  async function run(e) {
    e.preventDefault();
    if (!KEY) return setStatus({ kind: "error", message: "Missing API key. Add VITE_GEOAPIFY_KEY to your .env file." });
    if (!a.trim() || !b.trim()) return setStatus({ kind: "error", message: "Enter both locations." });
    setStatus({ kind: "loading" });
    try {
      const [pa, pb] = await Promise.all([geocode(a), geocode(b)]);
      const [za, zb] = await Promise.all([isochrone(pa, mode, minutes), isochrone(pb, mode, minutes)]);
      const overlap = turf.intersect(za, zb);

      layer.current.clearLayers();
      foodLayer.current.clearLayers();
      setRestaurants([]);
      setFoodNote("");
      const style = (color, fill) => ({ color, weight: 2, fillColor: color, fillOpacity: fill });
      L.geoJSON(za, { style: style(COLORS.a, 0.12) }).addTo(layer.current);
      L.geoJSON(zb, { style: style(COLORS.b, 0.12) }).addTo(layer.current);
      if (overlap) L.geoJSON(overlap, { style: style(COLORS.both, 0.5) }).addTo(layer.current);
      [[pa, COLORS.a, "A"], [pb, COLORS.b, "B"]].forEach(([p, c, n]) =>
        L.circleMarker([p.lat, p.lng], { radius: 8, color: "#fff", weight: 2, fillColor: c, fillOpacity: 1 })
          .bindTooltip(`${n}: ${p.label}`)
          .addTo(layer.current)
      );
      const bounds = L.geoJSON(za).getBounds().extend(L.geoJSON(zb).getBounds());
      map.current.fitBounds(bounds, { padding: [30, 30] });

      if (overlap) {
        try {
          const food = await fetchRestaurants(overlap);
          food.forEach((r) =>
            L.circleMarker([r.lat, r.lng], { radius: 5, color: "#fff", weight: 1, fillColor: "#B8423A", fillOpacity: 1 })
              .bindTooltip(r.cuisine ? `${r.name} (${r.cuisine})` : r.name)
              .addTo(foodLayer.current)
          );
          setRestaurants(food);
          if (food.length === 0) setFoodNote("No restaurants found inside the overlap area.");
        } catch (err) {
          setFoodNote(err.message);
        }
        const sqMi = turf.area(overlap) / 2589988.11;
        setStatus({ kind: "ok", message: `Overlap found: about ${Math.round(sqMi).toLocaleString()} sq mi where you're each within ${minutes} min.` });
      } else {
        setStatus({ kind: "none", message: `No overlap at ${minutes} min. Try a longer time.` });
      }
    } catch (err) {
      setStatus({ kind: "error", message: err.message });
    }
  }

  return (
    <div className="app">
      <aside className="panel">
        <h1>Midl</h1>
        <p className="lede">Find where two people can meet or live within a set travel time of both.</p>
        <form onSubmit={run}>
          <label>
            <span><i className="dot" style={{ background: COLORS.a }} /> Location A</span>
            <input value={a} onChange={(e) => setA(e.target.value)} placeholder="Street address or city" />
          </label>
          <label>
            <span><i className="dot" style={{ background: COLORS.b }} /> Location B</span>
            <input value={b} onChange={(e) => setB(e.target.value)} placeholder="Street address or city" />
          </label>
          <label>
            <span>Max travel time: {minutes} min</span>
            <input type="range" min="5" max="60" step="5" value={minutes} onChange={(e) => setMinutes(+e.target.value)} />
          </label>
          <div className="modes" role="group" aria-label="Travel mode">
            {MODES.map((m) => (
              <button type="button" key={m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <button className="go" disabled={status.kind === "loading"}>
            {status.kind === "loading" ? "Finding overlap…" : "Find overlap"}
          </button>
        </form>
        {status.message && <p className={`msg ${status.kind}`}>{status.message}</p>}
        {foodNote && <p className="msg none">{foodNote}</p>}
        {restaurants.length > 0 && (
          <section className="food">
            <label className="check">
              <input type="checkbox" checked={showFood} onChange={(e) => setShowFood(e.target.checked)} />
              Show restaurants on map ({restaurants.length} in overlap)
            </label>
            <ul>
              {restaurants.slice(0, 25).map((r, i) => (
                <li key={i}>
                  <button type="button" onClick={() => map.current.flyTo([r.lat, r.lng], 15)}>
                    <strong>{r.name}</strong>
                    <span>{[r.cuisine, r.address].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ul className="legend">
          <li><i className="dot" style={{ background: COLORS.a }} /> Reachable from A</li>
          <li><i className="dot" style={{ background: COLORS.b }} /> Reachable from B</li>
          <li><i className="dot" style={{ background: COLORS.both }} /> Reachable from both</li>
          <li><i className="dot" style={{ background: "#B8423A" }} /> Restaurant</li>
        </ul>
      </aside>
      <div className="map" ref={mapEl} />
    </div>
  );
}
