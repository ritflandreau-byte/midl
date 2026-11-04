import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import * as turf from "@turf/turf";
import logo from "./midl-logo.png";

const KEY = import.meta.env.VITE_GEOAPIFY_KEY;
const API = "https://api.geoapify.com/v1";
const COLORS = ["#2B6CB0", "#D9822B", "#7B4FB5", "#C2347F", "#2A8C99"];
const BOTH = "#1F9D6B";
const MAX_PEOPLE = 5;
const MAX_MINUTES = 180;
const MAX_CANDIDATES = 60; // restaurants closest to the middle that get exact travel times
const MODES = [
  { id: "drive", label: "Drive" },
  { id: "bicycle", label: "Bike" },
  { id: "walk", label: "Walk" },
];
const DIETS = [
  ["vegetarian", "Vegetarian"],
  ["vegan", "Vegan"],
  ["gluten_free", "Gluten-free"],
  ["halal", "Halal"],
];

const fmtMin = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`);
const letter = (i) => String.fromCharCode(65 + i);
const blank = () => ({ text: "", mode: "drive", minutes: 30, pt: null });
const style = (color, fill) => ({ color, weight: 2, fillColor: color, fillOpacity: fill });

/* ---------- shareable link ---------- */

function initialPeople() {
  try {
    const s = new URLSearchParams(window.location.search).get("s");
    if (s) {
      const list = JSON.parse(s)
        .slice(0, MAX_PEOPLE)
        .map(([text, mode, minutes]) => ({
          text: String(text || ""),
          mode: MODES.some((m) => m.id === mode) ? mode : "drive",
          minutes: Math.min(MAX_MINUTES, Math.max(5, Number(minutes) || 30)),
          pt: null,
        }));
      if (list.length >= 2) return list;
    }
  } catch {
    /* fall through to blank form */
  }
  return [blank(), blank()];
}

/* ---------- opening hours (handles the common OSM formats) ---------- */

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const RULE = /^(?:([A-Za-z][A-Za-z,\- ]*?)\s+)?(off|closed|\d[\d:,\-\s+]*)$/i;

function dayMatch(spec, d) {
  if (!spec) return true;
  for (const tok of spec.split(",").map((s) => s.trim())) {
    if (tok.includes("-")) {
      const [a, b] = tok.split("-").map((s) => DAYS.indexOf(s.trim()));
      if (a < 0 || b < 0) continue;
      for (let i = a; ; i = (i + 1) % 7) {
        if (i === d) return true;
        if (i === b) break;
      }
    } else if (DAYS.indexOf(tok) === d) return true;
  }
  return false;
}

function fmt12(t) {
  const [h, m = "00"] = t.trim().split(":");
  const hr = Number(h);
  const suffix = hr >= 12 && hr < 24 ? "PM" : "AM";
  return `${hr % 12 === 0 ? 12 : hr % 12}${m === "00" ? "" : ":" + m} ${suffix}`;
}
const to12 = (s) => s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => fmt12(`${h}:${m}`));

// open: true / false / null (hours missing or not understood); today: hours text for today
function hoursInfo(str, now = new Date()) {
  if (!str) return { open: null, today: null };
  if (str.trim() === "24/7") return { open: true, today: "24 hours" };
  const d = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  let parsed = false;
  let state = false;
  let today = null;
  for (const rule of str.split(";")) {
    const m = rule.trim().match(RULE);
    if (!m) continue;
    parsed = true;
    if (!dayMatch(m[1], d)) continue;
    if (/^(off|closed)$/i.test(m[2])) {
      state = false;
      today = "Closed";
      continue;
    }
    today = m[2].split(",").map((r) => (/^0?0:00-24:00$/.test(r.trim()) ? "24 hours" : r.trim().split("-").map(fmt12).join(" – "))).join(", ");
    state = m[2].split(",").some((range) => {
      const [s, e] = range.trim().split("-").map((x) => {
        const [h, mm = 0] = x.split(":").map(Number);
        return h * 60 + mm;
      });
      return e > s ? t >= s && t < e : t >= s || t < e;
    });
  }
  return parsed ? { open: state, today } : { open: null, today: null };
}

/* ---------- safe text, links and pin cards (place data is untrusted) ---------- */

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const GENERIC = new Set(["the", "and", "restaurant", "restaurants", "grill", "grille", "kitchen", "cafe", "bar", "house", "pizza", "pizzeria", "bistro", "tavern", "pub", "diner", "eatery", "food", "foods", "bbq", "steakhouse", "sushi", "thai", "chinese", "italian", "mexican", "indian"]);

// Keep a listed website only if its domain looks like the restaurant's name.
function matchSite(url, name) {
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, "").split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, "");
  const tokens = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));
  return tokens.some((t) => host.includes(t)) ? url : null;
}

const mapsUrl = (name, address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, address].filter(Boolean).join(" "))}`;

function hoursLine(r) {
  if (r.open === true) return r.today ? `Open now · ${r.today}` : "Open now";
  if (r.open === false) return r.today === "Closed" ? "Closed today" : r.today ? `Closed now · today ${r.today}` : "Closed now";
  return r.hoursRaw ? `Hours: ${to12(r.hoursRaw.length > 70 ? r.hoursRaw.slice(0, 70) + "…" : r.hoursRaw)}` : "Hours not listed";
}

function tooltipEl(r) {
  const box = el("div", null, "tip");
  box.append(el("strong", r.name));
  if (r.cuisine) box.append(el("div", r.cuisine));
  box.append(el("div", hoursLine(r)));
  return box;
}

function linkEl(text, href) {
  const link = el("a", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function popupEl(r) {
  const box = el("div", null, "tip pop");
  box.append(el("strong", r.name));
  const sub = [r.cuisine, r.address].filter(Boolean).join(" · ");
  if (sub) box.append(el("div", sub));
  box.append(el("div", hoursLine(r)));
  if (r.max != null) box.append(el("div", r.times.map((t, i) => `${letter(i)} ${t} min`).join(" · ")));
  const links = el("div", null, "pop-links");
  if (r.website) links.append(linkEl("Website", r.website));
  links.append(linkEl("Google Maps", r.maps));
  box.append(links);
  return box;
}

/* ---------- Geoapify calls ---------- */

async function geocode(text) {
  const url = `${API}/geocode/search?text=${encodeURIComponent(text)}&limit=1&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Address lookup failed. Check your API key.");
  const data = await res.json();
  const hit = data.features?.[0];
  if (!hit) throw new Error(`Couldn't find "${text}". Try adding a city or state.`);
  return { lng: hit.geometry.coordinates[0], lat: hit.geometry.coordinates[1], label: hit.properties.formatted };
}

async function suggest(text, near) {
  const url = `${API}/geocode/autocomplete?text=${encodeURIComponent(text)}&limit=5&bias=proximity:${near.lng},${near.lat}&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features || []).map((f) => ({
    label: f.properties.formatted,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

async function isochrone(point, mode, minutes) {
  const url = `${API}/isoline?lat=${point.lat}&lon=${point.lng}&type=time&mode=${mode}&range=${minutes * 60}&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Travel-time lookup failed. Check your API key or try a shorter time.");
  const data = await res.json();
  return data.features[0];
}

const yes = (v) => v === true || v === "yes" || v === "only";

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
      const p = f.properties;
      const raw = p.datasource?.raw || {};
      const cuisine = p.catering?.cuisine || raw.cuisine || "";
      const diet = p.catering?.diet || {};
      return {
        name: p.name,
        address: p.address_line2 || "",
        cuisine: cuisine.split(";")[0].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
        diets: Object.fromEntries(DIETS.map(([k]) => [k, yes(diet[k]) || yes(raw[`diet:${k}`])])),
        ...hoursInfo(p.opening_hours || raw.opening_hours),
        hoursRaw: p.opening_hours || raw.opening_hours || "",
        website: matchSite(safeUrl(p.website || p.contact?.website || raw.website || raw["contact:website"]), p.name),
        maps: mapsUrl(p.name, p.address_line2),
      };
    });
}

// Minutes from one person to each target, in small batches to stay under request limits.
async function travelTimes(person, point, targets) {
  const out = [];
  for (let i = 0; i < targets.length; i += 30) {
    const chunk = targets.slice(i, i + 30);
    const res = await fetch(`${API}/routematrix?apiKey=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: person.mode,
        sources: [{ location: [point.lng, point.lat] }],
        targets: chunk.map((t) => ({ location: [t.lng, t.lat] })),
      }),
    });
    if (!res.ok) throw new Error(`Exact travel times unavailable (error ${res.status}).`);
    const data = await res.json();
    (data.sources_to_targets?.[0] || []).forEach((cell) => {
      out[i + cell.target_index] = cell.time != null ? Math.round(cell.time / 60) : null;
    });
  }
  return out;
}

/* ---------- address field with suggestions ---------- */

function AddressInput({ id, value, label, near, onText, onPick }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function change(e) {
    const text = e.target.value;
    onText(text);
    clearTimeout(timer.current);
    const mine = ++seq.current;
    if (text.trim().length < 3) {
      setItems([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const list = await suggest(text, near());
        if (mine === seq.current) {
          setItems(list);
          setActive(-1);
          setOpen(list.length > 0);
        }
      } catch {
        /* suggestions are optional; typing still works */
      }
    }, 250);
  }

  function choose(item) {
    seq.current++;
    clearTimeout(timer.current);
    onPick(item);
    setItems([]);
    setOpen(false);
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="ac">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
        autoComplete="off"
        value={value}
        onChange={change}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
        placeholder="Start typing an address or city"
        aria-label={label}
      />
      {open && (
        <ul className="ac-list" id={`${id}-list`} role="listbox">
          {items.map((it, i) => (
            <li key={i} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""}
              onMouseDown={(e) => { e.preventDefault(); choose(it); }}>
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [people, setPeople] = useState(initialPeople);
  const [roster, setRoster] = useState([]);
  const [status, setStatus] = useState({ kind: "idle" });
  const [scored, setScored] = useState([]);
  const [foodNote, setFoodNote] = useState("");
  const [showFood, setShowFood] = useState(true);
  const [cuisine, setCuisine] = useState("");
  const [diets, setDiets] = useState([]);
  const [openOnly, setOpenOnly] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pickN, setPickN] = useState(0);
  const [copied, setCopied] = useState(false);

  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const foodLayer = useRef(null);
  const markers = useRef({});

  useEffect(() => {
    map.current = L.map(mapEl.current).setView([42.75, -71.4], 8);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    foodLayer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);

  // Opening a shared link runs the search straight away.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("s")) run(people);
  }, []);

  useEffect(() => {
    if (!map.current || !foodLayer.current) return;
    if (showFood) map.current.addLayer(foodLayer.current);
    else map.current.removeLayer(foodLayer.current);
  }, [showFood]);

  const cuisines = useMemo(() => [...new Set(scored.map((r) => r.cuisine).filter(Boolean))].sort(), [scored]);

  const visible = useMemo(
    () =>
      scored
        .filter(
          (r) =>
            (!cuisine || r.cuisine === cuisine) &&
            diets.every((k) => r.diets[k]) &&
            (!openOnly || r.open === true)
        )
        .sort((x, y) => x.score - y.score),
    [scored, cuisine, diets, openOnly]
  );

  const hiddenNoHours = openOnly ? scored.filter((r) => r.open === null).length : 0;

  function select(r) {
    setSelected(r.id);
    const m = map.current;
    if (m.getZoom() >= 14 && m.getCenter().distanceTo([r.lat, r.lng]) < 30) {
      markers.current[r.id]?.openPopup();
      return;
    }
    m.flyTo([r.lat, r.lng], Math.max(m.getZoom(), 14));
    m.once("moveend", () => markers.current[r.id]?.openPopup());
  }

  // Redraw restaurant pins whenever the filtered list changes.
  useEffect(() => {
    const group = foodLayer.current;
    if (!group) return;
    group.clearLayers();
    markers.current = {};
    visible.forEach((r) => {
      markers.current[r.id] = L.circleMarker([r.lat, r.lng], {
        radius: 6, color: "#fff", weight: 1.5, fillColor: "#B8423A", fillOpacity: 1,
      })
        .bindTooltip(tooltipEl(r), { direction: "top", offset: [0, -6] })
        .bindPopup(popupEl(r), { minWidth: 260, maxWidth: 380 })
        .on("click", () => setSelected(r.id))
        .on("popupopen", (e) => e.target.closeTooltip())
        .addTo(group);
    });
  }, [visible]);

  // Enlarge the selected pin.
  useEffect(() => {
    Object.entries(markers.current).forEach(([id, m]) =>
      m.setStyle(+id === selected ? { radius: 10, color: "#17212b", weight: 3 } : { radius: 6, color: "#fff", weight: 1.5 })
    );
    const m = markers.current[selected];
    if (m) m.bringToFront();
  }, [selected, visible]);

  async function run(list) {
    if (!KEY) return setStatus({ kind: "error", message: "Missing API key. Add VITE_GEOAPIFY_KEY to your .env file." });
    if (list.some((p) => !p.text.trim()))
      return setStatus({ kind: "error", message: "Fill in every location, or remove the empty ones." });
    setStatus({ kind: "loading" });
    try {
      const pts = await Promise.all(list.map((p) => (p.pt ? Promise.resolve(p.pt) : geocode(p.text))));
      const zones = await Promise.all(list.map((p, i) => isochrone(pts[i], p.mode, p.minutes)));
      const overlap = zones.slice(1).reduce((acc, z) => (acc ? turf.intersect(acc, z) : null), zones[0]);

      layer.current.clearLayers();
      foodLayer.current.clearLayers();
      setScored([]);
      setFoodNote("");
      setSelected(null);
      setPickN(0);
      setRoster(list);

      zones.forEach((z, i) => L.geoJSON(z, { style: style(COLORS[i], 0.12) }).addTo(layer.current));
      if (overlap) L.geoJSON(overlap, { style: style(BOTH, 0.5) }).addTo(layer.current);
      pts.forEach((p, i) =>
        L.circleMarker([p.lat, p.lng], { radius: 8, color: "#fff", weight: 2, fillColor: COLORS[i], fillOpacity: 1 })
          .bindTooltip(el("span", `${letter(i)}: ${p.label}`))
          .addTo(layer.current)
      );
      const bounds = zones.reduce((b, z) => b.extend(L.geoJSON(z).getBounds()), L.geoJSON(zones[0]).getBounds());
      map.current.fitBounds(bounds, { padding: [30, 30] });

      window.history.replaceState(null, "", `?s=${encodeURIComponent(JSON.stringify(list.map((p) => [p.text, p.mode, p.minutes])))}`);

      if (!overlap) {
        setStatus({ kind: "none", message: `No area where everyone is within their time limit. Try longer times.` });
        return;
      }

      try {
        const found = await fetchRestaurants(overlap);
        const mid = turf.centroid(overlap);
        const cands = found
          .map((r) => ({ ...r, d: turf.distance(mid, turf.point([r.lng, r.lat])) }))
          .sort((x, y) => x.d - y.d)
          .slice(0, MAX_CANDIDATES)
          .map((r, i) => ({ ...r, id: i }));

        let cols = null;
        try {
          cols = await Promise.all(list.map((p, i) => travelTimes(p, pts[i], cands)));
        } catch (err) {
          setFoodNote(`${err.message} Showing the places nearest the middle instead.`);
        }

        setScored(
          cands.map((r) => {
            const times = cols ? cols.map((col) => col[r.id]) : [];
            const ok = times.length > 0 && times.every((t) => t != null);
            const max = ok ? Math.max(...times) : null;
            const spread = ok ? max - Math.min(...times) : null;
            return { ...r, times, max, spread, score: ok ? max + spread * 0.5 : 1000 + r.d };
          })
        );
        if (cands.length === 0) setFoodNote("No restaurants found inside the overlap area.");
      } catch (err) {
        setFoodNote(err.message);
      }

      const sqMi = turf.area(overlap) / 2589988.11;
      setStatus({ kind: "ok", message: `Overlap found: about ${Math.round(sqMi).toLocaleString()} sq mi where everyone is within their time limit.` });
    } catch (err) {
      setStatus({ kind: "error", message: err.message });
    }
  }

  const setPerson = (i, patch) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleDiet = (k) => setDiets((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k]));

  function pick() {
    if (!visible.length) return;
    select(visible[pickN % Math.min(3, visible.length)]);
    setPickN((n) => n + 1);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFoodNote("Couldn't copy automatically. Copy the link from your address bar instead.");
    }
  }

  const ranked = visible.length > 0 && visible[0].times.length > 0 && visible[0].max != null;

  return (
    <div className="app">
      <aside className="panel">
        <h1 className="brand"><img src={logo} alt="Midl" /></h1>
        <p className="lede">Find a restaurant that's a fair trip for everyone.</p>

        <form onSubmit={(e) => { e.preventDefault(); run(people); }}>
          {people.map((p, i) => (
            <div className="person" key={i}>
              <div className="person-head">
                <span><i className="dot" style={{ background: COLORS[i] }} /> Person {letter(i)}</span>
                {people.length > 2 && (
                  <button type="button" className="x" aria-label={`Remove person ${letter(i)}`}
                    onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))}>×</button>
                )}
              </div>
              <AddressInput id={`addr-${i}`} value={p.text} label={`Location for person ${letter(i)}`}
                near={() => map.current.getCenter()}
                onText={(text) => setPerson(i, { text, pt: null })}
                onPick={(it) => setPerson(i, { text: it.label, pt: it })} />
              <div className="modes" role="group" aria-label={`Travel mode for person ${letter(i)}`}>
                {MODES.map((m) => (
                  <button type="button" key={m.id} className={p.mode === m.id ? "on" : ""} onClick={() => setPerson(i, { mode: m.id })}>
                    {m.label}
                  </button>
                ))}
              </div>
              <label className="time">
                <span>Up to {fmtMin(p.minutes)}</span>
                <input type="range" min="5" max={MAX_MINUTES} step="5" value={p.minutes} onChange={(e) => setPerson(i, { minutes: +e.target.value })} />
              </label>
            </div>
          ))}
          {people.length < MAX_PEOPLE && (
            <button type="button" className="add" onClick={() => setPeople((ps) => [...ps, blank()])}>+ Add a person</button>
          )}
          <button className="go" disabled={status.kind === "loading"}>
            {status.kind === "loading" ? "Finding restaurants…" : "Find restaurants"}
          </button>
        </form>

        {status.message && <p className={`msg ${status.kind}`}>{status.message}</p>}
        {status.kind === "ok" && (
          <button type="button" className="link" onClick={copyLink}>{copied ? "Link copied" : "Copy share link"}</button>
        )}
        {foodNote && <p className="msg none">{foodNote}</p>}

        {scored.length > 0 && (
          <section className="food">
            <div className="filters">
              <select value={cuisine} onChange={(e) => setCuisine(e.target.value)} aria-label="Cuisine">
                <option value="">Any cuisine</option>
                {cuisines.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="chips" role="group" aria-label="Filters">
                <button type="button" className={openOnly ? "chip on" : "chip"} aria-pressed={openOnly} onClick={() => setOpenOnly((v) => !v)}>Open now</button>
                {DIETS.map(([k, label]) => (
                  <button type="button" key={k} className={diets.includes(k) ? "chip on" : "chip"} aria-pressed={diets.includes(k)} onClick={() => toggleDiet(k)}>{label}</button>
                ))}
              </div>
              {(openOnly || diets.length > 0) && (
                <p className="hint">Hours and diet tags come from OpenStreetMap, so places without them are hidden when these are on{hiddenNoHours ? ` (${hiddenNoHours} have no listed hours)` : ""}.</p>
              )}
            </div>

            <div className="food-head">
              <label className="check">
                <input type="checkbox" checked={showFood} onChange={(e) => setShowFood(e.target.checked)} />
                Show on map ({visible.length})
              </label>
              <button type="button" className="pick" onClick={pick} disabled={!visible.length}>Pick for us</button>
            </div>

            {visible.length === 0 ? (
              <p className="msg none">No restaurants match these filters. Turn one off to see more.</p>
            ) : (
              <ul>
                {visible.slice(0, 40).map((r, i) => (
                  <li key={r.id} className={r.id === selected ? "sel" : ""}>
                    <button type="button" onClick={() => select(r)}>
                      <strong>{r.name}{ranked && i === 0 && <em className="badge">Fairest</em>}</strong>
                      {r.times.length > 0 && r.max != null && (
                        <span className="times">
                          {r.times.map((t, j) => (
                            <span key={j} className="t"><i className="dot" style={{ background: COLORS[j] }} />{letter(j)} {t} min</span>
                          ))}
                        </span>
                      )}
                      <span>{[r.cuisine, r.address].filter(Boolean).join(" · ")}</span>
                      <span className="hrs">{hoursLine(r)}</span>
                    </button>
                    <div className="links">
                      {r.website && <a className="site" href={r.website} target="_blank" rel="noopener noreferrer">Website</a>}
                      <a className="site" href={r.maps} target="_blank" rel="noopener noreferrer">Google Maps</a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {ranked && <p className="hint">Sorted by the longest trip anyone makes, then by how even the trips are. Times use each person's own travel mode.</p>}
          </section>
        )}

        <ul className="legend">
          {roster.map((p, i) => (
            <li key={i}><i className="dot" style={{ background: COLORS[i] }} /> Reachable from {letter(i)}</li>
          ))}
          <li><i className="dot" style={{ background: BOTH }} /> Reachable from everyone</li>
          <li><i className="dot" style={{ background: "#B8423A" }} /> Restaurant</li>
        </ul>
      </aside>
      <div className="map" ref={mapEl} />
    </div>
  );
}
