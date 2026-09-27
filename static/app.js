/* Global News Map — frontend */
const STATUS_COLOR = {
  escalating: "#d03b3b", active: "#ec835a", "de-escalating": "#fab219",
  ceasefire: "#0ca30c", frozen: "#898781",
};
/* good news mode: raw = the full /api/state, local = the good local stories in view,
   stash = the layer settings good news mode switched off, to put back afterwards */
const GOOD = { on: false, raw: null, local: [], stash: null };
const SIDE_COLOR = { A: "#3987e5", B: "#d95926", other: "#9085e9" };
const WEAPON_COLOR = { missile: "#ffffff", drone: "#eda100", airstrike: "#e87ba4", artillery: "#c3c2b7", shelling: "#c3c2b7",
                       ground: "#e34948", bombing: "#f2a33a", naval: "#1baf7a", other: "#9085e9" };
/* weapon glyphs on a 24x24 grid, nose up; each entry is a list of filled SVG subpaths.
   `dir` glyphs are rotated along their flight path while in the air. */
const WEAPON_GLYPH = {
  missile:   { dir: true, d: ["M12 1L14.3 5.5V15.5L18 19.5V22L14.3 20.3L13.2 22H10.8L9.7 20.3L6 22V19.5L9.7 15.5V5.5Z"] },
  drone:     { d: ["M2 5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z", "M15.6 5a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z",
                   "M2 19a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z", "M15.6 19a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0Z",
                   "M4 5.6L5.6 4L20 18.4L18.4 20Z", "M18.4 4L20 5.6L5.6 20L4 18.4Z", "M8.6 8.6H15.4V15.4H8.6Z"] },
  airstrike: { dir: true, d: ["M12 1L13.4 5.5V9.5L22 16.5V18.5L13.4 15.5V18.5L16.5 21V22.8L12 21.6L7.5 22.8V21L10.6 18.5V15.5L2 18.5V16.5L10.6 9.5V5.5Z"] },
  artillery: { dir: true, d: ["M12 1.5C14.6 4 15.8 7 15.8 10.5V18.5H8.2V10.5C8.2 7 9.4 4 12 1.5Z", "M7.6 19.5H16.4V22.5H7.6Z"] },
  bombing:   { dir: true, d: ["M12 22C9.3 20.2 8.3 17.5 8.3 14.5V9.5L12 7.5L15.7 9.5V14.5C15.7 17.5 14.7 20.2 12 22Z",
                              "M11.2 2H12.8V8H11.2Z", "M8 1.5H16L12 6.5Z"] },
  ground:    { d: ["M1.5 14H22.5L20 20.5H4Z", "M6.5 9H15L16.5 13.2H5.5Z", "M14.5 10.2H23V11.8H14.5Z"] },
  naval:     { d: ["M1 14.5H23L19.5 20.5H4.5Z", "M7.5 9.5H16V13.7H7.5Z", "M10.3 4H12.2V9H10.3Z", "M12.2 6.2H15.8V7.6H12.2Z"] },
  other:     { d: ["M12 1.5L14 8.2L20.5 5L16.6 11L22.5 13.5L15.8 14.8L17.5 21.5L12 17L6.5 21.5L8.2 14.8L1.5 13.5L7.4 11L3.5 5L10 8.2Z"] },
};
WEAPON_GLYPH.shelling = WEAPON_GLYPH.artillery;
const weaponKey = (w) => WEAPON_GLYPH[w] ? w : "other";
function weaponSvg(w, size = 14) {
  const g = WEAPON_GLYPH[weaponKey(w)], c = WEAPON_COLOR[w] || WEAPON_COLOR.other;
  return `<svg class="wi" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">` +
    g.d.map(d => `<path d="${d}" fill="${c}" stroke="rgba(0,0,0,.85)" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/>`).join("") + `</svg>`;
}
const LAND = "#3f4048", HEAT = "#f2a33a";

let COUNTRIES = {};          // iso3 -> {iso3, iso2, name, lat, lon}
let STATE = null;            // last /api/state
let selected = null;         // conflict id
let selectedCountry = null;  // iso3 while the country view is open (all of a country's conflicts)
let backCountry = null;      // the country view a conflict was opened from, so "back" returns there
const $ = (s) => document.querySelector(s);

/* ---------- helpers ---------- */
const norm = (code) => (code && COUNTRIES[code]) ? COUNTRIES[code].iso3 : null;
function flag(code) {
  const c = COUNTRIES[code]; if (!c || !c.iso2) return "";
  return [...c.iso2.toUpperCase()].map(ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join("");
}
const cname = (code) => (COUNTRIES[code] || {}).name || code;
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* great-circle arc between two [lon,lat] points */
function arc(from, to, n = 40) {
  const r = Math.PI / 180;
  const [l1, p1] = [from[0] * r, from[1] * r], [l2, p2] = [to[0] * r, to[1] * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p1 - p2) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l1 - l2) / 2) ** 2));
  if (d < 1e-6) return [from, to];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r]);
  }
  // avoid wrapping lines across the antimeridian
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - pts[i - 1][0]) > 180) return [from, to];
  return pts;
}

/* ---------- layout ---------- */
const mobileMQ = window.matchMedia("(max-width: 900px)");
const coarseMQ = window.matchMedia("(pointer: coarse)");
const isMobile = () => mobileMQ.matches;
/* zoom at which the whole globe fits the narrow side of the map (phones start zoomed out) */
function fitGlobeZoom() {
  const m = document.getElementById("map");
  const d = 0.92 * Math.min(m.clientWidth || innerWidth, m.clientHeight || innerHeight);
  return Math.max(0.8, Math.min(2.25, Math.log2(d * Math.PI / 512)));
}

/* ---------- map ---------- */
const OCEAN = "#070b14";
const HEAT_COLOR_EXPR = ["interpolate", ["linear"], ["coalesce", ["feature-state", "heat"], 0], 0, LAND, 1, HEAT];
const HEAT_OPACITY_EXPR = ["+", 0.12, ["*", 0.6, ["coalesce", ["feature-state", "heat"], 0]]];
const hashParam = (k) => new URLSearchParams(location.hash.slice(1)).get(k);
// read before the map exists: with hash: "map" it writes its own #map= on load
const sharedView = !!hashParam("map");
/* where this browser last left the map; a shared #map= link wins over it */
const savedView = (() => {
  if (sharedView) return null;
  try {
    const v = JSON.parse(localStorage.getItem("mapView") || "null");
    return v && [v.lon, v.lat, v.zoom].every(Number.isFinite) ? v : null;
  } catch (_) { return null; }
})();
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    glyphs: "/static/fonts/{fontstack}/{range}.pbf",
    projection: { type: "globe" },
    sky: {
      "sky-color": "#06080f", "horizon-color": "#1c2a48", "fog-color": "#06080f",
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.6,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 6, 1, 8, 0],
    },
    sources: {
      relief: { type: "raster", tiles: ["/static/tiles/{z}/{x}/{y}.jpg"], tileSize: 512, minzoom: 0, maxzoom: 4 },
      // Sentinel-2 cloudless 2016 by EOX, CC BY 4.0 (the later years are non-commercial only); only fetched while switched on
      satellite: { type: "raster", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, minzoom: 0, maxzoom: 13 },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": OCEAN, "background-color-transition": { duration: 450 } } },
      { id: "relief", type: "raster", source: "relief", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" },
        paint: { "raster-brightness-max": 0.82, "raster-fade-duration": 150 } },   // a little darker so markers and labels stay readable
    ],
  },
  center: savedView ? [savedView.lon, savedView.lat] : [25, 22], zoom: savedView ? savedView.zoom : isMobile() ? fitGlobeZoom() : 2.25, minZoom: 0.8, maxZoom: 9, attributionControl: false, preserveDrawingBuffer: true,
  maxPitch: 0,
  hash: "map",   // #map=zoom/lat/lon in the URL, so a view can be copied and shared
});
/* a first visit (no saved or shared view) opens over the visitor's own part of the world,
   from the country of their IP address; skipped once they have moved the map themselves */
if (!savedView && !sharedView && !/^\/conflict\//.test(location.pathname)) {
  let moved = false;
  map.on("movestart", (e) => { if (e.originalEvent) moved = true; });
  fetch("/api/where").then(r => r.json()).then(w => {
    if (!moved && Number.isFinite(w.lat) && Number.isFinite(w.lon))
      map.jumpTo({ center: [w.lon, Math.max(-45, Math.min(60, w.lat))] });
  }).catch(() => {});
}
function setHashParam(k, v) {
  const q = new URLSearchParams(location.hash.slice(1));
  if (v) q.set(k, v); else q.delete(k);
  history.replaceState(null, "", location.pathname + "#" + q.toString().replace(/%2F/g, "/"));
}
/* each conflict has its own page (/conflict/<id>) and the about text is /about: keep the path and the
   tab title in step with what the panel shows, so the address bar is a link that can be shared */
const pathConflict = (location.pathname.match(/^\/conflict\/([a-z0-9-]+)$/) || [])[1] || null;
const SITE_TITLE = "Global News Map";
function syncPath() {
  const c = selected && STATE && STATE.conflicts.find(x => x.id === selected);
  const about = readerOpen && $("#reader .about-page");
  const path = about ? "/about" : c ? `/conflict/${c.id}` : "/";
  document.title = about ? `How it works | ${SITE_TITLE}` : c ? `${c.name}: live map and latest news | ${SITE_TITLE}` : `${SITE_TITLE}: live map of wars and conflicts`;
  if (location.pathname !== path) history.replaceState(null, "", path + location.hash);
}
{
  let t = null;
  map.on("moveend", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const c = map.getCenter().wrap();
      try { localStorage.setItem("mapView", JSON.stringify({ lon: +c.lng.toFixed(3), lat: +c.lat.toFixed(3), zoom: +map.getZoom().toFixed(2) })); } catch (_) {}
    }, 1000);
  });
}
let hoverIso = null;

map.on("load", async () => {
  map.addSource("countries", { type: "geojson", data: "/static/data/ne_50m_admin_0_countries.geojson", promoteId: "ADM0_A3" });
  map.addSource("lakes", { type: "geojson", data: "/static/data/ne_50m_lakes.geojson" });
  map.addSource("rivers", { type: "geojson", data: "/static/data/ne_50m_rivers_lake_centerlines.geojson" });
  map.addSource("admin1", { type: "geojson", data: "/static/data/ne_50m_admin_1_states_provinces_lines.geojson" });
  map.addSource("places", { type: "geojson", data: "/static/data/places.geojson" });
  map.addSource("labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("arcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("garcs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  // land tint: heat / side colour over the relief
  map.addLayer({
    id: "country-fill", type: "fill", source: "countries",
    paint: {
      "fill-color": HEAT_COLOR_EXPR, "fill-opacity": HEAT_OPACITY_EXPR,
      "fill-color-transition": { duration: 650 }, "fill-opacity-transition": { duration: 650 },
    },
  });
  // official travel advice (optional): shaded by the level of the chosen government's advice
  map.addLayer({
    id: "advice-fill", type: "fill", source: "countries", layout: { visibility: "none" },
    paint: {
      "fill-color": ["match", ["coalesce", ["feature-state", "adv"], -1], ...ADVICE_COLORS.flatMap((c, i) => [i, c]), "rgba(0,0,0,0)"],
      "fill-opacity": ["case", [">=", ["coalesce", ["feature-state", "adv"], -1], 0], 0.55, 0],
      "fill-opacity-transition": { duration: 400 },
    },
  });
  map.addLayer({ id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": "#0c1424", "fill-opacity": 0.9 } });
  map.addLayer({
    id: "rivers", type: "line", source: "rivers", minzoom: 3,
    paint: { "line-color": "#1d2d4d", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 7, 1.2], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "admin1", type: "line", source: "admin1", minzoom: 4,
    paint: { "line-color": "rgba(255,255,255,0.08)", "line-width": 0.5, "line-dasharray": [3, 2] },
  });
  // soft glow along coasts and borders, then the crisp border line
  map.addLayer({
    id: "country-glow", type: "line", source: "countries",
    paint: { "line-color": "#7fa6e0", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 6, 4], "line-blur": 4, "line-opacity": 0.22 },
  });
  map.addLayer({
    id: "country-line", type: "line", source: "countries",
    paint: { "line-color": "rgba(210,225,255,0.22)", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 1.1] },
  });
  // occupied territory (DeepStateMap): red fill with a diagonal hatch; grey dashed = unknown status
  map.addImage("hatch-occupied", hatchImage("rgba(255,110,110,0.95)"), { pixelRatio: 2 });
  map.addSource("territory", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const occ = ["==", ["get", "kind"], "occupied"], unk = ["==", ["get", "kind"], "contested"];
  map.addLayer({ id: "territory-fill", type: "fill", source: "territory", filter: occ, paint: { "fill-color": "#d03b3b", "fill-opacity": 0.22 } });
  map.addLayer({ id: "territory-hatch", type: "fill", source: "territory", filter: occ, paint: { "fill-pattern": "hatch-occupied", "fill-opacity": 0.75 } });
  map.addLayer({ id: "territory-contested", type: "fill", source: "territory", filter: unk, paint: { "fill-color": "#bcaaa4", "fill-opacity": 0.25 } });
  map.addLayer({ id: "territory-line", type: "line", source: "territory", filter: occ,
    paint: { "line-color": "#ff6b6b", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 1.8] } });
  map.addLayer({ id: "territory-contested-line", type: "line", source: "territory", filter: unk,
    paint: { "line-color": "#bcaaa4", "line-width": 1, "line-dasharray": [2, 2] } });
  // day/night: three nested night polygons (sun below 0°, -6°, -12°) give a soft twilight edge
  map.addSource("night", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "night", type: "fill", source: "night",
    paint: { "fill-color": "#030718", "fill-opacity": ["get", "a"], "fill-antialias": false },
  });
  // a faint warm line where the sun is just setting/rising
  map.addSource("terminator", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "terminator", type: "line", source: "terminator",
    paint: { "line-color": "#ffb46b", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 18],
             "line-blur": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 16], "line-opacity": 0.14 },
  });
  // city lights: populated places glow only where it is dark (filter updated with the terminator)
  map.addLayer({
    id: "city-lights", type: "circle", source: "places", maxzoom: 7,
    filter: ["boolean", false],
    paint: {
      "circle-color": "#ffd58a",
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        1, ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.6, 1000000, 1.6, 20000000, 4],
        6, ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 2, 1000000, 6, 20000000, 14]],
      "circle-blur": 0.9,
      "circle-opacity": ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.25, 500000, 0.55, 5000000, 0.85],
    },
  });
  map.addSource("sun", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "sun", type: "circle", source: "sun",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 40, 5, 120], "circle-color": "#fff0c2",
             "circle-opacity": 0.1, "circle-blur": 1 },
  });
  updateNight();
  setInterval(updateNight, 60000);

  map.addLayer({
    id: "country-hover", type: "line", source: "countries",
    paint: { "line-color": "#ffffff", "line-width": 1.6,
             "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.7, 0] },
  });
  map.addLayer({
    id: "country-involved", type: "line", source: "countries",
    paint: { "line-color": SIDE_COLOR.other, "line-width": 1.8, "line-opacity": 0,
             "line-color-transition": { duration: 650 }, "line-opacity-transition": { duration: 650 } },
  });
  map.addLayer({
    id: "heat", type: "heatmap", source: "points", maxzoom: 9,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "w"], 1, 0.05, 100, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 1, 0.35, 6, 1.5],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 6, 24],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(242,163,58,0)", 0.3, "rgba(242,163,58,0.25)", 0.7, "rgba(236,131,90,0.6)", 1, "rgba(208,59,59,0.85)"],
      "heatmap-opacity": 0.7,
    },
  });
  // focus mode: darkens everything not involved in the selected conflict
  map.addLayer({
    id: "country-dim", type: "fill", source: "countries",
    paint: { "fill-color": "#04050a", "fill-opacity": 0, "fill-opacity-transition": { duration: 650 } },
  });
  map.addLayer({
    id: "garcs", type: "line", source: "garcs", layout: { visibility: "none" },
    paint: { "line-color": "#c3c2b7", "line-width": ["interpolate", ["linear"], ["get", "w"], 0, 0.5, 1, 3], "line-opacity": 0.35 },
  });
  map.addLayer({
    id: "arcs", type: "line", source: "arcs",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["get", "combat"], 2.2, 1.4],
      "line-opacity": 0.85, "line-opacity-transition": { duration: 650 },
      "line-dasharray": [2, 1.5],
    },
  });

  addCyberLayers();
  addWeatherLayers();

  // ---- labels: capitals, cities, country names
  map.addLayer({
    id: "capital-dots", type: "circle", source: "places", minzoom: 2.5,
    filter: ["==", ["get", "adm0cap"], 1],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2.5, 1.5, 6, 3.5], "circle-color": "#e8ecf5",
             "circle-stroke-color": "rgba(0,0,0,0.6)", "circle-stroke-width": 1, "circle-opacity": 0.85 },
  });
  map.addLayer({
    id: "city-dots", type: "circle", source: "places", minzoom: 4.5,
    filter: ["all", ["!=", ["get", "adm0cap"], 1], ["<=", ["get", "scalerank"], 6]],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4.5, 1, 8, 2.5], "circle-color": "#c3c2b7", "circle-opacity": 0.7 },
  });
  const cityLabel = (id, minzoom, filter, size, color) => map.addLayer({
    id, type: "symbol", source: "places", minzoom, filter,
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": size,
              "text-offset": [0.6, 0], "text-anchor": "left", "text-max-width": 8, "text-padding": 4 },
    paint: { "text-color": color, "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.2, "text-halo-blur": 0.5 },
  });
  cityLabel("capital-labels", 3, ["==", ["get", "adm0cap"], 1], ["interpolate", ["linear"], ["zoom"], 3, 10, 7, 13], "#e8ecf5");
  cityLabel("city-labels", 4.8, ["all", ["!=", ["get", "adm0cap"], 1], ["<=", ["get", "scalerank"], 6]],
            ["interpolate", ["linear"], ["zoom"], 4.8, 9.5, 8, 12], "#c3c2b7");
  cityLabel("town-labels", 6.5, ["all", ["!=", ["get", "adm0cap"], 1], [">", ["get", "scalerank"], 6]], 10, "#a9a89f");
  map.addLayer({
    id: "country-labels", type: "symbol", source: "labels", minzoom: 1.4, maxzoom: 7.5,
    layout: {
      "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-transform": "uppercase",
      "text-letter-spacing": 0.15, "text-max-width": 7,
      "text-size": ["interpolate", ["linear"], ["zoom"], 1.4, 8, 3, 11, 6, 15],
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "text-color": "rgba(230,235,245,0.75)", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.2,
             "text-opacity": ["interpolate", ["linear"], ["zoom"], 1.4, 0.6, 3, 0.9] },
  });
  // conflict names: a symbol layer so labels that would overlap are dropped (most severe placed first)
  // instead of piling up; the selected conflict's label is always shown and pushes the others aside
  map.addSource("conflict-labels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const conflictLabel = (id, extra) => map.addLayer({
    id, type: "symbol", source: "conflict-labels", ...extra.filter && { filter: extra.filter },
    layout: {
      "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": 11.5, "text-max-width": 16,
      "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": ["get", "off"], "text-justify": "auto",
      "text-padding": 3, "symbol-sort-key": ["get", "rank"], ...extra.layout,
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.9)", "text-halo-width": 1.4,
             "text-opacity": ["case", ["get", "dim"], 0.35, 1] },
  });
  conflictLabel("conflict-labels", { filter: ["!", ["get", "selected"]], layout: {} });
  conflictLabel("conflict-label-selected", { filter: ["get", "selected"], layout: { "text-allow-overlap": true, "text-size": 13 } });
  syncConflictLabelVisibility();

  // ---- strikes: paths, impacts, animated projectiles, impact flashes
  for (const id of ["strike-paths", "strike-impacts", "projectiles", "flashes"])
    map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "strike-paths", type: "line", source: "strike-paths",
    paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.3, "line-opacity-transition": { duration: 650 } },
  }, "capital-dots");
  map.addLayer({
    id: "flashes", type: "circle", source: "flashes",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, ["*", 10, ["get", "r"]], 6, ["*", 40, ["get", "r"]]],
      "circle-color": ["get", "color"], "circle-opacity": ["*", 0.35, ["get", "a"]],
      "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-opacity": ["get", "a"],
      "circle-blur": 0.4,
    },
  }, "capital-dots");
  for (const w of Object.keys(WEAPON_GLYPH)) map.addImage("w-" + w, weaponIcon(w), { pixelRatio: 2 });
  // a soft halo sized by volume (a ring when only the country is known), with the weapon icon on top
  map.addLayer({
    id: "strike-impacts", type: "circle", source: "strike-impacts",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        1, ["case", ["==", ["get", "precision"], "country"], 10, ["+", 2, ["get", "r"]]],
        6, ["case", ["==", ["get", "precision"], "country"], 16, ["*", 2.4, ["get", "r"]]]],
      "circle-color": ["get", "color"],
      "circle-opacity": ["case", ["==", ["get", "precision"], "country"], 0.08, 0.2],
      "circle-stroke-color": ["get", "color"], "circle-stroke-width": 1.2,
      "circle-stroke-opacity": ["case", ["==", ["get", "precision"], "country"], 0.9, 0],
      "circle-opacity-transition": { duration: 650 }, "circle-stroke-opacity-transition": { duration: 650 },
    },
  }, "capital-dots");
  map.addLayer({
    id: "strike-icons", type: "symbol", source: "strike-impacts",
    layout: {
      "icon-image": ["concat", "w-", ["get", "icon"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 1, ["+", 0.45, ["*", 0.04, ["get", "r"]]], 6, ["+", 0.7, ["*", 0.06, ["get", "r"]]]],
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": ["case", ["==", ["get", "precision"], "country"], 0.6, 1], "icon-opacity-transition": { duration: 650 } },
  }, "capital-dots");
  map.addLayer({
    id: "projectiles", type: "symbol", source: "projectiles",
    layout: {
      "icon-image": ["concat", "w-", ["get", "icon"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 6, 0.85],
      "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
  });
  map.on("mousemove", ["strike-icons", "strike-impacts"], (e) => {
    const p = e.features[0].properties; const tip = $("#tooltip");
    tip.innerHTML = strikeHtml(p);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", ["strike-icons", "strike-impacts"], () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", ["strike-icons", "strike-impacts"], (e) => {
    e.originalEvent._handled = true;
    openStrikeFeature(e.features[0], e.lngLat);
  });

  // ---- GDELT located incidents (fight / mass-violence events with a place and a source)
  map.addSource("incidents", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "incidents", type: "circle", source: "incidents", minzoom: 3,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["+", 1.5, ["*", 0.6, ["get", "lm"]]], 8, ["+", 3, ["*", 1.6, ["get", "lm"]]]],
      "circle-color": ["match", ["get", "root"], 20, "#d03b3b", "#ec835a"],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 5, 0.6],
      "circle-stroke-color": "rgba(0,0,0,0.5)", "circle-stroke-width": 0.6,
      "circle-opacity-transition": { duration: 650 },
    },
  }, "capital-dots");
  map.on("mousemove", "incidents", (e) => {
    const p = e.features[0].properties; const tip = $("#tooltip");
    tip.innerHTML = incidentHtml(p);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "incidents", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "incidents", (e) => {
    e.originalEvent._handled = true;
    openIncidentFeature(e.features[0]);
  });

  // ---- local news (optional): every located article of the last 24 h, loaded for the view when zoomed in
  map.addSource("local-news", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // small squares, so they never read as the round GDELT incident dots
  map.addImage("news-sq", (() => {
    const n = 24, c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d"); g.fillStyle = "rgba(0,0,0,0.75)"; g.fillRect(4, 4, 16, 16); g.fillStyle = "#fff"; g.fillRect(6, 6, 12, 12);
    return g.getImageData(0, 0, n, n);
  })(), { pixelRatio: 2 });
  map.addImage("news-sq-fill", (() => {
    const n = 24, c = document.createElement("canvas"); c.width = c.height = n;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(6, 6, 12, 12);
    return g.getImageData(0, 0, n, n);
  })(), { sdf: true, pixelRatio: 2 });
  const sqSize = ["interpolate", ["linear"], ["zoom"], LOCAL_MINZOOM, ["+", 0.55, ["*", 0.08, ["get", "lm"]]], 9, ["+", 0.85, ["*", 0.15, ["get", "lm"]]]];
  map.addLayer({ id: "local-news-outline", type: "symbol", source: "local-news", minzoom: LOCAL_MINZOOM,
    layout: { visibility: "none", "icon-image": "news-sq", "icon-size": sqSize, "icon-allow-overlap": true, "icon-ignore-placement": true } }, "capital-dots");
  map.addLayer({ id: "local-news", type: "symbol", source: "local-news", minzoom: LOCAL_MINZOOM,
    layout: { visibility: "none", "icon-image": "news-sq-fill", "icon-size": sqSize, "icon-allow-overlap": true, "icon-ignore-placement": true },
    paint: { "icon-color": ["match", ["get", "topic"], "violence", LOCAL_COLOR.violence, "protest", LOCAL_COLOR.tension, "tension", LOCAL_COLOR.tension, "good", LOCAL_COLOR.good, LOCAL_COLOR.other] },
  }, "capital-dots");
  map.on("mousemove", "local-news", (e) => {
    const tip = $("#tooltip"); tip.innerHTML = localHtml(e.features[0].properties);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "local-news", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "local-news", (e) => { e.originalEvent._handled = true; openLocalFeature(e.features[0]); });
  map.on("moveend", () => { clearTimeout(localTimer); localTimer = setTimeout(loadLocalNews, 350); });

  // ---- military aircraft (public ADS-B, served with a delay)
  map.addImage("plane", planeIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("plane-outline", planeIcon(true), { pixelRatio: 2 });
  map.addImage("heli", heliIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("heli-outline", heliIcon(true), { pixelRatio: 2 });
  map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("aircraft-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const acColor = ["match", ["get", "cat"], ...Object.entries(AIRCRAFT_COLOR).flat(), AIRCRAFT_COLOR.other];
  map.addLayer({
    id: "aircraft-trails-casing", type: "line", source: "aircraft-trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "rgba(0,0,0,0.55)", "line-width": 4 },
  });
  map.addLayer({
    id: "aircraft-trails", type: "line", source: "aircraft-trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": acColor, "line-width": 2, "line-opacity": 0.85 },
  });
  // a solid dark silhouette underneath gives every plane a crisp outline on any background
  map.addLayer({
    id: "aircraft-outline", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": ["match", ["get", "cat"], "heli", "heli-outline", "plane-outline"], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.9, 6, 1.35],
      "icon-rotate": ["coalesce", ["get", "track"], 0], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "aircraft", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": ["match", ["get", "cat"], "heli", "heli", "plane"], "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.9, 6, 1.35],
      "icon-rotate": ["coalesce", ["get", "track"], 0], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 4, ["coalesce", ["get", "flight"], ""]],
      "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true,
    },
    paint: { "icon-color": acColor,
             "text-color": "#e6e4da", "text-halo-color": "#000", "text-halo-width": 1.4 },
  });
  map.on("mousemove", "aircraft", (e) => {
    const tip = $("#tooltip");
    tip.innerHTML = aircraftHtml(e.features[0].properties, false);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "aircraft", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "aircraft", (e) => {
    e.originalEvent._handled = true;
    openAircraftFeature(e.features[0]);
  });

  // ---- military ships (AIS, served with a delay)
  map.addImage("ship", shipIcon(), { sdf: true, pixelRatio: 2 });
  map.addImage("ship-outline", shipIcon(true), { pixelRatio: 2 });
  map.addSource("ships", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("ship-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "ship-trails", type: "line", source: "ship-trails", layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": SHIP_COLOR, "line-width": 1.6, "line-opacity": 0.6, "line-dasharray": [1, 1.5] } });
  const shipLayout = (img) => ({ visibility: "none", "icon-image": img,
    "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.8, 6, 1.25],
    "icon-rotate": ["coalesce", ["get", "heading"], 0], "icon-rotation-alignment": "map",
    "icon-allow-overlap": true, "icon-ignore-placement": true });
  map.addLayer({ id: "ships-outline", type: "symbol", source: "ships", layout: shipLayout("ship-outline") });
  map.addLayer({ id: "ships", type: "symbol", source: "ships",
    layout: { ...shipLayout("ship"), "text-field": ["step", ["zoom"], "", 4, ["get", "name"]], "text-font": ["Open Sans Regular"],
              "text-size": 10, "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true },
    paint: { "icon-color": SHIP_COLOR, "text-color": "#cfe9ff", "text-halo-color": "#000", "text-halo-width": 1.4 } });
  map.on("mousemove", "ships", (e) => {
    const tip = $("#tooltip"); tip.innerHTML = shipHtml(e.features[0].properties, false);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "ships", () => { $("#tooltip").hidden = true; map.getCanvas().style.cursor = ""; });
  map.on("click", "ships", (e) => {
    e.originalEvent._handled = true;
    const f = e.features[0];
    new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(f.geometry.coordinates).setHTML(shipHtml(f.properties)).addTo(map);
  });
  setInterval(loadShips, 60000);

  // hover outline
  map.on("mousemove", "country-fill", (e) => {
    const iso = e.features[0].properties.ADM0_A3;
    if (iso !== hoverIso) {
      if (hoverIso) map.setFeatureState({ source: "countries", id: hoverIso }, { hover: false });
      map.setFeatureState({ source: "countries", id: iso }, { hover: true });
      hoverIso = iso;
    }
  });
  map.on("mouseleave", "country-fill", () => {
    if (hoverIso) map.setFeatureState({ source: "countries", id: hoverIso }, { hover: false });
    hoverIso = null;
  });

  // hover tooltip on countries
  const tip = $("#tooltip");
  map.on("mousemove", "country-fill", (e) => {
    const f = e.features[0]; const iso = f.properties.ADM0_A3;
    const h = STATE?.gdelt.heat[iso];
    const inv = STATE ? STATE.conflicts.filter(c => c.parties.some(p => norm(p.country) === iso)).map(c => c.name) : [];
    if (CYBER.on || WEATHER.on) {
      tip.innerHTML = `<b>${esc(f.properties.NAME_EN || f.properties.NAME)}</b>` + (CYBER.on ? cyberCountryTip(iso) : weatherCountryTip(iso));
      tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
      return;
    }
    tip.innerHTML = `<b>${esc(f.properties.NAME_EN || f.properties.NAME)}</b>` + (GOOD.on ? "" :
      h ? `<br>${h.events} conflict events · ${h.mentions} mentions (${STATE.gdelt.hours}h)` : "<br>no GDELT conflict events") +
      (inv.length ? `<br>involved in: ${esc(inv.join(", "))}` : "") +
      (inv.length > 1 ? `<br><span style="opacity:.6">click to see all ${inv.length} and who is on which side</span>` : "") +
      (GOOD.on ? "" : adviceTip(iso)) + territoryTip(e.point);
    tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px";
  });
  map.on("mouseleave", "country-fill", () => { tip.hidden = true; });
  map.on("click", "country-fill", (e) => {
    if (e.originalEvent._handled) return;          // an incident / attack circle on top took this click
    if (fuzzyTap(e)) return;                        // a finger landed next to one
    const iso = e.features[0].properties.ADM0_A3;
    const list = conflictsFor(iso);
    if (!list.length) {                              // no conflict here: show the official travel advice, if any
      if (!GOOD.on && !CYBER.on && !WEATHER.on && ADVICE && (ADVICE.fcdo?.[iso] || ADVICE.us?.[iso])) {
        e.originalEvent._handled = true;
        new maplibregl.Popup({ closeButton: true, maxWidth: "320px" }).setLngLat(e.lngLat)
          .setHTML(`<b>${esc(countryName(iso))}</b>${adviceHtml(iso)}`).addTo(map);
      }
      return;                                        // otherwise fall through to the map click (deselect)
    }
    e.originalEvent._handled = true;
    if (list.length === 1) select(list[0].id); else selectCountry(iso);   // several conflicts: show them all
  });

  await loadCountries();
  restoreSettings();          // before the first data load so the 24h/48h window is right
  $("#tg-sat").dispatchEvent(new Event("change"));   // the style starts on the relief; switch to the imagery if it's on
  let goodPref = null; try { goodPref = localStorage.getItem("goodNews"); } catch (_) {}
  if (hashParam("good") === "1" || (hashParam("good") !== "0" && goodPref === "1")) setGood(true);
  let cyberPref = null; try { cyberPref = localStorage.getItem("cyberMode"); } catch (_) {}
  if (!GOOD.on && (hashParam("cyber") === "1" || (hashParam("cyber") !== "0" && cyberPref === "1"))) setCyber(true);
  let weatherPref = null; try { weatherPref = localStorage.getItem("weatherMode"); } catch (_) {}
  if (!GOOD.on && !CYBER.on && (hashParam("weather") === "1" || (hashParam("weather") !== "0" && weatherPref === "1"))) setWeather(true);
  await load();
  startHeadlines();
  await loadAdvice(); setInterval(loadAdvice, 3600000);
  loadTerritory(); setInterval(loadTerritory, 3600000);   // before a shared #country= view renders its advice box
  const shared = pathConflict || hashParam("c"), sharedCountry = hashParam("country");
  if (shared && STATE.conflicts.find(c => c.id === shared)) select(shared, { keepView: sharedView });
  else if (sharedCountry && conflictsFor(sharedCountry).length) selectCountry(sharedCountry);
  else if (location.pathname === "/about") openAbout();
  else syncPath();
  setInterval(load, 60000);
  // off by default: start the aircraft layers hidden until the toggle is ticked
  for (const id of ["aircraft", "aircraft-outline", "aircraft-trails", "aircraft-trails-casing"])
    map.setLayoutProperty(id, "visibility", $("#tg-aircraft").checked ? "visible" : "none");
  loadAircraft();
  setInterval(loadAircraft, 60000);
});

async function loadCountries() {
  COUNTRIES = await (await fetch("/api/countries")).json();
  const seen = new Set();
  const feats = [];
  for (const c of Object.values(COUNTRIES)) {
    if (seen.has(c.iso3) || !c.name) continue;
    seen.add(c.iso3);
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
                 properties: { name: (c.label || c.name).replace("United States of America", "United States"), rank: (c.label || c.name).length } });
  }
  map.getSource("labels").setData({ type: "FeatureCollection", features: feats });
}

/* ---------- data ---------- */
async function load() {
  const hours = $("#window").value;
  GOOD.raw = await (await fetch(`/api/state?hours=${hours}`)).json();
  STATE = viewOf(GOOD.raw);
  render();
}

function render() {
  renderStatus();
  loadReports();
  renderHeat();
  renderMarkers();
  renderArcs();
  renderGdeltArcs();
  renderStrikes();
  renderIncidents();
  if (readerOpen) { /* leave the article on screen; the list/detail refresh underneath when it closes */ }
  else if (selected && STATE.conflicts.find(c => c.id === selected)) renderDetail();
  else if (selectedCountry && conflictsFor(selectedCountry).length) { selected = null; renderCountry(); }
  else { selected = selectedCountry = null; renderList(); }
  applyInvolvement();
}

function renderStatus() {
  const m = STATE.meta, g = STATE.gdelt;
  const parts = [`<b>Updated ${esc(ago(m.last_extract?.at))}</b>`,
    CYBER.on ? `cyber mode` : WEATHER.on ? `weather mode` : GOOD.on ? `good news mode` : `${STATE.conflicts.length} conflicts`, `${m.sources} news outlets`];
  if (ONLINE) parts.unshift(`<span class="online" title="People with the map open right now (each open tab counts)"><i></i>${ONLINE} online</span>`);
  if (m.busy) parts.push(m.unprocessed ? `refreshing now, ${m.unprocessed} articles to read` : "refreshing now");
  else if (m.unprocessed && !m.serve_only) parts.push(`${m.unprocessed} articles queued`);
  $("#status").innerHTML = parts.join(" · ");
  $("#status").title = `Conflicts last re-read from the news ${m.last_extract?.at ? new Date(m.last_extract.at * 1000).toLocaleString() : "never"}.\n` +
    `Background layer: ${g.total.toLocaleString()} GDELT conflict events in the last ${g.hours} h.`;
  $("#refresh").disabled = !!m.busy;
  $("#refresh").hidden = !!m.serve_only;
}

function renderHeat() {
  const heat = STATE.gdelt.heat;
  // power curve so only genuinely hot countries glow, not every country with a few events
  const vals = Object.values(heat).map(h => Math.log1p(h.mentions));
  const max = Math.max(1, ...vals);
  const curve = (v) => Math.pow(v / max, 3);
  for (const iso of Object.keys(COUNTRIES)) map.setFeatureState({ source: "countries", id: iso }, { heat: 0 });
  for (const [iso, h] of Object.entries(heat)) {
    map.setFeatureState({ source: "countries", id: iso }, { heat: curve(Math.log1p(h.mentions)) });
  }
  map.getSource("points").setData({
    type: "FeatureCollection",
    features: STATE.gdelt.points.map(([lon, lat, w]) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { w } })),
  });
}

const markerById = new Map();
function renderMarkers() {
  const live = new Set(), focus = focusIds();
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep || typeof ep.lat !== "number") continue;
    live.add(c.id);
    let m = markerById.get(c.id);
    if (!m) {
      const el = document.createElement("div");
      el.className = "mk"; el.tabIndex = 0; el.setAttribute("role", "button");
      el.addEventListener("click", (e) => { e.stopPropagation(); select(c.id); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c.id); } });
      m = new maplibregl.Marker({ element: el }).setLngLat([ep.lon, ep.lat]).addTo(map);
      markerById.set(c.id, m);
    }
    const el = m.getElement();
    const size = markerSize(c);
    el.style.width = el.style.height = size + "px";
    el.style.color = STATUS_COLOR[c.status] || STATUS_COLOR.active;
    // toggle our classes only: the marker library keeps its own (maplibregl-marker ...) on this element,
    // and those are what pin it to its coordinates
    const st = c.status in STATUS_COLOR ? c.status : "active";
    for (const k of Object.keys(STATUS_COLOR)) el.classList.toggle(`st-${k}`, k === st);
    el.title = `${c.name} (${c.status})`;
    el.setAttribute("aria-label", `${c.name}, ${c.status}, severity ${c.severity || 1} of 5`);
    el.classList.toggle("dim", !!(focus && !focus.has(c.id)));
    el.classList.toggle("selected", selected === c.id);
    el.classList.toggle("hidden", !listMatch(c) && !(focus && focus.has(c.id)));
    m.setLngLat([ep.lon, ep.lat]);
  }
  for (const [id, m] of markerById) if (!live.has(id)) { m.remove(); markerById.delete(id); }
  renderConflictLabels();
}
const markerSize = (c) => 8 + (c.severity || 1) * 3;
function renderConflictLabels() {
  const src = map.getSource("conflict-labels"); if (!src) return;
  const focus = focusIds();
  src.setData({ type: "FeatureCollection", features: STATE.conflicts
    .filter(c => c.epicenter && typeof c.epicenter.lat === "number" && (listMatch(c) || (focus && focus.has(c.id))))
    .map(c => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.epicenter.lon, c.epicenter.lat] },
      properties: { name: c.name, off: (markerSize(c) / 2 + 5) / 11.5, rank: -(c.severity || 1) * 10 - (c.status === "escalating" ? 5 : 0),
                    selected: c.id === selected, dim: !!(focus && !focus.has(c.id)) } })) });
}
/* phones: only the selected conflict is labelled; the list is a swipe away */
function syncConflictLabelVisibility() {
  if (map.getLayer("conflict-labels")) map.setLayoutProperty("conflict-labels", "visibility", isMobile() ? "none" : "visible");
}

function renderArcs() {
  const feats = [];
  for (const c of STATE.conflicts) {
    const ep = c.epicenter; if (!ep) continue;
    for (const p of c.parties) {
      const iso = norm(p.country); if (!iso) continue;
      const cc = COUNTRIES[iso];
      // combatants whose own territory hosts the epicenter don't need an arc
      const from = [cc.lon, cc.lat], to = [ep.lon, ep.lat];
      const dist = Math.hypot(from[0] - to[0], from[1] - to[1]);
      if (p.role === "combatant" && dist < 12) continue;
      if (GOOD.on && p.role !== "mediator") continue;         // good news: only the peacemakers' lines
      feats.push({
        type: "Feature", geometry: { type: "LineString", coordinates: arc(from, to) },
        properties: { color: SIDE_COLOR[p.side] || SIDE_COLOR.other, combat: p.role === "combatant", conflict: c.id },
      });
    }
  }
  map.getSource("arcs").setData({ type: "FeatureCollection", features: feats });
}

function renderGdeltArcs() {
  const pairs = STATE.gdelt.pairs; const max = Math.max(1, ...pairs.map(p => p.mentions));
  const feats = pairs.filter(p => COUNTRIES[p.a] && COUNTRIES[p.b]).map(p => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: arc([COUNTRIES[p.a].lon, COUNTRIES[p.a].lat], [COUNTRIES[p.b].lon, COUNTRIES[p.b].lat]) },
    properties: { w: p.mentions / max },
  }));
  map.getSource("garcs").setData({ type: "FeatureCollection", features: feats });
}

/* the conflicts in focus: the selected one, or every conflict of the selected country; null = no focus */
function focusIds() {
  if (selected) return new Set([selected]);
  if (selectedCountry) return new Set(conflictsFor(selectedCountry).map(c => c.id));
  return null;
}
/* iso -> colour of every country highlighted on the map */
function focusColors() {
  const out = {};
  const c = STATE.conflicts.find(x => x.id === selected);
  if (c) for (const p of c.parties) { const iso = norm(p.country); if (iso && !out[iso]) out[iso] = SIDE_COLOR[p.side] || SIDE_COLOR.other; }
  else if (selectedCountry) {
    for (const [iso, r] of Object.entries(countryRelations(selectedCountry).byIso)) out[iso] = REL_COLOR[r];
    out[selectedCountry] = REL_COLOR.self;
  }
  return out;
}
function applyInvolvement() {
  const focus = focusIds();
  const colors = focusColors();
  const isos = Object.keys(colors);
  const inList = ["in", ["get", "ADM0_A3"], ["literal", isos]];
  const sideColor = isos.length
    ? ["match", ["get", "ADM0_A3"], ...isos.flatMap(i => [i, colors[i]]), SIDE_COLOR.other]
    : SIDE_COLOR.other;
  // every change goes through setPaintProperty so MapLibre cross-fades old and new values per feature
  map.setPaintProperty("country-fill", "fill-color", isos.length ? ["case", inList, sideColor, HEAT_COLOR_EXPR] : HEAT_COLOR_EXPR);
  map.setPaintProperty("country-fill", "fill-opacity", isos.length ? ["case", inList, 0.5, HEAT_OPACITY_EXPR] : HEAT_OPACITY_EXPR);
  map.setPaintProperty("country-involved", "line-color", sideColor);
  map.setPaintProperty("country-involved", "line-opacity", isos.length ? ["case", inList, 1, 0] : 0);
  map.setPaintProperty("country-involved", "line-width", selectedCountry && !selected
    ? ["case", ["==", ["get", "ADM0_A3"], selectedCountry], 3, 1.8] : 1.8);
  map.setPaintProperty("country-dim", "fill-opacity", focus ? ["case", inList, 0, 0.78] : 0);
  // arcs and strikes of other conflicts fade instead of snapping
  const own = (full, dimmed) => focus ? ["case", ["in", ["get", "conflict"], ["literal", [...focus]]], full, dimmed] : full;
  map.setPaintProperty("arcs", "line-opacity", own(0.85, 0.12));
  map.setPaintProperty("strike-paths", "line-opacity", own(0.3, 0.06));
  const isCountry = ["==", ["get", "precision"], "country"];
  map.setPaintProperty("strike-impacts", "circle-opacity", own(["case", isCountry, 0.08, 0.2], 0.04));
  map.setPaintProperty("strike-impacts", "circle-stroke-opacity", own(["case", isCountry, 0.9, 0], ["case", isCountry, 0.12, 0]));
  map.setPaintProperty("strike-icons", "icon-opacity", own(["case", isCountry, 0.6, 1], 0.15));
  setFocus(!!focus);
  if (map.getLayer("incidents")) applyIncidentFocus();
}

function setFocus(on) {
  map.setPaintProperty("bg", "background-color", on ? "#03040a" : OCEAN);
  map.setPaintProperty("relief", "raster-opacity", on ? 0.45 : 1);
  map.setPaintProperty("heat", "heatmap-opacity", on ? 0.25 : 0.7);
  map.setPaintProperty("country-glow", "line-opacity", on ? 0.08 : 0.22);
  map.setPaintProperty("country-line", "line-color", on ? "rgba(210,225,255,0.08)" : "rgba(210,225,255,0.22)");
}

/* which conflicts is a country a party to? */
const conflictsFor = (iso) => STATE.conflicts.filter(c => c.parties.some(p => norm(p.country) === iso));

/* ---------- panel ---------- */
function sevbar(n) { return `<span class="sevbar">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`; }

function reveal(el) { el.classList.remove("reveal"); void el.offsetWidth; el.classList.add("reveal"); }
/* list search / filters (the map markers and labels follow them too) */
const LIST = { q: "", status: "", region: "" };     // region: a remembered choice waiting for the options to exist
try { const f = JSON.parse(localStorage.getItem("listFilter") || "null"); if (f) { LIST.status = f.status || ""; LIST.region = f.region || ""; } } catch (_) {}
function saveListFilter() {
  try { localStorage.setItem("listFilter", JSON.stringify({ status: LIST.status, region: $("#region").value || LIST.region })); } catch (_) {}
}
const STATUS_LABEL = { escalating: "escalating", active: "active", "de-escalating": "easing", ceasefire: "ceasefire", frozen: "frozen" };
function listMatch(c, ignoreStatus = false) {
  if (!ignoreStatus && LIST.status && c.status !== LIST.status) return false;
  const region = $("#region").value;
  if (region && c.region !== region) return false;
  if (!LIST.q) return true;
  const hay = [c.name, c.region, ...c.parties.flatMap(p => [p.name, norm(p.country) && cname(norm(p.country))])].join(" ").toLowerCase();
  return LIST.q.split(/\s+/).every(w => hay.includes(w));
}
function sortedConflicts() {
  const by = $("#sort").value;
  const cmp = by === "updated" ? (a, b) => (b.updated || 0) - (a.updated || 0)
    : by === "attacks" ? (a, b) => nStrikes(b.id) - nStrikes(a.id) || (b.severity || 0) - (a.severity || 0)
    : null;
  const list = STATE.conflicts.slice();            // the server already orders by severity, then recency
  return cmp ? list.sort(cmp) : list;
}
function renderListTools() {
  const counts = {};
  for (const c of STATE.conflicts) if (listMatch(c, true)) counts[c.status] = (counts[c.status] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (st, label, n) => `<button class="chip" data-status="${st}" aria-pressed="${LIST.status === st}">${label} <span class="n">${n}</span></button>`;
  $("#status-chips").innerHTML = chip("", "All", total) +
    Object.keys(STATUS_LABEL).filter(st => counts[st] || LIST.status === st).map(st => chip(st, STATUS_LABEL[st], counts[st] || 0)).join("");
  const regions = [...new Set(STATE.conflicts.map(c => c.region).filter(Boolean))].sort();
  const sel = $("#region"), cur = sel.value || LIST.region;
  const want = ["", ...regions].join("|");
  if (sel.dataset.opts !== want) {
    sel.innerHTML = `<option value="">All regions</option>` + regions.map(r => `<option>${esc(r)}</option>`).join("");
    sel.value = regions.includes(cur) ? cur : ""; sel.dataset.opts = want; LIST.region = "";
  }
}
function applyListFilter() { saveListFilter(); renderList({ animate: false }); renderMarkers(); }

function renderList({ animate = true } = {}) {
  $("#reader").hidden = true; readerOpen = false;
  $("#detail").hidden = true; $("#list").hidden = false; if (animate) reveal($("#list"));
  $("#list").removeAttribute("aria-busy");
  if (CYBER.on) return renderCyberList();
  if (WEATHER.on) return renderWeatherList();
  if (GOOD.on) return renderGoodList();
  if (!STATE.conflicts.length) {
    $("#list-tools").hidden = true;
    $("#list").innerHTML = `<div class="empty">No conflicts extracted yet.<br><br>${STATE.meta.busy ? "The first refresh is running — the local model is reading the news feeds now." : "Press Refresh to fetch the feeds and run extraction."}</div>`;
    return;
  }
  $("#list-tools").hidden = false;
  renderListTools();
  const shown = sortedConflicts().filter(c => listMatch(c));
  $("#list").innerHTML = shown.map(c => {
    const combat = c.parties.filter(p => p.role === "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    const others = c.parties.filter(p => p.role !== "combatant" && norm(p.country)).map(p => flag(norm(p.country)));
    return `<a class="card ${c.id === selected ? "selected" : ""}" href="/conflict/${esc(c.id)}" data-id="${esc(c.id)}">
      <div class="head"><span class="name">${esc(c.name)}</span>${sevbar(c.severity)}<span class="badge st-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span></div>
      <div class="region">${esc(c.region || "")} · updated ${ago(c.updated)}${nStrikes(c.id) ? ` · ${nStrikes(c.id)} attack${nStrikes(c.id) === 1 ? "" : "s"} / 7d` : ""}<span class="viewing" data-viewing="${esc(c.id)}" hidden></span></div>
      <div class="flags">${[...new Set(combat)].join(" ")}<span style="opacity:.5"> ${[...new Set(others)].join(" ")}</span>${(c.outlets || []).length < 2 ? `<span class="ob limited" title="${(c.outlets || []).length ? "Only " + esc(c.outlets[0]) + " has" : "None of the current outlets have"} reported on this recently">limited reporting</span>` : ""}</div>
    </a>`;
  }).join("") || `<div class="empty">No conflicts match these filters.<br><br><button id="clear-filters">Clear filters</button></div>`;
  // real links, so a conflict can be opened in a new tab; a plain click stays on the map
  document.querySelectorAll("#list .card").forEach(el => el.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault(); select(el.dataset.id);
  }));
  updateViewing();
  $("#clear-filters")?.addEventListener("click", () => {
    LIST.q = ""; LIST.status = ""; $("#q").value = ""; $("#region").value = ""; applyListFilter(); $("#q").focus();
  });
}

/* ---------- trust signals: checked against the article, how many outlets, outlet from a party country ---------- */
function checkedBadge(v) {
  if (v === 1) return `<span class="vb ok" title="Checked against the full text of the article it cites">✓ checked</span>`;
  if (v === 0) return `<span class="vb warn" title="The article couldn't be read to check this (paywall or blocked); treat with care">not checked</span>`;
  return `<span class="vb old" title="Recorded before claims were checked against their articles">older, unchecked</span>`;
}
function outletsBadge(outlets) {
  const n = (outlets || []).length;
  if (n >= 2) return `<span class="ob multi" title="Reported by ${esc(outlets.join(", "))}">${n} outlets</span>`;
  if (n === 1) return `<span class="ob one" title="Only ${esc(outlets[0])} has reported this so far">single source</span>`;
  return `<span class="ob gone" title="From a news source that is no longer used; it will age out">old source</span>`;
}
/* "US outlet" when the outlet's home country is itself a party to the conflict being read */
function partyOutletLabel(outlet, c) {
  const info = (STATE.meta.outlets || {})[outlet];
  if (!info || !info.country || !c || !c.parties.some(p => norm(p.country) === info.country)) return "";
  return `<span class="po" title="${esc(outlet)} (${esc(info.note)}) is based in ${esc(countryName(info.country))}, a party to this conflict">${esc(countryName(info.country))} outlet</span>`;
}
/* a party or consequence: its source links, or a "background" tag when no article stated it */
function citeMarks(x) {
  if ((x.sources || []).length) return x.sources.map(u => ` <a class="cite" href="${esc(u)}" target="_blank" rel="noopener" title="source: ${esc(host(u))}">↗</a>`).join("");
  return ` <span class="bg" title="From general background knowledge, not stated in a cited article">background</span>`;
}

function renderDetail() {
  const c = STATE.conflicts.find(x => x.id === selected); if (!c) return renderList();
  $("#reader").hidden = true; readerOpen = false;
  $("#list").hidden = true; $("#list-tools").hidden = true; const d = $("#detail"); d.hidden = false; reveal(d);
  const bySide = { A: [], B: [], other: [] };
  for (const p of c.parties) (bySide[p.side] || bySide.other).push(p);
  const party = (p) => {
    const iso = norm(p.country);
    return `<div class="party ${esc(p.side || "other")}"><span class="flag">${iso ? flag(iso) : "▪"}</span>
      <span class="pname">${esc(p.name)}</span><span class="role">${esc(p.role)}</span><span class="note">${esc(p.note || "")}${citeMarks(p)}</span></div>`;
  };
  const sideBlock = (k, lbl) => bySide[k].length ? `<div class="side"><div class="lbl">${lbl}</div>${bySide[k].map(party).join("")}</div>` : "";
  d.innerHTML = `
    <button class="back">← ${backCountry ? esc(countryName(backCountry)) : GOOD.on ? "good news" : "all conflicts"}</button>
    <h2>${esc(c.name)}</h2>
    <div class="meta"><span class="badge st-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span>${sevbar(c.severity)} <span>${esc(c.region || "")}</span>
      ${(c.outlets || []).length < 2 ? `<span class="ob limited" title="Fewer than two current outlets have reported on this recently">limited reporting</span>` : ""}
      <span class="viewing in-detail" data-viewing="${esc(c.id)}" hidden></span>${reportLink("conflict", c.id, c.name)}</div>
    <div class="ai-note">Summarised by AI from the news sources below; <button class="linkish" data-about>how this works</button>.</div>
    ${GOOD.on ? "" : statTiles(c) + territoryBlock(c) + `<p class="summary">${esc(c.summary)}</p>` + figureList(c)}
    <h3>Who is involved</h3>
    ${sideBlock("A", "Side A")}${sideBlock("B", "Side B")}${sideBlock("other", "Mediators / others")}
    ${GOOD.on ? "" : `<h3>Consequences</h3>
    <div class="cons">${(c.consequences || []).map(x => `<div class="con"><span class="cat">${esc(x.category)}</span><span>${esc(x.text)}${(x.affects || []).length ? ` <span style="opacity:.6">${x.affects.map(a => flag(norm(a))).join(" ")}</span>` : ""}${citeMarks(x)}</span></div>`).join("") || "<div class='empty'>none recorded</div>"}</div>`}
    <h3>${GOOD.on ? "Good news" : "Latest developments"}</h3>
    ${(c.developments || []).map(x => `<div class="dev" data-url="${esc((x.sources || [])[0] || "")}"${(x.sources || []).length ? ` tabindex="0" role="button"` : ""}><span class="date">${esc(x.date)}</span><span>${esc(x.text)}${(x.sources || []).map(u => ` <a href="${esc(u)}" target="_blank" title="open original">↗</a>`).join("")}
      <span class="trust">${checkedBadge(x.verified)}${outletsBadge(x.outlets)}${(x.outlets || []).map(o => partyOutletLabel(o, c)).join("")}</span></span></div>`).join("")}
    ${GOOD.on ? "" : `<h3>Reported attacks (7 days)</h3>
    ${conflictStrikes(c.id).map(st => `<div class="strike" data-id="${st.id}" tabindex="0" role="button">
      <span class="date">${esc(st.date.slice(5).replace("-", "/"))}</span><span class="w">${weaponSvg(st.weapon)}</span>
      <span class="body"><span class="route">${(st.attacker && st.attacker !== "unknown") ? esc(st.attacker) + " → " : st.origin_name ? esc(st.origin_name) + " → " : ""}${esc(st.target_name)}</span><span class="prec">${esc(st.target_precision)}</span><br>
      <span class="meta">${esc(st.weapon)}${st.launched != null ? ` · ${st.launched} launched` : ""}${st.intercepted != null ? ` · ${st.intercepted} intercepted` : ""}${st.outcome ? ` · ${esc(st.outcome)}` : ""}</span>
      <span class="trust">${checkedBadge(st.verified)}${outletsBadge(st.outlets)}${(st.outlets || []).map(o => partyOutletLabel(o, c)).join("")}</span></span>
    </div>`).join("") || "<div class='empty'>none reported in the feeds</div>"}`}
    <h3>Sources</h3>
    ${(c.sources || []).slice(0, 12).map(s => `<div class="src" tabindex="0" role="button" data-url="${esc(s.link)}" data-title="${esc(s.title)}" data-source="${esc(s.outlet || s.source)}">${esc(s.title)} <span class="s">— ${esc(s.outlet || s.source)}</span>${s.outlet ? partyOutletLabel(s.outlet, c) : `<span class="ob gone" title="A news source that is no longer used">old source</span>`} <a href="${esc(s.link)}" target="_blank" title="open original">↗</a></div>`).join("")}
  `;
  d.querySelector(".back").addEventListener("click", goBack);
  updateViewing();  d.querySelectorAll(".fig[data-url]").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A") return;
    openArticle(el.dataset.url, { title: el.dataset.title, source: el.dataset.source });
  }));
  d.querySelectorAll(".src").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A") return;
    openArticle(el.dataset.url, { title: el.dataset.title, source: el.dataset.source });
  }));
  d.querySelectorAll(".dev").forEach(el => el.addEventListener("click", (ev) => {
    if (ev.target.tagName === "A" || !el.dataset.url) return;
    openArticle(el.dataset.url, {});
  }));
  d.querySelectorAll(".strike").forEach(el => el.addEventListener("click", () => {
    const st = STATE.strikes.find(x => x.id === +el.dataset.id);
    if (!st) return;
    map.flyTo({ center: [st.target_lon, st.target_lat], zoom: Math.max(map.getZoom(), 5.5), speed: 0.9, padding: sheetPadding() });
    if (st.link) openArticle(st.link, { title: st.title, source: st.source, context: strikeHtml(st), report: strikeReport(st) });   // show the report too
    else if (isMobile() && $("#panel").dataset.sheet === "full") setSheet("peek");
  }));
}

function stopSpin() { if ($("#tg-rotate").checked) { $("#tg-rotate").checked = false; $("#tg-rotate").dispatchEvent(new Event("change")); } }
function select(id, opts = {}) {
  const prev = selected, kbd = $("#panel").contains(document.activeElement) || document.activeElement?.classList.contains("mk");
  selected = id; selectedCountry = null; backCountry = (id && opts.fromCountry) || null;
  if (id) stopSpin();
  const c = STATE.conflicts.find(x => x.id === id);
  setHashParam("c", null); setHashParam("country", null);
  if (c && isMobile() && $("#panel").dataset.sheet === "min") setSheet("peek");
  if (c && c.epicenter && !opts.keepView) map.flyTo({ center: [c.epicenter.lon, c.epicenter.lat], zoom: Math.max(map.getZoom(), 3.2), speed: 0.55, curve: 1.3, essential: true, padding: sheetPadding() });
  renderMarkers(); renderArcs(); applyInvolvement(); renderStrikes();
  if (c) renderDetail(); else renderList();
  syncPath();
  if (id !== prev) ping();
  // keyboard users land on the new view: the back button, or the card they came from
  if (kbd) (c ? $("#detail .back") : prev && document.querySelector(`.card[data-id="${CSS.escape(prev)}"]`))?.focus({ preventScroll: !c });
}

/* ---------- "Report a problem": goes privately to the maintainer, nothing is shown on the site ---------- */
const REPORT_REASONS = {
  conflict: ["Not an armed conflict", "Wrong sides or parties", "Wrong status or severity", "Out of date", "Wrong figures", "Duplicate of another conflict", "Other"],
  strike: ["Wrong location", "Not an attack / didn't happen", "Wrong attacker or weapon", "Belongs to another conflict", "Duplicate", "Other"],
  incident: ["Wrong location", "Not violence or conflict", "Other"],
  local: ["Wrong location", "Not news / spam", "Offensive or harmful", "Other"],
};
const reportLink = (kind, ref, title) =>
  `<button class="report-link" data-report-kind="${esc(kind)}" data-report-ref="${esc(ref)}" data-report-title="${esc(title)}" title="Tell the maintainer something is wrong here">⚑ Report a problem</button>`;
function strikeReport(st) {
  const who = st.attacker && st.attacker !== "unknown" ? st.attacker : (st.origin_name || "");
  return { kind: "strike", ref: String(st.id), title: `Attack: ${who ? who + " → " : ""}${st.target_name} (${st.date}, ${st.weapon})` };
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-report-kind]"); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  openReport(b.dataset.reportKind, b.dataset.reportRef, b.dataset.reportTitle);
});
function openReport(kind, ref, title) {
  const r = $("#reader"); readerSeq++;
  $("#list").hidden = true; $("#detail").hidden = true; $("#list-tools").hidden = true; r.hidden = false; readerOpen = true; reveal(r);
  if (isMobile()) setSheet("full");
  $("#panel").scrollTop = 0;
  r.innerHTML = `<button class="back">← back</button>
    <h2>Report a problem</h2>
    <div class="meta">${esc(title)}</div>
    <form id="report-form" class="report-form">
      <fieldset><legend>What's wrong?</legend>
        ${(REPORT_REASONS[kind] || ["Other"]).map((x, i) => `<label><input type="radio" name="reason" value="${esc(x)}"${i ? "" : " required"}> ${esc(x)}</label>`).join("")}
      </fieldset>
      <label class="note"><span>Details <span class="opt">(optional)</span></span>
        <textarea name="note" maxlength="1000" rows="4" placeholder="e.g. this attack hit Kharkiv, not Kyiv; or a link to a better source"></textarea></label>
      <input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">Send report</button>
      <div class="fine">Reports go privately to the maintainer and help fix the map. Nothing you write is shown on the site.</div>
    </form>`;
  r.querySelector(".back").addEventListener("click", closeReader);
  r.querySelector("input[name=reason]")?.focus({ preventScroll: true });
  r.querySelector("#report-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Sending…";
    let res;
    try {
      res = await (await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        kind, ref, title, reason: f.reason.value, note: f.note.value, website: f.website.value, page: location.hash.slice(0, 300) }) })).json();
    } catch (_) { res = { error: "couldn't reach the server" }; }
    if (res.ok) {
      f.outerHTML = `<div class="report-done">Thanks, your report has been sent. <button class="back2">Back to the map</button></div>`;
      r.querySelector(".back2").addEventListener("click", closeReader);
      if (!STATE.meta.serve_only) loadReports();
    } else {
      btn.disabled = false; btn.textContent = "Send report";
      f.querySelector(".fine").textContent = `Not sent: ${res.error || "unknown error"}.`;
    }
  });
}

/* the home viewer (never the public one) lists incoming reports for review */
let REPORTS = [];
async function loadReports() {
  if (!STATE || STATE.meta.serve_only) return;
  try { REPORTS = (await (await fetch("/api/reports")).json()).reports || []; } catch (_) { return; }
  const open = REPORTS.filter(x => x.status !== "resolved").length;
  $("#reports-btn").hidden = !REPORTS.length;
  $("#reports-btn .n").textContent = open;
  $("#reports-btn").classList.toggle("has-open", open > 0);
}
function openReports() {
  const r = $("#reader"); readerSeq++;
  $("#list").hidden = true; $("#detail").hidden = true; $("#list-tools").hidden = true; r.hidden = false; readerOpen = true; reveal(r);
  if (isMobile()) setSheet("full");
  const row = (x) => `<div class="rep ${x.status === "resolved" ? "done" : ""}" data-id="${esc(x.id)}">
      <div class="rep-h"><span class="rep-kind">${esc(x.kind)}</span> <b>${esc(x.reason)}</b> <span class="rep-t">${esc(ago(x.ts))}</span></div>
      <div class="rep-title">${esc(x.title)}</div>
      ${x.note ? `<div class="rep-note">“${esc(x.note)}”</div>` : ""}
      <div class="rep-actions"><button data-act="go">Go to it</button><button data-act="toggle">${x.status === "resolved" ? "Reopen" : "Mark resolved"}</button></div>
    </div>`;
  r.innerHTML = `<button class="back">← back</button><h2>Problem reports</h2>
    <div class="meta">Sent by visitors from the public site and this one. Only visible here.</div>
    ${REPORTS.map(row).join("") || "<div class='empty'>No reports yet.</div>"}`;
  r.querySelector(".back").addEventListener("click", closeReader);
  r.querySelectorAll(".rep").forEach(el => el.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const x = REPORTS.find(y => y.id === el.dataset.id);
    if (b.dataset.act === "toggle") {
      await fetch(`/api/reports/${encodeURIComponent(x.id)}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: x.status === "resolved" ? "open" : "resolved" }) });
      await loadReports(); openReports();
    } else goToReport(x);
  }));
}
function goToReport(x) {
  const view = new URLSearchParams((x.page || "").replace(/^#/, "")).get("map");
  if (x.kind === "conflict" && STATE.conflicts.find(c => c.id === x.ref)) { select(x.ref); return; }
  if (x.kind === "strike") {
    const st = (STATE.strikes || []).find(s => String(s.id) === x.ref);
    if (st) { select(st.conflict_id, { keepView: true }); map.flyTo({ center: [st.target_lon, st.target_lat], zoom: Math.max(map.getZoom(), 5.5) }); return; }
  }
  if (x.kind === "incident") {
    const [la, lo] = x.ref.split(" ")[0].split(",").map(Number);
    if (!isNaN(la)) { closeReader(); map.flyTo({ center: [lo, la], zoom: Math.max(map.getZoom(), 6) }); return; }
  }
  if (x.kind === "local") { openArticle(x.ref, { title: x.title }); }
  if (view) { const [z, la, lo] = view.split("/").map(Number); if (!isNaN(lo)) map.flyTo({ center: [lo, la], zoom: z }); }
}
$("#reports-btn").addEventListener("click", () => { loadReports().then(openReports); });

/* ---------- About: where the information comes from and how it is checked ---------- */
function openAbout() {
  const r = $("#reader"); readerSeq++;
  $("#list").hidden = true; $("#detail").hidden = true; $("#list-tools").hidden = true; r.hidden = false; readerOpen = true; reveal(r);
  if (isMobile()) setSheet("full");
  $("#panel").scrollTop = 0;
  const outlets = Object.entries((STATE && STATE.meta.outlets) || {});
  r.innerHTML = `<button class="back">← back</button>
    <h2>How this works</h2>
    <div class="about about-page">
      <p>Global News Map reads a small set of established news outlets every 30 minutes. An AI model running on our own machine turns those reports into the conflicts, parties, developments and attacks you see here. It is a news digest, not an intelligence product. Don't rely on it for safety decisions.</p>
      <h3>Sources</h3>
      <p>Only outlets with strong editorial standards and a public corrections record, whose articles we can read in full:</p>
      <ul class="outlets">${outlets.map(([k, v]) => `<li><b>${esc(k)}</b> <span>${esc(v.note)}</span></li>`).join("")}</ul>
      <p>We deliberately don't use state-controlled or partisan outlets, outlets tied to one side of a conflict they cover, aggregators, or sites whose articles we can't read to check.</p>
      <h3>How claims are checked</h3>
      <ul>
        <li><span class="vb ok">✓ checked</span> Every new attack and development is re-read against the full text of the article it cites. If the article doesn't say it (a different place, attacker, date or number), it is thrown away.</li>
        <li><span class="vb warn">not checked</span> The article couldn't be read (paywall or blocked), so the claim rests on the headline and summary alone.</li>
        <li><span class="ob multi">3 outlets</span> <span class="ob one">single source</span> How many independent outlets have reported the same thing.</li>
        <li><span class="po">United States outlet</span> The outlet is based in a country that is itself a party to that conflict: weigh its claims accordingly.</li>
        <li><span class="bg">background</span> A party or consequence the AI knows from background knowledge rather than from a cited article.</li>
        <li><span class="ob limited">limited reporting</span> Fewer than two outlets have covered this conflict recently.</li>
        <li>Casualty and displacement figures are quoted word for word from the article, with who reported them, and marked when the number comes from one of the warring sides.</li>
      </ul>
      <h3>Automatic layers</h3>
      <p>News heat, incidents and local news come from GDELT, which places news on the map by machine: useful for spotting activity, often wrong in the detail. Military aircraft and ships are public transponder data, shown at least 20 minutes late, and only for those that broadcast.</p>
      <h3>Occupied territory and satellite imagery</h3>
      <p>The hatched red area in Ukraine is the territory <a href="https://deepstatemap.live/en" target="_blank" rel="noopener">DeepStateMap.Live</a> shows as Russian-occupied, fetched once a day; grey is its "unknown status". DeepStateMap is a Ukrainian volunteer project and holds back Ukrainian gains for a while for security reasons. The satellite view is <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (contains modified Copernicus Sentinel data 2016 &amp; 2017), a cloud-free mosaic from 2016, not live imagery.</p>
      <h3>Where the map opens</h3>
      <p>On a first visit the globe turns to your country, looked up from your IP address in a copy of <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a>'s free database on our own server. The address isn't sent anywhere else or kept.</p>
      <h3>Found a mistake?</h3>
      <p>Use <b>⚑ Report a problem</b> on the item. Reports go straight to the maintainer. You can also join the <a href="https://discord.gg/f2esHm5fr" target="_blank" rel="noopener">Discord</a>.</p>
    </div>`;
  r.querySelector(".back").addEventListener("click", closeReader);
  syncPath();
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-about]")) { e.preventDefault(); openAbout(); } });

/* back from a conflict: to the country view it was opened from, else to the list */
function goBack() { if (backCountry) selectCountry(backCountry); else select(null); }

/* ---------- country view: every conflict a country is part of, and who is with / against it ---------- */
const REL_COLOR = { self: "#f2efe6", ally: SIDE_COLOR.A, enemy: SIDE_COLOR.B, other: SIDE_COLOR.other };
const countryName = (iso) => ((COUNTRIES[iso] || {}).label || cname(iso)).replace("United States of America", "United States");
/* per conflict: the country's own party entry and everyone else, sorted into same side / opposing / other;
   byIso merges them over all conflicts (opposing beats same side beats other, for the map colour) */
function countryRelations(iso) {
  const rank = { enemy: 3, ally: 2, other: 1 }, byIso = {};
  const perConflict = conflictsFor(iso).map(c => {
    const mine = c.parties.filter(p => norm(p.country) === iso);
    const me = mine.find(p => p.role === "combatant") || mine[0];
    const mySide = me.side === "A" || me.side === "B" ? me.side : null;
    const groups = { ally: [], enemy: [], other: [] };
    for (const p of c.parties) {
      const piso = norm(p.country);
      if (piso === iso) continue;
      const rel = !mySide || !(p.side === "A" || p.side === "B") ? "other" : p.side === mySide ? "ally" : "enemy";
      groups[rel].push(p);
      if (piso && (rank[rel] > (rank[byIso[piso]] || 0))) byIso[piso] = rel;
    }
    return { c, me, groups };
  });
  return { perConflict, byIso };
}
function selectCountry(iso) {
  const kbd = $("#panel").contains(document.activeElement);
  selected = null; selectedCountry = iso; backCountry = null;
  stopSpin();
  setHashParam("c", null); setHashParam("country", iso);
  if (isMobile() && $("#panel").dataset.sheet === "min") setSheet("peek");
  renderMarkers(); renderArcs(); applyInvolvement(); renderStrikes();
  renderCountry();
  syncPath();
  if (kbd) $("#detail .back")?.focus({ preventScroll: true });
}
function renderCountry() {
  const iso = selectedCountry, { perConflict } = countryRelations(iso);
  $("#reader").hidden = true; readerOpen = false;
  $("#list").hidden = true; $("#list-tools").hidden = true; const d = $("#detail"); d.hidden = false; reveal(d);
  const who = (ps) => ps.map(p => { const i = norm(p.country); return `${i ? flag(i) + " " : ""}${esc(p.name)}`; }).join(", ");
  const roleText = (me) => `${esc(me.role)}${me.side === "A" || me.side === "B" ? `, side ${esc(me.side)}` : ""}${me.note ? ` · ${esc(me.note)}` : ""}`;
  const name = countryName(iso);
  d.innerHTML = `
    <button class="back">← all conflicts</button>
    <h2>${flag(iso)} ${esc(name)}</h2>
    <div class="meta">Involved in ${perConflict.length} conflicts</div>
    ${GOOD.on ? "" : adviceHtml(iso)}
    <div class="rel-key"><span><i style="background:${REL_COLOR.ally}"></i>same side</span><span><i style="background:${REL_COLOR.enemy}"></i>opposing side</span><span><i style="background:${REL_COLOR.other}"></i>mediators &amp; others</span></div>
    ${perConflict.map(({ c, me, groups }) => `<div class="card ccard" data-id="${esc(c.id)}" tabindex="0" role="button">
      <div class="head"><span class="name">${esc(c.name)}</span>${sevbar(c.severity)}<span class="badge st-${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span></div>
      <div class="myrole">${esc(name)}: ${roleText(me)}</div>
      ${groups.ally.length ? `<div class="rel ally"><b>with</b> ${who(groups.ally)}</div>` : ""}
      ${groups.enemy.length ? `<div class="rel enemy"><b>against</b> ${who(groups.enemy)}</div>` : ""}
      ${groups.other.length ? `<div class="rel other"><b>also</b> ${who(groups.other)}</div>` : ""}
    </div>`).join("")}`;
  d.querySelector(".back").addEventListener("click", () => select(null));
  d.querySelectorAll(".ccard").forEach(el => el.addEventListener("click", () => select(el.dataset.id, { fromCountry: iso })));
}

/* ---------- remember settings across reloads (per browser) ---------- */
const SETTINGS_KEY = "conflictMapSettings";
const SETTING_IDS = ["tg-globe", "tg-rotate", "tg-night", "tg-sat", "tg-territory", "tg-heat", "tg-arcs", "tg-gdelt-arcs", "tg-strikes",
                     "tg-incidents", "tg-aircraft", "tg-ships", "tg-local", "tg-advice", "window", "sort"];
const SETTINGS_VERSION = 3;     // 2: spin off by default; a saved "spin on" from before was just the old default
                                // 3: satellite on by default; a saved "satellite off" from before was the old default
function saveSettings() {
  const out = {};
  for (const id of SETTING_IDS) { const el = document.getElementById(id); if (el) out[id] = el.type === "checkbox" ? el.checked : el.value; }
  if (GOOD.stash) Object.assign(out, GOOD.stash);
  if (CYBER.stash) Object.assign(out, CYBER.stash);
  if (WEATHER.stash) Object.assign(out, WEATHER.stash);
  out.v = SETTINGS_VERSION;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (_) {}
}
function restoreSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (_) {}
  for (const id of SETTING_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", saveSettings);
    if (!saved || !(id in saved)) continue;
    if (id === "tg-rotate" && (sharedView || !(saved.v >= 2))) continue;   // shared links stay still; pre-v2 "on" was the old default
    if (id === "tg-sat" && !(saved.v >= 3)) continue;
    const cur = el.type === "checkbox" ? el.checked : el.value;
    if (cur === saved[id]) continue;
    if (el.type === "checkbox") el.checked = saved[id]; else el.value = saved[id];
    if (id !== "window" && id !== "sort") el.dispatchEvent(new Event("change"));   // apply it through the normal handler (those two are read on load)
  }
}

/* ---------- conflict stats ---------- */
const FIG_LABEL = {
  killed: "killed", casualties: "killed + wounded", killed_civilians: "civilians killed", wounded: "wounded",
  displaced: "displaced", refugees: "refugees", in_need: "need aid", hostages: "hostages", missing: "missing",
};
function fmtNum(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (v >= 1e4) return Math.round(v / 1e3) + "k";
  return v.toLocaleString("en-GB");
}
function parseStart(d) {
  const m = String(d || "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  return m ? { date: new Date(Date.UTC(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1)), precision: m[3] ? "day" : m[2] ? "month" : "year" } : null;
}
function durationText(start) {
  const days = Math.floor((Date.now() - start.date.getTime()) / 86400000);
  if (days < 60) return { big: `${days}`, unit: days === 1 ? "day" : "days" };
  const years = days / 365.25;
  if (years < 2) return { big: `${Math.round(days / 30.44)}`, unit: "months" };
  return { big: years.toFixed(1).replace(/\.0$/, ""), unit: "years" };
}
function partyIsos(c) { return [...new Set(c.parties.map(p => norm(p.country)).filter(Boolean))]; }
function statTiles(c) {
  const tiles = [];
  const st = c.stats || {};
  const start = parseStart(st.started && st.started.date);
  if (start) {
    const dur = durationText(start);
    const fmt = { day: { day: "numeric", month: "short", year: "numeric" }, month: { month: "short", year: "numeric" }, year: { year: "numeric" } }[start.precision];
    const since = start.date.toLocaleDateString("en-GB", { ...fmt, timeZone: "UTC" });
    tiles.push(`<div class="tile" title="${esc(st.started.event || "")}${st.started.basis === "background" ? " (start date from background knowledge, not a cited article)" : ""}">
      <div class="big">${dur.big}<span class="unit"> ${dur.unit}</span></div><div class="lbl">since ${esc(since)}</div></div>`);
  }
  const a = c.activity || {};
  if (a.attacks_7d || a.attacks_prev_7d) {
    const diff = (a.attacks_7d || 0) - (a.attacks_prev_7d || 0);
    const fullPrevWeek = STATE.meta.attacks_since && (Date.now() / 1000 - STATE.meta.attacks_since) > 14 * 86400;
    const trend = !fullPrevWeek ? "" : diff > 0 ? `<span class="up">▲ ${diff}</span>` : diff < 0 ? `<span class="down">▼ ${-diff}</span>` : `<span class="flat">=</span>`;
    tiles.push(`<div class="tile" title="Located attacks extracted from the news, this week vs the week before">
      <div class="big">${a.attacks_7d || 0} ${trend}</div><div class="lbl">attacks reported, 7 days</div></div>`);
  }
  const isos = partyIsos(c);
  const inc = (STATE.gdelt.incidents || []).filter(i => isos.includes(i.iso3)).reduce((n, i) => n + i.n, 0);
  if (inc) tiles.push(`<div class="tile" title="GDELT fighting / mass-violence events located in the parties' countries (press attention, not a verified count)">
      <div class="big">${fmtNum(inc)}</div><div class="lbl">press-reported clashes, ${STATE.gdelt.hours}h</div></div>`);
  const outlets = new Set((c.sources || []).map(s => s.source)).size;
  if (outlets) tiles.push(`<div class="tile" title="Distinct outlets among this conflict's recent sources"><div class="big">${outlets}</div><div class="lbl">outlets reporting</div></div>`);
  return tiles.length ? `<div class="tiles">${tiles.join("")}</div>` : "";
}
function figureList(c) {
  const figs = ((c.stats || {}).figures || []).slice().sort((x, y) => (y.cumulative === true) - (x.cumulative === true) || (y.as_of || "").localeCompare(x.as_of || ""));
  if (!figs.length) return "";
  const sideName = (side) => side === "A" || side === "B" ? (c.parties.find(p => p.side === side && p.role === "combatant") || {}).name || `side ${side}` : "";
  const rows = figs.slice(0, 8).map(f => {
    const who = sideName(f.side);
    const period = f.cumulative ? "since the start" : f.period;
    return `<div class="fig" data-url="${esc(f.link || "")}"${f.link ? ` tabindex="0" role="button"` : ""} data-title="${esc(f.title || "")}" data-source="${esc(f.source || "")}">
      <div class="fighead"><span class="num">${fmtNum(f.value)}</span> <span class="what">${esc(FIG_LABEL[f.key] || f.key)}${who ? ` · ${esc(who)}` : ""}</span>
        <span class="per">${esc(period)}</span>${f.claimant_is_party ? `<span class="claim" title="Figure published by one of the warring parties">party claim</span>` : ""}</div>
      ${f.quote ? `<div class="quote">“${esc(f.quote)}”</div>` : ""}
      <div class="figsrc">${esc(f.reported_by || "")}${f.as_of ? ` · ${esc(f.as_of)}` : ""} · ${esc(f.source || "")} <a href="${esc(f.link || "#")}" target="_blank" rel="noopener" title="open original">↗</a></div>
    </div>`;
  }).join("");
  return `<h3>Figures in recent reports</h3><div class="figs">${rows}</div>
    <div class="fignote">Quoted from the linked articles. Counts differ between sources and are often disputed.</div>`;
}

/* ---------- reader: show an article in the panel instead of leaving the site ---------- */
let readerOpen = false, readerSeq = 0;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
async function openArticle(url, opts = {}) {
  const r = $("#reader"); const seq = ++readerSeq;
  $("#list").hidden = true; $("#detail").hidden = true; r.hidden = false; readerOpen = true; reveal(r);
  if (isMobile()) setSheet("full");
  $("#panel").scrollTop = 0;
  const alts = opts.alternatives && opts.alternatives.length > 1 ? opts.alternatives : null;
  const altHtml = alts ? `<div class="alt">${alts.map(u => `<div class="${u === url ? "on" : ""}" data-url="${esc(u)}">${esc(host(u))}</div>`).join("")}</div>` : "";
  $("#list-tools").hidden = true;
  r.innerHTML = `<button class="back">← back</button>
    ${opts.context ? `<div class="meta" style="margin-bottom:8px">${opts.context}</div>` : ""}${opts.report ? `<div class="report-row">${reportLink(opts.report.kind, opts.report.ref, opts.report.title)}</div>` : ""}${altHtml}
    <div class="site">${esc(opts.source || host(url))}</div>
    <h2>${esc(opts.title || "")}</h2>
    <div class="loading">Loading article</div>`;
  r.querySelector(".back").addEventListener("click", closeReader);
  r.querySelectorAll(".alt div").forEach(el => { el.tabIndex = 0; el.setAttribute("role", "button"); el.addEventListener("click", () => openArticle(el.dataset.url, opts)); });
  if ($("#panel").contains(document.activeElement)) r.querySelector(".back").focus({ preventScroll: true });
  let a;
  try { a = await (await fetch(`/api/article?url=${encodeURIComponent(url)}`)).json(); }
  catch (_) { a = { ok: false, error: "could not reach the server" }; }
  if (a && a.error && /too many/.test(a.error)) a.error = "you've opened a lot of articles in the last minute; wait a moment";
  if (seq !== readerSeq) return;           // another article was opened meanwhile
  const orig = `<a href="${esc(a.final_url || url)}" target="_blank">open original ↗</a>`;
  if (!a.ok) {
    r.querySelector(".loading").outerHTML = `<div class="err">Couldn't extract this article (${esc(a.error || "unknown error")}).<br>${orig}</div>`;
    return;
  }
  r.querySelector(".site").textContent = a.site || host(a.final_url || url);
  r.querySelector("h2").textContent = a.title || opts.title || "";
  r.querySelector(".loading").outerHTML =
    `<div class="meta">${[a.byline, a.date].filter(Boolean).map(esc).join(" · ")}${a.byline || a.date ? " · " : ""}${orig}</div>` +
    (a.image ? `<img class="hero" src="${esc(a.image)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    (a.note ? `<div class="err">${esc(a.note)}</div>` : "") +
    a.paragraphs.map(t => `<p>${esc(t)}</p>`).join("") +
    `<div class="meta" style="margin-top:14px">Reader view · ${orig}</div>`;
}
function closeReader() {
  const kbd = $("#panel").contains(document.activeElement);
  readerOpen = false; $("#reader").hidden = true;
  if (isMobile() && $("#panel").dataset.sheet === "full") setSheet("peek");
  $("#panel").scrollTop = 0;
  if (selected && STATE.conflicts.find(c => c.id === selected)) renderDetail();
  else if (selectedCountry) renderCountry(); else renderList();
  syncPath();
  if (kbd) ($("#detail:not([hidden]) .back") || $("#q"))?.focus({ preventScroll: true });
}

function openStrikeFeature(f, lngLat) {
  const p = f.properties;
  if (p.link) openArticle(p.link, { title: p.title, source: p.source, context: strikeHtml(p), report: strikeReport(p) });
  else {
    const r = strikeReport(p);
    new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(lngLat).setHTML(strikeHtml(p) + `<br>${reportLink(r.kind, r.ref, r.title)}`).addTo(map);
  }
}
function openIncidentFeature(f) {
  const p = f.properties;
  let urls = [];
  try { urls = JSON.parse(p.urls || "[]"); } catch (_) { urls = p.url ? [p.url] : []; }
  const coords = f.geometry.coordinates.map(v => (+v).toFixed(3)).reverse().join(",");
  if (urls.length) openArticle(urls[0], { alternatives: urls, context: incidentHtml(p) + `<div style="opacity:.55;margin-top:4px">Articles GDELT tagged with this place. Placement is automatic and can be wrong.</div>`,
    report: { kind: "incident", ref: `${coords} ${urls[0]}`, title: `Incident: ${p.name || ""}` } });
}
/* fingers are imprecise: on touch screens a tap near a strike / incident circle counts as a hit */
function fuzzyTap(e) {
  if (!coarseMQ.matches || e.originalEvent._handled) return false;
  const r = 14, { x, y } = e.point;
  const layers = ["aircraft", "strike-impacts", "incidents", "local-news"].filter(id => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
  const hits = map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers });
  if (!hits.length) return false;
  e.originalEvent._handled = true;
  const f = hits.find(h => h.layer.id === "aircraft") || hits.find(h => h.layer.id === "strike-impacts") || hits[0];
  if (f.layer.id === "aircraft") openAircraftFeature(f);
  else if (f.layer.id === "strike-impacts") openStrikeFeature(f, e.lngLat);
  else if (f.layer.id === "local-news") openLocalFeature(f); else openIncidentFeature(f);
  return true;
}

/* ---------- military ships ---------- */
const SHIP_COLOR = "#8fd3ff";
let SHIPS = null;
/* top-down hull, bow up */
function shipIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"); g.beginPath();
  [[24, 3], [31, 14], [31, 41], [24, 45], [17, 41], [17, 14]].forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  if (outline) { g.lineJoin = "round"; g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.9)"; g.stroke(); g.fillStyle = "rgba(0,0,0,0.9)"; g.fill(); }
  else { g.fillStyle = "#fff"; g.fill(); g.globalCompositeOperation = "destination-out"; g.fillRect(21, 20, 6, 9); }   // superstructure cut-out
  return g.getImageData(0, 0, n, n);
}
async function loadShips() {
  if (!$("#tg-ships").checked || document.hidden) return;
  try { SHIPS = await (await fetch("/api/ships")).json(); } catch (_) { return; }
  const list = SHIPS.ships || [];
  map.getSource("ships").setData({ type: "FeatureCollection", features: list.map(v => ({
    type: "Feature", geometry: { type: "Point", coordinates: [v.lon, v.lat] }, properties: { ...v, trail: undefined } })) });
  map.getSource("ship-trails").setData({ type: "FeatureCollection", features: list.filter(v => v.trail.length > 1).map(v => ({
    type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: v.trail } })) });
  const lbl = $("#ships-count");
  lbl.textContent = SHIPS.enabled ? `(${list.length})` : "(off)";
  lbl.parentElement.title = SHIPS.enabled
    ? `Naval vessels broadcasting AIS in watched seas, ${SHIPS.delay_min}-min delay. Most warships switch AIS off; auxiliaries and patrol vessels are the usual catch.`
    : "Ship layer needs an aisstream.io API key on the server";
}
function shipHtml(p, full = true) {
  const kn = p.sog != null && p.sog !== "" ? `${(+p.sog).toFixed(1)} kn` : "";
  const when = p.seen ? new Date(p.seen * 1000).toISOString().slice(11, 16) + " UTC" : "";
  let h = `<b>${esc(p.name)}</b>${p.callsign ? ` · ${esc(p.callsign)}` : ""}<br>${[kn, p.dest ? "→ " + esc(p.dest) : ""].filter(Boolean).join(" · ")}`;
  if (full) h += `<br><span style="opacity:.6">Position at ${when}, shown ${SHIPS ? SHIPS.delay_min : 20} min late on purpose.<br>AIS via aisstream.io. MMSI ${esc(p.mmsi)}.</span>` +
    `<br><a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(p.mmsi)}" target="_blank" rel="noopener">more on MarineTraffic ↗</a>`;
  return h;
}

/* ---------- military aircraft ---------- */
const AIRCRAFT_COLOR = { tanker: "#5ec8e5", isr: "#c792ff", transport: "#e6e4da", combat: "#ff5a5a", heli: "#7ed67e", other: "#f0f3fa" };
let AIR = null;             // last /api/aircraft
/* top-down plane silhouette, nose up, drawn once as an SDF so the layer can tint it */
/* weapon icon in its own colour with a dark outline baked in (48px canvas, shown at 24px) */
function weaponIcon(w) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"), paths = WEAPON_GLYPH[w].d.map(d => new Path2D(d));
  g.scale(1.6, 1.6); g.translate(3, 3);            // 24-unit glyph centred with room for the outline
  g.lineJoin = "round"; g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,0.9)"; g.fillStyle = "rgba(0,0,0,0.9)";
  for (const p of paths) { g.stroke(p); g.fill(p); }
  g.fillStyle = WEAPON_COLOR[w] || WEAPON_COLOR.other;
  for (const p of paths) g.fill(p);
  return g.getImageData(0, 0, n, n);
}
function planeIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"); g.beginPath();
  const pts = [[24, 3], [27, 9], [27, 19], [44, 29], [44, 33], [27, 28], [26, 38], [32, 43], [32, 46], [24, 43.5],
               [16, 46], [16, 43], [22, 38], [21, 28], [4, 33], [4, 29], [21, 19], [21, 9]];
  pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  if (outline) { g.lineJoin = "round"; g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.9)"; g.stroke(); g.fillStyle = "rgba(0,0,0,0.9)"; }
  else g.fillStyle = "#fff";
  g.fill();
  return g.getImageData(0, 0, n, n);
}
/* top-down helicopter: rotor disc with two blades, fuselage, tail boom and tail rotor, nose up */
function heliIcon(outline = false) {
  const n = 48, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d");
  const ink = outline ? "rgba(0,0,0,0.9)" : "#fff";
  g.strokeStyle = ink; g.fillStyle = ink; g.lineCap = "round";
  const pad = outline ? 3 : 0;
  // fuselage + tail boom + tail rotor
  g.beginPath(); g.ellipse(24, 20, 6 + pad, 9 + pad, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 3 + pad * 2; g.beginPath(); g.moveTo(24, 27); g.lineTo(24, 42); g.stroke();
  g.lineWidth = 2.5 + pad * 2; g.beginPath(); g.moveTo(19, 42); g.lineTo(29, 42); g.stroke();
  // main rotor: two crossed blades + faint disc
  g.lineWidth = 2.5 + pad * 2; g.beginPath(); g.moveTo(6, 8); g.lineTo(42, 32); g.moveTo(42, 8); g.lineTo(6, 32); g.stroke();
  if (!outline) { g.globalAlpha = 0.35; g.lineWidth = 1.5; g.beginPath(); g.arc(24, 20, 21, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
  return g.getImageData(0, 0, n, n);
}
async function loadAircraft() {
  if (!$("#tg-aircraft").checked || document.hidden) return;
  try { AIR = await (await fetch("/api/aircraft")).json(); } catch (_) { return; }
  const list = AIR.aircraft || [];
  map.getSource("aircraft").setData({ type: "FeatureCollection", features: list.map(a => ({
    type: "Feature", geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    properties: { ...a, trail: undefined },
  })) });
  map.getSource("aircraft-trails").setData({ type: "FeatureCollection", features: list.filter(a => a.trail.length > 1).map(a => {
    const parts = [[a.trail[0]]];                  // break the trail where it crosses the antimeridian
    for (let i = 1; i < a.trail.length; i++) {
      if (Math.abs(a.trail[i][0] - a.trail[i - 1][0]) > 180) parts.push([]);
      parts[parts.length - 1].push(a.trail[i]);
    }
    return { type: "Feature", properties: { cat: a.cat }, geometry: { type: "MultiLineString", coordinates: parts.filter(p => p.length > 1) } };
  }) });
  if (AIR.delay_min != null) $("#aircraft-note").textContent = `aircraft: public ADS-B (${AIR.source || "airplanes.live"}), ${AIR.delay_min} min delay, only those broadcasting`;
  const lbl = $("#aircraft-count");
  lbl.textContent = AIR.enabled === false ? "(off)" : AIR.warming_up_min ? "(…)" : `(${list.length})`;
  lbl.parentElement.title = AIR.enabled === false ? "Aircraft layer is disabled on this server"
    : AIR.warming_up_min ? `Collecting positions: first ones appear in ~${AIR.warming_up_min} min (shown with a ${AIR.delay_min}-min delay)`
    : `Military aircraft broadcasting ADS-B, as of ${AIR.as_of ? new Date(AIR.as_of * 1000).toISOString().slice(11, 16) + " UTC" : "—"} (${AIR.delay_min}-min delay). Source: ${AIR.source || "none"}`;
}
function aircraftHtml(p, full = true) {
  const fmt = (v, unit) => (v === undefined || v === null || v === "") ? null : `${Math.round(v).toLocaleString()} ${unit}`;
  const title = p.flight || p.reg || String(p.hex).toUpperCase();
  const bits = [fmt(p.alt, "ft"), fmt(p.gs, "kt"), p.track != null && p.track !== "" ? `heading ${Math.round(p.track)}°` : null].filter(Boolean);
  let h = `<b>${esc(title)}</b> <span style="opacity:.6">${esc(p.type)}</span><br>${esc(p.name)}${p.reg && p.reg !== title ? ` · ${esc(p.reg)}` : ""}`;
  if (bits.length) h += `<br>${bits.join(" · ")}`;
  if (full) {
    const when = AIR && AIR.as_of ? new Date(AIR.as_of * 1000).toISOString().slice(11, 16) + " UTC" : "";
    h += `<br><span style="opacity:.6">Position at ${when}, shown ${AIR ? AIR.delay_min : 20} min late on purpose.<br>ADS-B via ${esc(AIR?.source || "airplanes.live")}. Only aircraft that choose to broadcast appear.</span>` +
         `<br><a href="https://globe.airplanes.live/?icao=${encodeURIComponent(p.hex)}" target="_blank" rel="noopener">more on airplanes.live ↗</a>`;
  }
  return h;
}
function openAircraftFeature(f) {
  $("#tooltip").hidden = true;
  new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(f.geometry.coordinates).setHTML(aircraftHtml(f.properties)).addTo(map);
}

/* ---------- GDELT incidents ---------- */
function incidentHtml(p) {
  const kind = p.root == 20 ? "mass violence" : "fighting / armed clash";
  const day = String(p.day || ""); const d = day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}` : day;
  return `<b>${esc(p.name || "")}</b><br>${esc(kind)} · ${p.n} event${p.n == 1 ? "" : "s"} · ${p.m} mentions · ${esc(d)}<br><span style="opacity:.6">GDELT, press-reported</span>`;
}
function renderIncidents() {
  const feats = (STATE.gdelt.incidents || []).map(i => ({
    type: "Feature", geometry: { type: "Point", coordinates: [i.lon, i.lat] },
    properties: { name: i.name, n: i.n, m: i.m, lm: Math.log2(1 + i.m), root: i.root, day: i.day, url: i.url, urls: JSON.stringify(i.urls || [i.url]), iso3: i.iso3 || "" },
  }));
  map.getSource("incidents").setData({ type: "FeatureCollection", features: feats });
  applyIncidentFocus();
}
function applyIncidentFocus() {
  const isos = Object.keys(focusColors());
  map.setFilter("incidents", isos.length ? ["in", ["get", "iso3"], ["literal", isos]] : null);
}

/* ---------- official travel advice (UK FCDO, US State Department), shown as published ---------- */
const ADVICE_COLORS = ["#3f8f63", "#d9c24a", "#e8893a", "#d4502a", "#9e1b1b"];      // FCDO 0-4 (US 1-4 reuses 0,1,2,4)
const US_TO_SHADE = { 1: 0, 2: 1, 3: 2, 4: 4 };
let ADVICE = null, adviceShown = new Set();
async function loadAdvice() {
  try { ADVICE = await (await fetch("/api/travel-advice")).json(); } catch (_) { return; }
  applyAdvice();
}
function applyAdvice() {
  const which = $("#tg-advice").value;
  map.setLayoutProperty("advice-fill", "visibility", which ? "visible" : "none");
  for (const iso of adviceShown) map.setFeatureState({ source: "countries", id: iso }, { adv: null });
  adviceShown = new Set();
  if (selectedCountry && !selected && !readerOpen) renderCountry();     // its advice box
  if (!which || !ADVICE) return;
  for (const [iso, a] of Object.entries(ADVICE[which] || {})) {
    const lvl = which === "us" ? US_TO_SHADE[a.level] : a.level;
    if (lvl == null) continue;
    map.setFeatureState({ source: "countries", id: iso }, { adv: lvl });
    adviceShown.add(iso);
  }
}
function adviceLine(iso, which) {
  const a = ADVICE?.[which]?.[iso]; if (!a) return "";
  return which === "fcdo" ? `UK: ${a.text}${a.also ? ", " + a.also : ""}` : `US: Level ${a.level}, ${a.text.toLowerCase()}`;
}
function adviceTip(iso) {
  const lines = ["fcdo", "us"].map(w => adviceLine(iso, w)).filter(Boolean);
  return lines.length ? `<br><span style="opacity:.75">${lines.map(esc).join("<br>")}</span>` : "";
}
function adviceHtml(iso) {
  const f = ADVICE?.fcdo?.[iso], u = ADVICE?.us?.[iso];
  if (!f && !u) return "";
  const day = (s) => s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  return `<div class="advice-box"><div class="who">Official travel advice</div>
    ${f ? `<div><span class="adv a${f.level}"></span> <b>UK Foreign Office:</b> ${esc(f.text)}${f.also ? ", " + esc(f.also) : ""}. <a href="${esc(f.url)}" target="_blank" rel="noopener">Read it ↗</a> <span class="fine">updated ${esc(day(f.updated))}</span></div>` : ""}
    ${u ? `<div><span class="adv u${u.level}"></span> <b>US State Dept:</b> Level ${u.level}, ${esc(u.text)}. <a href="${esc(u.url)}" target="_blank" rel="noopener">Read it ↗</a> <span class="fine">updated ${esc(day(u.updated))}</span></div>` : ""}
    <div class="fine">Shown as published by each government. Read the full advice before you travel; it often differs by region.</div></div>`;
}
$("#tg-advice").addEventListener("change", () => { applyAdvice(); syncLegend(); });

/* ---------- local news ---------- */
const LOCAL_MINZOOM = 4;
const LOCAL_COLOR = { violence: "#ff6b6b", tension: "#f2c14e", other: "#9fb4d9", good: "#5fd38d" };
let localTimer = null, localSeq = 0;
async function loadLocalNews() {
  const on = $("#tg-local").checked, zoomed = GOOD.on || map.getZoom() >= LOCAL_MINZOOM;   // the good stories are few enough for the whole globe
  $("#local-hint").textContent = on && !zoomed ? "(zoom in)" : "";
  if (!on || !zoomed || document.hidden) return;
  const b = map.getBounds(), seq = ++localSeq;
  const q = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(3));
  if (+q[2] - +q[0] >= 360) { q[0] = "-180"; q[2] = "180"; }
  const wrap = (v) => Math.abs(+v) <= 180 ? +v : ((+v + 540) % 360) - 180;   // the globe can report longitudes past ±180
  let items = [];
  try { items = (await (await fetch(`/api/local-news?w=${wrap(q[0])}&s=${q[1]}&e=${wrap(q[2])}&n=${q[3]}${GOOD.on ? "&good=1" : ""}`)).json()).items || []; } catch (_) { return; }
  if (seq !== localSeq) return;
  $("#local-hint").textContent = `(${items.length}${items.length >= 400 ? "+" : ""})`;
  map.getSource("local-news").setData({ type: "FeatureCollection", features: items.map(i => ({
    type: "Feature", geometry: { type: "Point", coordinates: [i.lon, i.lat] },
    properties: { ...i, lm: Math.log2(1 + (i.m || 1)) } })) });
  if (GOOD.on) { GOOD.local = items; if (STATE && !selected && !selectedCountry && !readerOpen) renderGoodList(); }
}
function localHtml(p) {
  return `<b>${esc(p.title)}</b><br>${esc(p.place || "")} · ${esc(ago(p.t))}<br><span style="opacity:.6">${esc(host(p.url))} · click to read</span>`;
}
function openLocalFeature(f) {
  const p = f.properties;
  openArticle(p.url, { title: p.title, source: host(p.url), context: `<b>${esc(p.place || "")}</b> · ${esc(ago(p.t))} · <span style="opacity:.7">placed on the map by GDELT, automatically</span>`,
    report: { kind: "local", ref: p.url, title: `Local news: ${p.title || ""} (${p.place || ""})` } });
}
$("#tg-local").addEventListener("change", (e) => {
  for (const id of ["local-news", "local-news-outline"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  loadLocalNews();
});

/* ---------- occupied territory (DeepStateMap.Live, fetched by the server once a day) ---------- */
let TERRITORY = null;
const TERRITORY_LAYERS = ["territory-fill", "territory-hatch", "territory-contested", "territory-line", "territory-contested-line"];
const UKRAINE_KM2 = 603550;
function hatchImage(color) {
  const n = 16, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"); g.strokeStyle = color; g.lineWidth = 2.2; g.beginPath();
  for (const o of [-n, 0, n]) { g.moveTo(o, n); g.lineTo(o + n, 0); }      // seamless diagonal lines
  g.stroke();
  return g.getImageData(0, 0, n, n);
}
async function loadTerritory() {
  try {
    const t = await (await fetch("/api/territory")).json();
    if (!t.geojson) return;
    TERRITORY = t;
    map.getSource("territory").setData(t.geojson);
    $("#terr-date").textContent = t.as_of ? `as of ${t.as_of}` : "";
    syncCredits();
    if (selected && !readerOpen) renderDetail();
  } catch (_) {}
}
function territoryChange(t) {
  const h = t.history || [];
  if (h.length < 2) return null;
  const a = h[h.length - 2], b = h[h.length - 1];
  return { km2: b.occupied_km2 - a.occupied_km2, since: a.date };
}
function territoryBlock(c) {
  if (!TERRITORY || !$("#tg-territory").checked) return "";
  const isos = c.parties.filter(p => p.role === "combatant").map(p => norm(p.country));
  if (!isos.includes("RUS") || !isos.includes("UKR")) return "";
  const t = TERRITORY, ch = territoryChange(t);
  const pct = (100 * t.occupied_km2 / UKRAINE_KM2).toFixed(1);
  const change = !ch ? `<span class="muted">Daily change shows from the next update.</span>`
    : ch.km2 === 0 ? `No change since ${esc(ch.since)}.`
    : `<b class="${ch.km2 > 0 ? "up" : "down"}">${ch.km2 > 0 ? "+" : "−"}${fmtNum(Math.abs(ch.km2))} km²</b> occupied since ${esc(ch.since)}.`;
  return `<h3>Occupied territory</h3>
    <div class="terr-box"><div><b>${fmtNum(t.occupied_km2)} km²</b> of Ukraine held by Russia (${pct}%), incl. Crimea;
      ${fmtNum(t.contested_km2)} km² of unknown status. ${change}</div>
      <div class="terr-src">Hatched red on the map. Source: <a href="https://deepstatemap.live/en" target="_blank" rel="noopener">DeepStateMap.Live</a>
      (Ukrainian volunteer OSINT project; it delays showing Ukrainian gains for security)${t.as_of ? `, as of ${esc(t.as_of)}` : ""}.</div></div>`;
}
function territoryTip(point) {
  if (!TERRITORY || !map.getLayer("territory-fill")) return "";
  const f = map.queryRenderedFeatures(point, { layers: ["territory-fill", "territory-contested"] })[0];
  if (!f) return "";
  return `<br><span style="opacity:.8">${f.properties.kind === "occupied" ? "Russian-occupied" : "Unknown status / contested"}` +
    ` · DeepStateMap${TERRITORY.as_of ? ", " + esc(TERRITORY.as_of) : ""}</span>`;
}
/* credits for the third-party layers that are switched on (desktop; phones have them in the key) */
function syncCredits() {
  const parts = [];
  if ($("#tg-sat").checked) parts.push(`Imagery: <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016 &amp; 2017)`);
  if ($("#tg-territory").checked && TERRITORY) parts.push(`Occupied territory: <a href="https://deepstatemap.live/en" target="_blank" rel="noopener">DeepStateMap.Live</a>`);
  $("#map-credit").innerHTML = parts.join(" · ");
  $("#map-credit").hidden = !parts.length;
}
$("#tg-territory").addEventListener("change", e => {
  for (const id of TERRITORY_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  syncCredits(); if (selected && !readerOpen) renderDetail();
});
$("#tg-sat").addEventListener("change", e => {
  const on = e.target.checked;
  if (map.getLayer("satellite")) map.setLayoutProperty("satellite", "visibility", on ? "visible" : "none");
  if (map.getLayer("relief")) map.setLayoutProperty("relief", "visibility", on ? "none" : "visible");
  if (map.getLayer("lakes")) map.setLayoutProperty("lakes", "visibility", on ? "none" : "visible");   // the imagery has its own water
  syncCredits();
});

/* ---------- good news mode ---------- */
/* layers that are all bad news; switched off (and locked) while good news mode is on */
const GOOD_HIDES = ["tg-heat", "tg-territory", "tg-gdelt-arcs", "tg-strikes", "tg-incidents", "tg-aircraft", "tg-ships", "tg-advice"];
/* the state with only good news left: conflicts that report progress, with just those developments
   and the sources behind them; no attacks, casualty figures, consequences or GDELT conflict events */
function goodView(raw) {
  const conflicts = raw.conflicts.map(c => {
    const developments = (c.developments || []).filter(d => d.good);
    const links = new Set(developments.flatMap(d => d.sources || []));
    return { ...c, developments, consequences: [], stats: {}, activity: {}, sources: (c.sources || []).filter(s => links.has(s.link)) };
  }).filter(c => c.developments.length);
  return { ...raw, conflicts, strikes: [], gdelt: { ...raw.gdelt, heat: {}, points: [], pairs: [], incidents: [] } };
}
function setControl(id, v) {
  const el = document.getElementById(id);
  if (el.type === "checkbox") { if (el.checked === !!v) return; el.checked = !!v; }
  else { v = v || ""; if (el.value === v) return; el.value = v; }
  el.dispatchEvent(new Event("change"));
}
/* what the page shows of the full state in the current mode */
const viewOf = (raw) => CYBER.on || WEATHER.on ? bareView(raw) : GOOD.on ? goodView(raw) : raw;
function setGood(on) {
  if (on === GOOD.on) return;
  if (on && CYBER.on) setCyber(false);          // one mode at a time
  if (on && WEATHER.on) setWeather(false);
  GOOD.on = on;
  document.body.classList.toggle("good-mode", on);
  syncModes();
  try { localStorage.setItem("goodNews", on ? "1" : "0"); } catch (_) {}
  if (on) {
    GOOD.stash = {};
    for (const id of [...GOOD_HIDES, "tg-local"]) { const el = document.getElementById(id); GOOD.stash[id] = el.type === "checkbox" ? el.checked : el.value; }
    for (const id of GOOD_HIDES) setControl(id, false);
    setControl("tg-local", true);
  } else {
    const stash = GOOD.stash || {}; GOOD.stash = null; GOOD.local = [];
    for (const [id, v] of Object.entries(stash)) setControl(id, v);
  }
  for (const id of GOOD_HIDES) document.getElementById(id).disabled = on;
  for (const id of ["local-news", "local-news-outline"]) map.setLayerZoomRange(id, on ? 0 : LOCAL_MINZOOM, 24);
  map.getSource("local-news").setData({ type: "FeatureCollection", features: [] });   // no leftover stories from the other mode
  loadLocalNews();
  if (!$("#news").hidden) loadHeadlines();
  syncLegend(); saveSettings();
  if (GOOD.raw) { STATE = viewOf(GOOD.raw); LIST.status = ""; render(); }
}
function renderGoodList() {
  $("#reader").hidden = true; readerOpen = false;
  $("#detail").hidden = true; $("#list").hidden = false; $("#list-tools").hidden = true;
  const devs = STATE.conflicts.flatMap(c => c.developments.map(d => ({ c, d })))
    .sort((a, b) => (b.d.date || "").localeCompare(a.d.date || ""));
  const local = GOOD.local.slice(0, 40);
  $("#list").innerHTML = `<div class="good-intro">Good news mode: attacks, fighting, crime and disasters are hidden. What is left is
      progress towards peace and upbeat local stories, picked automatically, so the odd one may slip through.
      <button class="linkish" id="good-off">Show all news</button></div>
    <h3 class="gh3">Progress in conflicts</h3>
    ${devs.map(({ c, d }) => `<div class="card gdev" data-id="${esc(c.id)}" tabindex="0" role="button">
      <div class="head"><span class="name">${esc(c.name)}</span><span class="date">${esc(d.date || "")}</span></div>
      <div class="gtext">${esc(d.text)}</div></div>`).join("") || `<div class="empty small">No progress towards peace in the latest reports.</div>`}
    <h3 class="gh3">Good news on the map</h3>
    ${local.map((i, n) => `<div class="src glocal" tabindex="0" role="button" data-i="${n}">${esc(i.title)} <span class="s">— ${esc(i.place || host(i.url))}</span></div>`).join("")
      || `<div class="empty small">${$("#tg-local").checked ? "Looking for good stories in view…" : "Switch on Local news in Layers to see good local stories."}</div>`}`;
  $("#good-off").addEventListener("click", () => setGood(false));
  document.querySelectorAll("#list .gdev").forEach(el => el.addEventListener("click", () => select(el.dataset.id)));
  document.querySelectorAll("#list .glocal").forEach(el => el.addEventListener("click", () => {
    const i = local[+el.dataset.i];
    map.flyTo({ center: [i.lon, i.lat], zoom: Math.max(map.getZoom(), 5), speed: 0.9, padding: sheetPadding() });
    openLocalFeature({ properties: i });
  }));
}
$("#good-btn").addEventListener("click", () => setGood(true));

/* ---------- cyber mode: the virtual side of the wars ---------- */
/* attacks between countries (Cloudflare Radar, last 24 h), ransomware claims (ransomware.live: group, sector,
   country; never the victim's name), internet outages (IODA) and incidents read from the news. Each is shown
   with its real delay; nothing here is a packet-by-packet live feed. */
const CYBER = { on: false, data: null, stash: null, dash: null, timer: null, outaged: [] };
const CYBER_COLOR = { l3: "#38d9f5", l7: "#ff5fd2", news: "#ffc53d", ransom: "#ff4d6d", outage: "#9b6bff" };
const CYBER_HIDES = [...GOOD_HIDES, "tg-arcs", "tg-local"];
const CYBER_LAYERS = ["cyber-outage", "cyber-arcs-glow", "cyber-arcs", "cyber-ransom", "cyber-ransom-count", "cyber-inc"];
const CYBER_KIND = { ransomware: "ransomware", ddos: "DDoS", breach: "data breach", espionage: "espionage", wiper: "wiper",
                     defacement: "defacement", "hack-and-leak": "hack and leak", infrastructure: "infrastructure", other: "attack" };
/* the dashes move along the arcs, origin to target */
const DASH_SEQ = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
                  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
/* no conflicts, strikes or GDELT events: what cyber and weather mode draw over */
function bareView(raw) {
  return { ...raw, conflicts: [], strikes: [], gdelt: { ...raw.gdelt, heat: {}, points: [], pairs: [], incidents: [] } };
}
function addCyberLayers() {
  const empty = { type: "FeatureCollection", features: [] }, hidden = { visibility: "none" };
  for (const id of ["cyber-arcs", "cyber-ransom", "cyber-inc"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({ id: "cyber-outage", type: "fill", source: "countries", layout: hidden,
    paint: { "fill-color": CYBER_COLOR.outage, "fill-opacity": ["match", ["coalesce", ["feature-state", "outage"], 0], 1, 0.16, 2, 0.3, 3, 0.45, 0] } });
  map.addLayer({ id: "cyber-arcs-glow", type: "line", source: "cyber-arcs", layout: { ...hidden, "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["*", 3, ["get", "w"]], "line-blur": 4, "line-opacity": 0.25 } });
  map.addLayer({ id: "cyber-arcs", type: "line", source: "cyber-arcs", layout: hidden,
    paint: { "line-color": ["get", "color"], "line-width": ["get", "w"], "line-opacity": 0.9, "line-dasharray": DASH_SEQ[0] } });
  map.addLayer({ id: "cyber-ransom", type: "circle", source: "cyber-ransom", layout: hidden,
    paint: { "circle-color": CYBER_COLOR.ransom, "circle-opacity": 0.28, "circle-stroke-color": CYBER_COLOR.ransom, "circle-stroke-width": 1.5,
             "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 6, 10, 26] } });
  map.addLayer({ id: "cyber-ransom-count", type: "symbol", source: "cyber-ransom", layout: { ...hidden, "text-field": ["to-string", ["get", "n"]],
    "text-font": ["Open Sans Semibold"], "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.7)", "text-halo-width": 1 } });
  map.addLayer({ id: "cyber-inc", type: "circle", source: "cyber-inc", layout: hidden,
    paint: { "circle-color": CYBER_COLOR.news, "circle-radius": ["case", ["get", "state"], 6.5, 5], "circle-stroke-color": "#111", "circle-stroke-width": 1.5 } });
  const tip = $("#tooltip");
  const show = (e, html) => { tip.innerHTML = html; tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px"; map.getCanvas().style.cursor = "pointer"; };
  const hide = () => { tip.hidden = true; map.getCanvas().style.cursor = ""; };
  map.on("mousemove", "cyber-arcs", (e) => show(e, e.features[0].properties.tip));
  map.on("mousemove", "cyber-ransom", (e) => show(e, e.features[0].properties.tip));
  map.on("mousemove", "cyber-inc", (e) => { const i = CYBER.data?.incidents[e.features[0].properties.i]; if (i) show(e, cyberIncidentHtml(i)); });
  for (const id of ["cyber-arcs", "cyber-ransom", "cyber-inc"]) map.on("mouseleave", id, hide);
  map.on("click", "cyber-inc", (e) => { e.originalEvent._handled = true; openCyberIncident(e.features[0].properties.i); });
  map.on("click", "cyber-ransom", (e) => { e.originalEvent._handled = true; });
}
function cyberFlag(iso) { return iso && COUNTRIES[iso] ? `${flag(iso)} ${esc(cname(iso))}` : ""; }
function cyberIncidentHtml(i) {
  const who = i.attacker ? `<br>by <b>${esc(i.attacker)}</b>${i.attacker_country ? ` (${cyberFlag(i.attacker_country)}${i.state_linked ? ", state-linked" : ""})` : ""}` +
    (i.attribution ? ` <span style="opacity:.7">according to ${esc(i.attribution)}</span>` : "") : `<br><span style="opacity:.7">attacker not named</span>`;
  return `<b>${esc(i.title || i.victim)}</b><br>${esc(CYBER_KIND[i.kind] || i.kind)} · ${esc(i.victim)}, ${cyberFlag(i.victim_country)} · ${esc(i.date)}${who}` +
    (i.verified ? "" : `<br><span style="opacity:.6">not yet checked against the article</span>`);
}
function cyberCountryTip(iso) {
  const d = CYBER.data; if (!d) return "";
  const rs = d.ransomware.filter(r => r.country === iso), inc = d.incidents.filter(i => i.victim_country === iso);
  const out = (d.outages?.countries || []).find(o => o.iso3 === iso);
  const parts = [];
  if (inc.length) parts.push(`${inc.length} attack${inc.length > 1 ? "s" : ""} in the news`);
  if (rs.length) parts.push(`${rs.length} ransomware claim${rs.length > 1 ? "s" : ""} in 7 days`);
  if (out) parts.push(`internet outage signal (IODA score ${out.score.toLocaleString()})`);
  const pairs = (d.attacks?.pairs || []).filter(p => p.to === iso);
  if (pairs.length) parts.push(`targeted from ${pairs.map(p => cname(p.from)).slice(0, 3).join(", ")}`);
  return parts.length ? "<br>" + parts.map(esc).join("<br>") : `<br><span style="opacity:.6">nothing reported</span>`;
}
/* a few deterministic offsets so several incidents in one country don't sit on one point */
function spread(iso, n) {
  const c = COUNTRIES[iso]; if (!c) return null;
  const a = n * 2.39996, r = n ? 0.9 + 0.55 * Math.sqrt(n) : 0;
  return [c.lon + r * Math.cos(a), c.lat + r * Math.sin(a) * 0.8];
}
async function loadCyber() {
  try { const r = await fetch("/api/cyber"); if (!r.ok) throw new Error(r.status); CYBER.data = await r.json(); }
  catch (_) { if (!CYBER.data) CYBER.data = { attacks: null, outages: null, ransomware: [], incidents: [], attacks_enabled: false }; }
  if (CYBER.on) renderCyber();
}
function renderCyber() {
  const d = CYBER.data; if (!d || !map.getSource("cyber-arcs")) return;
  const feats = [];
  const maxShare = Math.max(1, ...(d.attacks?.pairs || []).map(p => p.share));
  for (const p of d.attacks?.pairs || []) {
    const a = COUNTRIES[p.from], b = COUNTRIES[p.to]; if (!a || !b || p.from === p.to) continue;
    const what = p.layer === "l3" ? "network-layer (DDoS)" : "web-application";
    feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: arc([a.lon, a.lat], [b.lon, b.lat], 60) },
      properties: { color: CYBER_COLOR[p.layer], w: 0.8 + 3.2 * Math.sqrt(p.share / maxShare),
        tip: `<b>${esc(cname(p.from))} → ${esc(cname(p.to))}</b><br>${p.share}% of ${what} attacks seen by Cloudflare, last 24 h` +
             (p.layer === "l3" ? `<br><span style="opacity:.6">origin = where the traffic entered Cloudflare, not necessarily who sent it</span>` : "") } });
  }
  d.incidents.forEach((i, n) => {
    const a = COUNTRIES[i.attacker_country], b = COUNTRIES[i.victim_country];
    if (a && b && i.attacker_country !== i.victim_country)
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: arc([a.lon, a.lat], [b.lon, b.lat], 60) },
        properties: { color: CYBER_COLOR.news, w: i.state_linked ? 2.4 : 1.6, tip: cyberIncidentHtml(i) } });
  });
  map.getSource("cyber-arcs").setData({ type: "FeatureCollection", features: feats });
  const byC = {};
  for (const r of d.ransomware) if (r.country) (byC[r.country] = byC[r.country] || []).push(r);
  map.getSource("cyber-ransom").setData({ type: "FeatureCollection", features: Object.entries(byC).filter(([iso]) => COUNTRIES[iso]).map(([iso, rs]) => {
    const groups = Object.entries(rs.reduce((m, r) => (m[r.grp] = (m[r.grp] || 0) + 1, m), {})).sort((x, y) => y[1] - x[1]).slice(0, 3);
    return { type: "Feature", geometry: { type: "Point", coordinates: [COUNTRIES[iso].lon, COUNTRIES[iso].lat] },
      properties: { n: rs.length, tip: `<b>${esc(cname(iso))}</b><br>${rs.length} ransomware claim${rs.length > 1 ? "s" : ""} posted in the last 7 days` +
        `<br>top groups: ${groups.map(([g, n]) => `${esc(g)} (${n})`).join(", ")}<br><span style="opacity:.6">ransomware.live; claims by the gangs, not confirmed breaches</span>` } };
  }) });
  const seen = {};
  map.getSource("cyber-inc").setData({ type: "FeatureCollection", features: d.incidents.map((i, n) => {
    const k = seen[i.victim_country] = (seen[i.victim_country] ?? -1) + 1;
    const at = spread(i.victim_country, k); if (!at) return null;
    return { type: "Feature", geometry: { type: "Point", coordinates: at }, properties: { i: n, state: !!i.state_linked } };
  }).filter(Boolean) });
  for (const iso of CYBER.outaged) map.setFeatureState({ source: "countries", id: iso }, { outage: 0 });
  CYBER.outaged = (d.outages?.countries || []).map(o => o.iso3);
  for (const o of d.outages?.countries || []) map.setFeatureState({ source: "countries", id: o.iso3 }, { outage: o.level });
  if (STATE && !selected && !selectedCountry && !readerOpen) renderCyberList();
}
function renderCyberList() {
  $("#reader").hidden = true; readerOpen = false;
  $("#detail").hidden = true; $("#list").hidden = false; $("#list-tools").hidden = true;
  const d = CYBER.data;
  if (!d) { $("#list").innerHTML = `<div class="empty">Loading cyber data…</div>`; return; }
  const rs = d.ransomware, byC = {}, byG = {}, byS = {};
  for (const r of rs) { if (r.country) byC[r.country] = (byC[r.country] || 0) + 1; byG[r.grp] = (byG[r.grp] || 0) + 1; if (r.sector) byS[r.sector] = (byS[r.sector] || 0) + 1; }
  const top = (m, n, fmt) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `<span class="cy-chip">${fmt(k)} <b>${v}</b></span>`).join("");
  const pairs = (d.attacks?.pairs || []).slice().sort((a, b) => b.share - a.share);
  const outs = (d.outages?.countries || []).slice().sort((a, b) => b.score - a.score);
  $("#list").innerHTML = `<div class="cyber-intro">Cyber mode: the attacks that don't show up as explosions. Nothing here is second-by-second:
      each source says how old it is. <button class="linkish" id="cyber-off">Back to the conflicts</button></div>
    <h3 class="gh3">Attacks in the news</h3>
    ${d.incidents.slice(0, 40).map((i, n) => `<div class="card cy-inc" data-i="${n}" tabindex="0" role="button">
      <div class="head"><span class="cy-kind k-${esc(i.kind)}">${esc(CYBER_KIND[i.kind] || i.kind)}</span><span class="name">${esc(i.title || i.victim)}</span><span class="date">${esc(i.date || "")}</span></div>
      <div class="cy-meta">${cyberFlag(i.victim_country)} · ${esc(i.victim)}${i.attacker ? ` · by ${esc(i.attacker)}${i.attacker_country ? " " + flag(i.attacker_country) : ""}${i.state_linked ? ` <span class="cy-state" title="${esc(i.attribution ? "According to " + i.attribution : "")}">state-linked</span>` : ""}` : ""}</div>
      ${i.summary ? `<div class="gtext">${esc(i.summary)}</div>` : ""}</div>`).join("") || `<div class="empty small">No attacks read from the news yet. The local model reads the cyber news with each refresh.</div>`}
    <h3 class="gh3">Ransomware claims, last 7 days <span class="cy-n">${rs.length}</span></h3>
    <div class="cy-block">${rs.length ? `<div class="cy-row">${top(byC, 8, k => cyberFlag(k))}</div><div class="cy-row">${top(byG, 6, esc)}</div><div class="cy-row">${top(byS, 6, esc)}</div>
      <div class="cy-note">Posted by the gangs on their leak sites (via ransomware.live). A claim is not a confirmed breach, and victims aren't named here.</div>` : `<div class="empty small">No claims loaded yet.</div>`}</div>
    <h3 class="gh3">Attacks between countries, last 24 h</h3>
    <div class="cy-block">${!d.attacks_enabled ? `<div class="cy-note">Not switched on yet: this layer needs a Cloudflare Radar token on the server.</div>` :
      pairs.slice(0, 12).map(p => `<div class="cy-pair"><span class="sw" style="background:${CYBER_COLOR[p.layer]}"></span>${p.from === p.to ? `within ${cyberFlag(p.to)}` : `${cyberFlag(p.from)} → ${cyberFlag(p.to)}`}<span class="v">${p.share}%</span></div>`).join("") +
      `<div class="cy-note">Share of the attack traffic Cloudflare saw (<span style="color:${CYBER_COLOR.l3}">DDoS</span>, <span style="color:${CYBER_COLOR.l7}">web attacks</span>). Updated ${esc(ago(d.attacks.updated))}.</div>`}</div>
    <h3 class="gh3">Internet outages, last 24 h</h3>
    <div class="cy-block">${outs.slice(0, 10).map(o => `<div class="cy-pair"><span class="sw" style="background:${CYBER_COLOR.outage};opacity:${0.35 + o.level * 0.2}"></span>${cyberFlag(o.iso3)}<span class="v" title="IODA outage score; signals: ${esc(o.signals.join(", "))}">${["", "minor", "moderate", "severe"][o.level]}</span></div>`).join("")
      || `<div class="empty small">No country-wide outages detected.</div>`}
      <div class="cy-note">IODA (Georgia Tech) outage signals. Causes vary: shutdowns, cable cuts, power cuts and attacks all look alike here.</div></div>`;
  $("#cyber-off").addEventListener("click", () => setCyber(false));
  document.querySelectorAll("#list .cy-inc").forEach(el => el.addEventListener("click", () => openCyberIncident(+el.dataset.i)));
}
function openCyberIncident(n) {
  const i = CYBER.data?.incidents[n]; if (!i) return;
  const src = (i.sources || [])[0];
  const c = COUNTRIES[i.victim_country];
  if (c) map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 3.5), speed: 0.9, padding: sheetPadding() });
  if (src) openArticle(src.link, { title: src.title, source: src.outlet || src.source, context: cyberIncidentHtml(i),
                                   alternatives: i.sources.length > 1 ? i.sources.map(s => s.link) : null });
}
function cyberDash(on) {
  clearInterval(CYBER.dash); CYBER.dash = null;
  if (!on) return;
  let step = 0;
  CYBER.dash = setInterval(() => {
    if (document.hidden) return;
    step = (step + 1) % DASH_SEQ.length;
    map.setPaintProperty("cyber-arcs", "line-dasharray", DASH_SEQ[step]);
  }, 70);
}
function setCyber(on) {
  if (on === CYBER.on) return;
  if (on && GOOD.on) setGood(false);
  if (on && WEATHER.on) setWeather(false);
  CYBER.on = on;
  document.body.classList.toggle("cyber-mode", on);
  syncModes();
  try { localStorage.setItem("cyberMode", on ? "1" : "0"); } catch (_) {}
  if (on) {
    CYBER.stash = {};
    for (const id of CYBER_HIDES) { const el = document.getElementById(id); CYBER.stash[id] = el.type === "checkbox" ? el.checked : el.value; }
    for (const id of CYBER_HIDES) setControl(id, false);
  } else {
    const stash = CYBER.stash || {}; CYBER.stash = null;
    for (const [id, v] of Object.entries(stash)) setControl(id, v);
  }
  for (const id of CYBER_HIDES) document.getElementById(id).disabled = on;
  for (const id of CYBER_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  cyberDash(on);
  clearInterval(CYBER.timer); CYBER.timer = null;
  if (on) { loadCyber(); CYBER.timer = setInterval(loadCyber, 5 * 60000); }
  if (!$("#news").hidden) loadHeadlines();
  syncLegend(); saveSettings();
  if (GOOD.raw) { STATE = viewOf(GOOD.raw); LIST.status = ""; render(); }
}
$("#cyber-btn").addEventListener("click", () => setCyber(true));

/* ---------- weather mode: the weather over the world and over the fighting ---------- */
/* rain from RainViewer (radar plus a satellite estimate where there is no radar, last 2 h, loaded straight from
   RainViewer), storms, floods and wildfires from GDACS, and the current weather at every capital and at each
   conflict's epicentre from Open-Meteo (fetched hourly by the pipeline). */
const WEATHER = { on: false, data: null, stash: null, timer: null, radar: null, radarTimer: null };
const WEATHER_HIDES = [...GOOD_HIDES, "tg-arcs", "tg-local"];
const WEATHER_LAYERS = ["wx-cone", "wx-track", "wx-track-fc", "wx-hazard", "wx-storm-label", "wx-cap", "wx-cap-t", "wx-front", "wx-front-t"];
const WX_ALERT = { green: "#5fd38d", orange: "#ff9a3d", red: "#ff4d4d" };
const WX_KIND = { cyclone: "#e6e4da", flood: "#4da3ff", wildfire: "#ff7a1a", drought: "#c9a15a" };
const WX_KIND_LABEL = { cyclone: "tropical cyclone", flood: "flood", wildfire: "wildfire", drought: "drought" };
/* WMO weather codes, as Open-Meteo reports them */
function wxText(code) {
  if (code == null) return "";
  if (code === 0) return "clear"; if (code === 1) return "mainly clear"; if (code === 2) return "partly cloudy"; if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog"; if (code <= 55) return "drizzle"; if (code <= 57) return "freezing drizzle";
  if (code === 66 || code === 67) return "freezing rain"; if (code <= 65) return code === 65 ? "heavy rain" : "rain";
  if (code <= 77) return code === 75 ? "heavy snow" : "snow"; if (code <= 82) return code === 82 ? "violent showers" : "showers";
  return code <= 86 ? "snow showers" : "thunderstorm";   // 96/99 "with hail" is only reliable over central Europe
}
const TEMP_RAMP = ["interpolate", ["linear"], ["get", "t"], -25, "#8f7bff", -10, "#5b8cff", 0, "#6fd3ff", 10, "#7fe0a0", 20, "#ffe066", 28, "#ff9a3d", 36, "#ff4d4d", 45, "#c2185b"];
const deg = (t) => t == null ? "–" : `${Math.round(t)}°`;
function wxNow(w) {
  const bits = [`${deg(w.t)} ${wxText(w.code)}`];
  if (w.feels != null && Math.abs(w.feels - w.t) >= 3) bits.push(`feels ${deg(w.feels)}`);
  if (w.gust != null) bits.push(`wind ${Math.round(w.wind)} km/h, gusts ${Math.round(w.gust)}`);
  if (w.rain) bits.push(`${w.rain} mm rain in the last 15 min`);
  if (w.cloud != null) bits.push(`${w.cloud}% cloud`);
  return bits.join(" · ");
}
function addWeatherLayers() {
  const empty = { type: "FeatureCollection", features: [] }, hidden = { visibility: "none" };
  for (const id of ["wx-storms", "wx-hazards", "wx-caps", "wx-fronts"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({ id: "wx-cone", type: "fill", source: "wx-storms", layout: hidden, filter: ["==", ["get", "part"], "cone"],
    paint: { "fill-color": ["match", ["get", "alert"], "red", WX_ALERT.red, "orange", WX_ALERT.orange, WX_ALERT.green], "fill-opacity": 0.13 } });
  const track = (id, fc) => map.addLayer({ id, type: "line", source: "wx-storms", layout: { ...hidden, "line-cap": "round" },
    filter: ["all", ["==", ["get", "part"], "track"], ["==", ["get", "forecast"], fc]],
    paint: { "line-color": ["match", ["get", "alert"], "red", WX_ALERT.red, "orange", WX_ALERT.orange, WX_ALERT.green],
             "line-width": ["match", ["get", "cat"], "HU", 3, "TS", 2, 1.4], ...(fc ? { "line-dasharray": [1.5, 1.5] } : {}) } });
  track("wx-track", false); track("wx-track-fc", true);
  map.addLayer({ id: "wx-hazard", type: "circle", source: "wx-hazards", layout: hidden,
    paint: { "circle-color": ["get", "color"], "circle-radius": ["case", ["==", ["get", "kind"], "cyclone"], 8, ["==", ["get", "kind"], "wildfire"], 3.5, 6],
             "circle-stroke-color": ["get", "stroke"], "circle-stroke-width": ["case", ["==", ["get", "kind"], "wildfire"], 1, 2.5] } });
  map.addLayer({ id: "wx-storm-label", type: "symbol", source: "wx-hazards", layout: { ...hidden, "text-field": ["get", "label"], "text-font": ["Open Sans Semibold"],
    "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true }, filter: ["==", ["get", "kind"], "cyclone"],
    paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.75)", "text-halo-width": 1.2 } });
  map.addLayer({ id: "wx-cap", type: "circle", source: "wx-caps", layout: hidden,
    paint: { "circle-color": TEMP_RAMP, "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.5, 5, 5], "circle-stroke-color": "rgba(0,0,0,.6)", "circle-stroke-width": 1 } });
  map.addLayer({ id: "wx-cap-t", type: "symbol", source: "wx-caps", minzoom: 1.5, layout: { ...hidden, "text-field": ["get", "label"], "text-font": ["Open Sans Semibold"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 13], "text-offset": [0.6, 0], "text-anchor": "left", "text-optional": true },
    paint: { "text-color": TEMP_RAMP, "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.2 } });
  map.addLayer({ id: "wx-front", type: "circle", source: "wx-fronts", layout: hidden,
    paint: { "circle-color": TEMP_RAMP, "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "wx-front-t", type: "symbol", source: "wx-fronts", minzoom: 2.5, layout: { ...hidden, "text-field": ["get", "label"], "text-font": ["Open Sans Semibold"],
    "text-size": 12, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,.8)", "text-halo-width": 1.2 } });
  const tip = $("#tooltip");
  const show = (e, html) => { tip.innerHTML = html; tip.hidden = false; tip.style.left = (e.point.x + 14) + "px"; tip.style.top = (e.point.y + 14) + "px"; map.getCanvas().style.cursor = "pointer"; };
  const hide = () => { tip.hidden = true; map.getCanvas().style.cursor = ""; };
  map.on("mousemove", "wx-hazard", (e) => { const h = WEATHER.data?.hazards.events[e.features[0].properties.i]; if (h) show(e, wxHazardHtml(h)); });
  map.on("mousemove", "wx-cap", (e) => { const w = WEATHER.data?.conditions.capitals[e.features[0].properties.i]; if (w) show(e, `<b>${esc(w.name)}</b>, ${esc(cname(w.iso3))}<br>${esc(wxNow(w))}`); });
  map.on("mousemove", "wx-front", (e) => { const w = WEATHER.data?.conditions.conflicts[e.features[0].properties.i]; if (w) show(e, wxFrontHtml(w)); });
  for (const id of ["wx-hazard", "wx-cap", "wx-front"]) map.on("mouseleave", id, hide);
  map.on("click", "wx-hazard", (e) => { e.originalEvent._handled = true; const h = WEATHER.data?.hazards.events[e.features[0].properties.i]; if (h?.report) window.open(h.report, "_blank", "noopener"); });
  map.on("click", "wx-front", (e) => { e.originalEvent._handled = true; });
  map.on("click", "wx-cap", (e) => { e.originalEvent._handled = true; });
}
function wxHazardHtml(h) {
  const where = h.countries.length ? h.countries.map(cyberFlag).join(", ") : esc(h.place || "at sea");
  return `<b>${esc(h.kind === "cyclone" ? `${h.title}` : h.title || h.name)}</b><br>${esc(WX_KIND_LABEL[h.kind])} · ${where}` +
    (h.severity && h.kind !== "flood" ? `<br>${esc(h.severity)}` : "") +
    `<br><span style="color:${WX_ALERT[h.alert]}">GDACS ${esc(h.alert)} alert</span> <span style="opacity:.6">since ${esc((h.from || "").slice(0, 10))}</span>`;
}
function wxDay(d) {
  const day = new Date(d.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  return `${day}: ${wxText(d.code)}, ${deg(d.min)}–${deg(d.max)}${d.rain ? `, ${d.rain} mm` : ""}${d.gust != null ? `, gusts ${Math.round(d.gust)} km/h` : ""}`;
}
/* today (UTC) is often half gone; show the day after it and the one after that as the outlook */
const wxOutlook = (w) => (w.days || []).filter(d => d.date > new Date().toISOString().slice(0, 10)).slice(0, 2);
function wxFrontHtml(w) {
  return `<b>${esc(w.name)}</b>${w.label ? `<br><span style="opacity:.7">${esc(w.label)}</span>` : ""}<br>now: ${esc(wxNow(w))}` +
    wxOutlook(w).map(d => `<br>${esc(wxDay(d))}`).join("");
}
function weatherCountryTip(iso) {
  const d = WEATHER.data; if (!d) return "";
  const cap = d.conditions.capitals.find(c => c.iso3 === iso);
  const hz = d.hazards.events.filter(h => h.countries.includes(iso));
  const parts = [];
  if (cap) parts.push(`${cap.name}: ${wxNow(cap)}`);
  const n = (k) => hz.filter(h => h.kind === k).length;
  for (const k of ["cyclone", "flood", "wildfire", "drought"]) if (n(k)) parts.push(`${n(k)} ${WX_KIND_LABEL[k]}${n(k) > 1 ? "s" : ""} (GDACS)`);
  return parts.length ? "<br>" + parts.map(esc).join("<br>") : "";
}
async function loadWeather() {
  try { const r = await fetch("/api/weather"); if (!r.ok) throw new Error(r.status); WEATHER.data = await r.json(); }
  catch (_) { if (!WEATHER.data) WEATHER.data = { hazards: { events: [], storms: { type: "FeatureCollection", features: [] } }, conditions: { capitals: [], conflicts: [] } }; }
  if (WEATHER.on) renderWeather();
}
function renderWeather() {
  const d = WEATHER.data; if (!d || !map.getSource("wx-storms")) return;
  map.getSource("wx-storms").setData(d.hazards.storms);
  map.getSource("wx-hazards").setData({ type: "FeatureCollection", features: d.hazards.events.map((h, i) => ({ type: "Feature",
    geometry: { type: "Point", coordinates: [h.lon, h.lat] },
    properties: { i, kind: h.kind, color: WX_KIND[h.kind], stroke: WX_ALERT[h.alert] || WX_ALERT.green,
                  label: h.kind === "cyclone" ? (h.name || "").replace(/-\d+$/, "") : "" } })) });
  map.getSource("wx-caps").setData({ type: "FeatureCollection", features: d.conditions.capitals.map((w, i) => w.t == null ? null : ({ type: "Feature",
    geometry: { type: "Point", coordinates: [w.lon, w.lat] }, properties: { i, t: w.t, label: deg(w.t) } })).filter(Boolean) });
  map.getSource("wx-fronts").setData({ type: "FeatureCollection", features: d.conditions.conflicts.map((w, i) => w.t == null ? null : ({ type: "Feature",
    geometry: { type: "Point", coordinates: [w.lon, w.lat] }, properties: { i, t: w.t, label: `${w.name}: ${deg(w.t)} ${wxText(w.code)}` } })).filter(Boolean) });
  if (STATE && !selected && !selectedCountry && !readerOpen) renderWeatherList();
}
/* ---- rain: RainViewer's latest frame only. A loop loads every tile once per frame, which runs into
   RainViewer's rate limit (429) within minutes and leaves frames blank, so the rain flickers on and off */
async function loadRadar() {
  let j;
  try { const r = await fetch("https://api.rainviewer.com/public/weather-maps.json"); if (!r.ok) throw new Error(r.status); j = await r.json(); }
  catch (_) { return; }
  const f = (j.radar?.past || []).at(-1);
  if (!f || f.path === WEATHER.radar?.path) return;
  const tiles = [`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`];
  const src = map.getSource("wx-radar");
  if (src) src.setTiles(tiles);
  else {
    map.addSource("wx-radar", { type: "raster", tiles, tileSize: 256, maxzoom: 7,
                                attribution: '<a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>' });
    map.addLayer({ id: "wx-radar", type: "raster", source: "wx-radar", layout: { visibility: WEATHER.on ? "visible" : "none" },
                   paint: { "raster-opacity": 0.75 } }, map.getLayer("wx-cone") ? "wx-cone" : undefined);
  }
  WEATHER.radar = f;
  $("#wx-radar-time").textContent = new Date(f.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function renderWeatherList() {
  $("#reader").hidden = true; readerOpen = false;
  $("#detail").hidden = true; $("#list").hidden = false; $("#list-tools").hidden = true;
  const d = WEATHER.data;
  if (!d) { $("#list").innerHTML = `<div class="empty">Loading the weather…</div>`; return; }
  const ev = d.hazards.events, caps = d.conditions.capitals.filter(c => c.t != null), fronts = d.conditions.conflicts;
  const by = (k) => ev.filter(h => h.kind === k).sort((a, b) => (b.score || 0) - (a.score || 0));
  const hazardCard = (h) => `<div class="card wx-hz" data-lat="${h.lat}" data-lon="${h.lon}" tabindex="0" role="button">
      <div class="head"><span class="wx-dot" style="background:${WX_KIND[h.kind]};border-color:${WX_ALERT[h.alert]}"></span><span class="name">${esc(h.kind === "cyclone" ? h.title : h.title || h.name)}</span><span class="date">${esc((h.from || "").slice(5, 10))}</span></div>
      <div class="cy-meta">${h.countries.length ? h.countries.map(cyberFlag).join(", ") : esc(h.place || "at sea")}${h.severity && h.kind === "cyclone" ? ` · ${esc(h.severity.replace(/ \(maximum.*$/, ""))}` : ""} · <span style="color:${WX_ALERT[h.alert]}">${esc(h.alert)} alert</span>${h.report ? ` · <a href="${esc(h.report)}" target="_blank" rel="noopener">GDACS</a>` : ""}</div></div>`;
  const storms = by("cyclone"), floods = by("flood"), fires = by("wildfire"), droughts = by("drought");
  const bigFires = fires.filter(h => h.alert !== "green");
  const ext = (label, arr, fmt) => arr.length ? `<div class="cy-pair"><span class="wx-lab">${label}</span>${cyberFlag(arr[0].iso3)} <span class="v">${fmt(arr[0])}</span></div>` : "";
  const sorted = (f) => caps.filter(c => f(c) != null).slice().sort((a, b) => f(b) - f(a));
  $("#list").innerHTML = `<div class="cyber-intro wx-intro">Weather mode: rain, storms, floods and fires, and the weather where the fighting is.
      Rain, wind and low cloud ground drones and aircraft and turn roads to mud. <button class="linkish" id="weather-off">Back to the conflicts</button></div>
    <h3 class="gh3">Weather where the fighting is</h3>
    ${fronts.map((w, i) => `<div class="card wx-front" data-lat="${w.lat}" data-lon="${w.lon}" tabindex="0" role="button">
      <div class="head"><span class="wx-t" style="color:${tempColor(w.t)}">${deg(w.t)}</span><span class="name">${esc(w.name)}</span><span class="date">${esc(wxText(w.code))}</span></div>
      <div class="cy-meta">${w.label ? esc(w.label) + " · " : ""}wind ${Math.round(w.wind ?? 0)} km/h, gusts ${Math.round(w.gust ?? 0)} · ${w.cloud ?? "–"}% cloud</div>
      <div class="gtext">${wxOutlook(w).map(x => esc(wxDay(x))).join("<br>")}</div></div>`).join("") || `<div class="empty small">No conditions loaded yet: the pipeline fetches them hourly.</div>`}
    <h3 class="gh3">Tropical cyclones <span class="cy-n">${storms.length}</span></h3>
    ${storms.map(hazardCard).join("") || `<div class="empty small">None active.</div>`}
    <h3 class="gh3">Floods <span class="cy-n">${floods.length}</span></h3>
    ${floods.map(hazardCard).join("") || `<div class="empty small">None GDACS is tracking.</div>`}
    ${droughts.length ? `<h3 class="gh3">Droughts <span class="cy-n">${droughts.length}</span></h3>${droughts.map(hazardCard).join("")}` : ""}
    <h3 class="gh3">Wildfires <span class="cy-n">${fires.length}</span></h3>
    <div class="cy-block">${fires.length ? `<div class="cy-row">${Object.entries(fires.flatMap(h => h.countries).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}))
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `<span class="cy-chip">${cyberFlag(c)} <b>${n}</b></span>`).join("")}</div>` : `<div class="empty small">None GDACS is tracking.</div>`}</div>
    ${bigFires.map(hazardCard).join("")}
    <h3 class="gh3">Capitals right now</h3>
    <div class="cy-block">
      ${ext("hottest", sorted(c => c.t), c => `${esc(c.name)} ${deg(c.t)}`)}
      ${ext("coldest", sorted(c => -c.t), c => `${esc(c.name)} ${deg(c.t)}`)}
      ${ext("windiest", sorted(c => c.gust), c => `${esc(c.name)} gusts ${Math.round(c.gust)} km/h`)}
      ${ext("wettest", sorted(c => c.rain || null), c => `${esc(c.name)} ${c.rain} mm / 15 min`)}
      <div class="cy-note">Open-Meteo, updated ${esc(ago(d.conditions.updated))}. Storms, floods and fires: GDACS (UN and European Commission), updated ${esc(ago(d.hazards.updated))}. Rain: RainViewer, radar and satellite, latest frame.</div></div>`;
  $("#weather-off").addEventListener("click", () => setWeather(false));
  document.querySelectorAll("#list .wx-front, #list .wx-hz").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    map.flyTo({ center: [+el.dataset.lon, +el.dataset.lat], zoom: Math.max(map.getZoom(), 5), speed: 0.9, padding: sheetPadding() });
  }));
}
/* the same ramp as the map, for the list */
function tempColor(t) {
  const stops = [[-25, "#8f7bff"], [-10, "#5b8cff"], [0, "#6fd3ff"], [10, "#7fe0a0"], [20, "#ffe066"], [28, "#ff9a3d"], [36, "#ff4d4d"], [45, "#c2185b"]];
  if (t == null) return "var(--muted)";
  return (stops.find(([v]) => t <= v) || stops.at(-1))[1];
}
function setWeather(on) {
  if (on === WEATHER.on) return;
  if (on && GOOD.on) setGood(false);
  if (on && CYBER.on) setCyber(false);
  WEATHER.on = on;
  document.body.classList.toggle("weather-mode", on);
  syncModes();
  try { localStorage.setItem("weatherMode", on ? "1" : "0"); } catch (_) {}
  if (on) {
    WEATHER.stash = {};
    for (const id of WEATHER_HIDES) { const el = document.getElementById(id); WEATHER.stash[id] = el.type === "checkbox" ? el.checked : el.value; }
    for (const id of WEATHER_HIDES) setControl(id, false);
  } else {
    const stash = WEATHER.stash || {}; WEATHER.stash = null;
    for (const [id, v] of Object.entries(stash)) setControl(id, v);
  }
  for (const id of WEATHER_HIDES) document.getElementById(id).disabled = on;
  for (const id of [...WEATHER_LAYERS, "wx-radar"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  clearInterval(WEATHER.timer); WEATHER.timer = null; clearInterval(WEATHER.radarTimer); WEATHER.radarTimer = null;
  if (on) {
    loadWeather(); WEATHER.timer = setInterval(loadWeather, 10 * 60000);
    loadRadar(); WEATHER.radarTimer = setInterval(loadRadar, 10 * 60000);
  }
  if (!$("#news").hidden) loadHeadlines();
  syncLegend(); saveSettings();
  if (GOOD.raw) { STATE = viewOf(GOOD.raw); LIST.status = ""; render(); }
}
$("#weather-btn").addEventListener("click", () => setWeather(true));
/* the mode buttons on the map: News is none of the others */
function syncModes() {
  const cur = GOOD.on ? "good" : CYBER.on ? "cyber" : WEATHER.on ? "weather" : "news";
  for (const m of ["news", "good", "cyber", "weather"]) $(`#${m}-btn`).setAttribute("aria-pressed", m === cur);
}
$("#news-btn").addEventListener("click", () => { setGood(false); setCyber(false); setWeather(false); });

/* ---------- strikes ---------- */
let strikeAnim = null;      // {items:[{path, color, id, hasPath}], start}
const dayFilter = () => +$("#day").value;   // 0 = all, 1 = today, 2 = yesterday …
const dayString = (offset) => new Date(Date.now() - (offset - 1) * 86400000).toISOString().slice(0, 10);
function visibleStrikes() {
  let list = STATE.strikes || [];
  const d = dayFilter();
  if (d) list = list.filter(s => s.date === dayString(d));
  return list;
}
const nStrikes = (cid) => (STATE.strikes || []).filter(s => s.conflict_id === cid).length;
const conflictStrikes = (cid) => (STATE.strikes || []).filter(s => s.conflict_id === cid);

/* bent arc: great-circle path bulged sideways so it reads as a trajectory */
function trajectory(from, to) {
  const pts = arc(from, to, 48);
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;                 // perpendicular
  const bulge = Math.min(6, len * 0.18);
  return pts.map((p, i) => { const f = i / (pts.length - 1); const b = Math.sin(Math.PI * f) * bulge; return [p[0] + nx * b, p[1] + ny * b]; });
}

function strikeHtml(p) {
  const who = p.attacker && p.attacker !== "unknown" ? p.attacker : (p.origin_name || "");
  return `<b>${esc(who ? who + " → " : "")}${esc(p.target_name)}</b> <span style="opacity:.6">${esc(p.target_precision)}</span><br>` +
    `${esc(p.date)} · ${esc(p.weapon)}${p.launched != null && p.launched !== "" ? ` · ${p.launched} launched` : ""}${p.intercepted != null && p.intercepted !== "" ? ` · ${p.intercepted} intercepted` : ""}` +
    (p.outcome ? `<br>${esc(p.outcome)}` : "") + (p.source ? `<br><span style="opacity:.6">${esc(p.outlet || p.source)}</span>` : "") +
    `<br><span class="trust">${checkedBadge(p.verified === "" || p.verified == null ? undefined : +p.verified)}${outletsBadge(typeof p.outlets === "string" ? JSON.parse(p.outlets || "[]") : p.outlets)}</span>`;
}

function renderStrikes() {
  const list = visibleStrikes();
  const paths = [], impacts = [], items = [], strikeFocus = focusIds();
  list.forEach((st, i) => {
    const color = WEAPON_COLOR[st.weapon] || WEAPON_COLOR.other;
    const dim = !!(strikeFocus && !strikeFocus.has(st.conflict_id));   // projectiles of other conflicts stay hidden
    const to = [st.target_lon, st.target_lat];
    const r = 3 + Math.min(6, Math.log2(1 + (st.launched || 1)));
    impacts.push({ type: "Feature", geometry: { type: "Point", coordinates: to },
      properties: { ...st, color, r, icon: weaponKey(st.weapon), precision: st.target_precision, conflict: st.conflict_id } });
    let path = null;
    const crossBorder = st.origin_country && st.target_country && st.origin_country !== st.target_country;
    const usableOrigin = st.origin_lat != null && (st.origin_precision !== "country" || crossBorder);
    if (usableOrigin) {
      path = trajectory([st.origin_lon, st.origin_lat], to);
      paths.push({ type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: { color, conflict: st.conflict_id } });
    }
    items.push({ id: st.id, path, to, color, icon: weaponKey(st.weapon), dir: !!WEAPON_GLYPH[weaponKey(st.weapon)].dir, dim, phase: (i * 0.73) % 1 });
  });
  map.getSource("strike-paths").setData({ type: "FeatureCollection", features: paths });
  map.getSource("strike-impacts").setData({ type: "FeatureCollection", features: impacts });
  strikeAnim = { items };
  if (!strikeAnim.raf) tickStrikes();
}

const PERIOD = 7000; // ms per replay cycle
function tickStrikes() {
  if (!strikeAnim) return;
  if ($("#tg-strikes").checked && !document.hidden) {
    const now = performance.now();
    const proj = [], flashes = [];
    for (const it of strikeAnim.items) {
      if (it.dim) continue;
      const t = ((now / PERIOD) + it.phase) % 1;      // 0..1 within cycle
      if (it.path && t < 0.55) {
        const f = t / 0.55, k = f * (it.path.length - 1), i0 = Math.floor(k), i1 = Math.min(it.path.length - 1, i0 + 1), fr = k - i0;
        const p0 = it.path[i0], p1 = it.path[i1];
        const lat = p0[1] + (p1[1] - p0[1]) * fr;
        const rot = it.dir ? Math.atan2((p1[0] - p0[0]) * Math.cos(lat * Math.PI / 180), p1[1] - p0[1]) * 180 / Math.PI : 0;
        proj.push({ type: "Feature", geometry: { type: "Point", coordinates: [p0[0] + (p1[0] - p0[0]) * fr, lat] }, properties: { icon: it.icon, rot } });
      } else if (t >= 0.55 && t < 0.85) {
        const f = (t - 0.55) / 0.3;
        flashes.push({ type: "Feature", geometry: { type: "Point", coordinates: it.to }, properties: { color: it.color, r: 0.2 + f, a: 1 - f } });
      } else if (!it.path && t < 0.3) {
        // no known origin (internal conflict, unspecified launch site): a second, softer pulse so the impact still reads as active
        const f = t / 0.3;
        flashes.push({ type: "Feature", geometry: { type: "Point", coordinates: it.to }, properties: { color: it.color, r: 0.15 + f * 0.7, a: 0.7 * (1 - f) } });
      }
    }
    map.getSource("projectiles").setData({ type: "FeatureCollection", features: proj });
    map.getSource("flashes").setData({ type: "FeatureCollection", features: flashes });
  }
  strikeAnim.raf = requestAnimationFrame(tickStrikes);
}

function setStrikeVisibility(on) {
  for (const id of ["strike-paths", "strike-impacts", "strike-icons", "projectiles", "flashes"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/* ---------- day / night ---------- */
function subsolarPoint(date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5;                    // days since J2000.0
  const g = ((357.529 + 0.98560028 * d) % 360) * rad;               // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360;                        // mean longitude (deg)
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;   // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad;                         // obliquity
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  let RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad; // right ascension (deg)
  let eqt = q - RA; eqt = ((eqt + 540) % 360) - 180;                 // equation of time (deg)
  const utc = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -(utc - 12) * 15 - eqt; lon = ((lon + 540) % 360) - 180;
  return { lat: decl / rad, lon };
}
// Darkness from the sun's altitude (deg): 0 at +1°, deepening through civil (-6), nautical (-12)
// and astronomical (-18) twilight. Computed per 2° grid cell, so it is right in every season
// (a single polygon closed over a pole is wrong around the equinoxes).
const NIGHT_MAX = 0.62, NIGHT_CELL = 2;
function darkness(altDeg) {
  const t = Math.min(1, Math.max(0, (1 - altDeg) / 19));      // 0 at +1°, 1 at -18°
  return NIGHT_MAX * t * t * (3 - 2 * t);                      // smoothstep
}
function sunAltitude(lat, lon, sun) {
  const r = Math.PI / 180;
  const s = Math.sin(lat * r) * Math.sin(sun.lat * r) + Math.cos(lat * r) * Math.cos(sun.lat * r) * Math.cos((lon - sun.lon) * r);
  return Math.asin(Math.max(-1, Math.min(1, s))) / r;
}
/* the same altitude as a style expression over a feature's latitude/longitude properties */
function altitudeExpr(sun) {
  const r = Math.PI / 180, sd = Math.sin(sun.lat * r), cd = Math.cos(sun.lat * r);
  const lat = ["*", ["get", "latitude"], r], dlon = ["*", ["-", ["get", "longitude"], sun.lon], r];
  return ["/", ["asin", ["max", -1, ["min", 1, ["+", ["*", ["sin", lat], sd], ["*", ["*", ["cos", lat], cd], ["cos", dlon]]]]]], r];
}
function updateNight() {
  if (!map.getSource("night")) return;
  const empty = { type: "FeatureCollection", features: [] };
  const on = $("#tg-night").checked;
  map.setLayoutProperty("city-lights", "visibility", on ? "visible" : "none");
  if (!on) { for (const id of ["night", "sun", "terminator"]) map.getSource(id).setData(empty); return; }
  const sun = subsolarPoint(), c = NIGHT_CELL;
  const cells = [];
  for (let lat = -90; lat < 90; lat += c) {
    for (let lon = -180; lon < 180; lon += c) {
      const a = darkness(sunAltitude(lat + c / 2, lon + c / 2, sun));
      if (a < 0.004) continue;
      cells.push({ type: "Feature", properties: { a: Math.round(a * 1000) / 1000 },
        geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + c, lat], [lon + c, lat + c], [lon, lat + c], [lon, lat]]] } });
    }
  }
  map.getSource("night").setData({ type: "FeatureCollection", features: cells });
  // terminator glow: for each longitude, the latitude where the sun sits at -0.8° (bisection, correct any season)
  const segs = [[]];
  for (let lon = -180; lon <= 180; lon += 1) {
    const f = (lat) => sunAltitude(lat, lon, sun) + 0.8;
    let lo = -89.5, hi = 89.5;
    if (Math.sign(f(lo)) === Math.sign(f(hi))) { if (segs[segs.length - 1].length) segs.push([]); continue; }
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; (Math.sign(f(m)) === Math.sign(f(lo))) ? lo = m : hi = m; }
    segs[segs.length - 1].push([lon, (lo + hi) / 2]);
  }
  // near the equinoxes the terminator runs almost pole to pole along two meridians; add those as their own lines
  const meridians = [];
  for (const dl of [-90, 90]) {
    const lon = ((sun.lon + dl + 540) % 360) - 180, line = [];
    for (let lat = -89; lat <= 89; lat += 1) {
      const alt = sunAltitude(lat, lon, sun);
      if (Math.abs(alt + 0.8) < 3) line.push([lon, lat]); else if (line.length > 1) { meridians.push(line.splice(0)); } else line.length = 0;
    }
    if (line.length > 1) meridians.push(line);
  }
  const lines = segs.filter(x => x.length > 1).concat(meridians);
  map.getSource("terminator").setData({ type: "FeatureCollection", features: lines.map(l => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } })) });
  // city lights fade in through civil twilight and are gone in daylight
  const alt = altitudeExpr(sun);
  map.setFilter("city-lights", ["<", alt, -1]);
  map.setPaintProperty("city-lights", "circle-opacity", ["*",
    ["interpolate", ["linear"], alt, -8, 1, -1, 0],
    ["interpolate", ["linear"], ["coalesce", ["get", "pop_max"], 0], 0, 0.25, 500000, 0.55, 5000000, 0.85]]);
  map.getSource("sun").setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [sun.lon, sun.lat] } }] });
}
$("#tg-night").addEventListener("change", updateNight);

/* ---------- globe spin ----------
   Starts the moment Spin is ticked, at any zoom. Dragging or zooming only holds it while your
   hand is on the map (it carries on from wherever you leave the globe); selecting a conflict
   turns Spin off, since the camera then flies to it. */
const autoRotate = { on: false, holding: false };
if (sharedView) $("#tg-rotate").checked = false;
const spinWanted = () => $("#tg-rotate").checked && $("#tg-globe").checked;
function rotateTick() {
  if (autoRotate.on && !autoRotate.holding && !document.hidden && !map.isEasing()) {
    const c = map.getCenter();
    const step = 0.05 * Math.pow(2, -Math.max(0, map.getZoom() - 2));   // same apparent speed at any zoom
    map.jumpTo({ center: [c.lng + step, c.lat] });
  }
  requestAnimationFrame(rotateTick);
}
const hold = () => { autoRotate.holding = true; };
const release = () => { autoRotate.holding = false; };
map.on("mousedown", hold); map.on("touchstart", hold);
map.on("mouseup", release); map.on("touchend", release); map.on("touchcancel", release); map.on("dragend", release);
window.addEventListener("mouseup", release);            // released outside the map
let wheelTimer = null;
map.getCanvas().addEventListener("wheel", () => { hold(); clearTimeout(wheelTimer); wheelTimer = setTimeout(release, 250); }, { passive: true });
function syncSpin() { autoRotate.on = spinWanted(); }
requestAnimationFrame(rotateTick);
$("#tg-globe").addEventListener("change", e => {
  map.setProjection({ type: e.target.checked ? "globe" : "mercator" });
  syncSpin();
});
$("#tg-rotate").addEventListener("change", syncSpin);
syncSpin();

/* ---------- controls ---------- */
$("#tg-strikes").addEventListener("change", e => setStrikeVisibility(e.target.checked));
$("#tg-ships").addEventListener("change", e => {
  for (const id of ["ships", "ships-outline", "ship-trails"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  if (e.target.checked) loadShips();
});
$("#tg-aircraft").addEventListener("change", e => {
  for (const id of ["aircraft", "aircraft-outline", "aircraft-trails", "aircraft-trails-casing"]) map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none");
  if (e.target.checked) loadAircraft();
});
$("#tg-incidents").addEventListener("change", e => map.setLayoutProperty("incidents", "visibility", e.target.checked ? "visible" : "none"));
$("#day").addEventListener("input", () => {
  const d = dayFilter();
  $("#day-label").textContent = d === 0 ? "all 7 days" : d === 1 ? "today" : d === 2 ? "yesterday" : dayString(d).slice(5);
  if (STATE) renderStrikes();
});
$("#tg-heat").addEventListener("change", e => {
  map.setLayoutProperty("heat", "visibility", e.target.checked ? "visible" : "none");
  if (!e.target.checked) for (const iso of Object.keys(COUNTRIES)) map.setFeatureState({ source: "countries", id: iso }, { heat: 0 });
  else renderHeat();
});
$("#tg-arcs").addEventListener("change", e => map.setLayoutProperty("arcs", "visibility", e.target.checked ? "visible" : "none"));
$("#tg-gdelt-arcs").addEventListener("change", e => map.setLayoutProperty("garcs", "visibility", e.target.checked ? "visible" : "none"));
$("#window").addEventListener("change", load);
$("#refresh").addEventListener("click", async () => {
  $("#refresh").disabled = true;
  await fetch("/api/refresh", { method: "POST" });
  setTimeout(load, 1500);
});
map.on("click", (e) => {
  if (document.body.classList.contains("menu-open") || (isMobile() && document.body.classList.contains("legend-open"))) {
    toggleMenu(false); if (isMobile()) toggleLegend(false); return;   // first tap on the map just closes an open menu
  }
  if (e.originalEvent._handled || fuzzyTap(e)) return;
  if (selected || selectedCountry) select(null);
});

/* ---------- desktop: drag the panel edge to resize ---------- */
(() => {
  const handle = $("#panel-resizer"), panel = $("#panel");
  if (!handle) return;
  const clamp = (w) => Math.max(300, Math.min(window.innerWidth * 0.7, w));
  try { const saved = +localStorage.getItem("panelWidth"); if (saved) panel.style.width = clamp(saved) + "px"; } catch (_) {}
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (isMobile()) return;
    dragging = true; handle.setPointerCapture(e.pointerId); document.body.classList.add("resizing"); e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panel.style.width = clamp(window.innerWidth - e.clientX) + "px";
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove("resizing");
    try { localStorage.setItem("panelWidth", String(panel.getBoundingClientRect().width | 0)); } catch (_) {}
  };
  handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => { panel.style.width = ""; try { localStorage.removeItem("panelWidth"); } catch (_) {} });
})();

/* ---------- presence: how many people have the map open (a random id per tab, nothing else) ---------- */
let ONLINE = 0, VIEWS = {};
/* "3 viewing" on list cards (other people: you are on the list), "2 viewing now (incl. you)" in a conflict */
function viewingText(cid, inDetail) {
  const n = VIEWS[cid] || 0;
  return inDetail ? (n >= 2 ? `${n} viewing now (incl. you)` : "") : (n ? `${n} viewing` : "");
}
function updateViewing() {
  document.querySelectorAll("[data-viewing]").forEach(el => {
    const t = viewingText(el.dataset.viewing, el.classList.contains("in-detail"));
    el.textContent = t; el.hidden = !t;
  });
}
const TAB_ID = (() => {
  try { let id = sessionStorage.getItem("tabId"); if (!id) sessionStorage.setItem("tabId", id = crypto.randomUUID()); return id; }
  catch (_) { return crypto.randomUUID(); }
})();
async function ping() {
  if (document.hidden) return;
  try {
    const r = await (await fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: TAB_ID, view: selected || "" }) })).json();
    if (r.online !== ONLINE) { ONLINE = r.online; if (STATE) renderStatus(); }
    VIEWS = r.views || {}; updateViewing();
    checkVersion(r.version);
  } catch (_) {}
}
/* the first answer is the version this page was loaded with; a different one later means a deploy happened */
let SITE_VERSION = null;
function checkVersion(v) {
  if (!v) return;
  if (!SITE_VERSION) { SITE_VERSION = v; return; }
  if (v === SITE_VERSION || !$("#update-note").hidden) return;
  $("#update-note").hidden = false;
}
$("#update-reload").addEventListener("click", () => location.reload());
$("#update-close").addEventListener("click", () => { $("#update-note").hidden = true; SITE_VERSION = null; });   // ask again after the next deploy
const leave = () => navigator.sendBeacon?.("/api/presence", new Blob([JSON.stringify({ id: TAB_ID, leave: true })], { type: "application/json" }));
document.addEventListener("visibilitychange", () => document.hidden ? leave() : ping());
window.addEventListener("pagehide", leave);
ping(); setInterval(ping, 25000);

/* ---------- live TV: broadcasters' YouTube live streams in a docked player; nothing loads until opened ---------- */
const TV = { channels: null, fetched: 0, key: null };
const tvPref = (k, v) => { try { if (v === undefined) return localStorage.getItem("tv." + k); localStorage.setItem("tv." + k, v); } catch (_) {} };
function placeTv() { $("#main").style.setProperty("--tv-right", ($("#panel").offsetWidth + 12) + "px"); }
async function openTv() {
  $("#tv").hidden = false; $("#tv-btn").setAttribute("aria-expanded", true);
  $("#tv").classList.toggle("large", tvPref("large") === "1"); placeTv();
  if (isMobile()) { toggleMenu(false); toggleLegend(false); }
  if (!TV.channels || Date.now() - TV.fetched > 10 * 60000) {       // live video ids change when a broadcaster restarts its stream
    if (!TV.channels) $("#tv-screen").innerHTML = `<div class="tv-msg">Finding live streams…</div>`;
    try {
      const r = await fetch("/api/live-tv"); if (!r.ok) throw new Error(r.status);
      TV.channels = (await r.json()).channels || []; TV.fetched = Date.now();
    } catch (_) { TV.channels = TV.channels || []; }
  }
  if ($("#tv").hidden) return;                                       // closed while loading
  if (!TV.channels.length) { $("#tv-screen").innerHTML = `<div class="tv-msg">Couldn't load the channel list. Try again in a minute.</div>`; return; }
  const saved = tvPref("channel");
  const first = TV.channels.find(c => c.key === saved && c.live !== false) || TV.channels.find(c => c.key === "sky" && c.live !== false)
    || TV.channels.find(c => c.live !== false) || TV.channels[0];                    // Sky News unless you picked another
  playTv(first.key);
}
function closeTv() {
  $("#tv").hidden = true; $("#tv-screen").innerHTML = "";              // removing the iframe stops the stream
  $("#tv-btn").setAttribute("aria-expanded", false);
}
function renderTvChannels() {
  $("#tv-chans").innerHTML = TV.channels.map(c => `<button role="tab" data-key="${esc(c.key)}" aria-selected="${c.key === TV.key}"` +
    ` class="${c.live === false ? "off" : ""}" title="${c.live === false ? "Not live right now" : esc(c.label)}">${esc(c.label)}</button>`).join("");
}
function playTv(key) {
  const c = TV.channels.find(x => x.key === key); if (!c) return;
  TV.key = key; tvPref("channel", key); renderTvChannels();
  $("#tv-now").textContent = c.label;
  $("#tv-yt").href = c.youtube;
  if (c.live === false) {
    $("#tv-screen").innerHTML = `<div class="tv-msg">${esc(c.label)} isn't streaming live right now.<button id="tv-next">Watch another channel</button></div>`;
    $("#tv-next").addEventListener("click", () => { const next = TV.channels.find(x => x.live !== false); if (next) playTv(next.key); });
    return;
  }
  const params = "autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1";
  // the server resolved the current live video; if it couldn't read YouTube, fall back to the channel's live embed
  const src = c.video ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(c.video)}?${params}`
    : `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(c.channel)}&${params}`;
  $("#tv-screen").innerHTML = `<iframe src="${esc(src)}" title="${esc(c.label)} live" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}
$("#tv-btn").addEventListener("click", () => { const open = $("#tv").hidden; tvPref("open", open ? "1" : "0"); open ? openTv() : closeTv(); });
$("#tv-close").addEventListener("click", () => { tvPref("open", "0"); closeTv(); $("#tv-btn").focus(); });
$("#tv-size").addEventListener("click", () => { const on = $("#tv").classList.toggle("large"); tvPref("large", on ? "1" : "0"); });
$("#tv-chans").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.key !== TV.key) playTv(b.dataset.key); });
new ResizeObserver(placeTv).observe($("#panel"));
/* open from the start on desktop, until closed once; phones (it would cover the map) and good news mode
   (the channels carry all the news) start with it shut unless it was opened there before */
{
  let good = false; try { good = localStorage.getItem("goodNews") === "1"; } catch (_) {}
  const pref = tvPref("open");
  if (pref === "1" || (pref == null && !isMobile() && !good)) openTv();
}

/* ---------- top headlines under the TV: the stories the most outlets are running; they open in the reader ---------- */
/* edge colour: the status of the tracked conflict the story belongs to, else the local news topic colours */
const NEWS = { items: [], ping: null };
const PIN = `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M8 1a5 5 0 0 0-5 5c0 3.6 5 9 5 9s5-5.4 5-9a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg>`;
function headlineConflict(h) { return h.conflict && STATE && STATE.conflicts ? STATE.conflicts.find(c => c.id === h.conflict) : null; }
async function loadHeadlines() {
  let items;
  try { const r = await fetch(`/api/headlines?good=${GOOD.on ? 1 : 0}&cyber=${CYBER.on ? 1 : 0}&weather=${WEATHER.on ? 1 : 0}`); if (!r.ok) throw new Error(r.status); items = (await r.json()).items || []; }
  catch (_) { if (NEWS.items.length) return; items = []; }                // keep the last list through a hiccup
  NEWS.items = items;
  $("#news").hidden = false;
  $("#news .news-h").textContent = CYBER.on ? "Cyber headlines" : WEATHER.on ? "Weather headlines" : GOOD.on ? "Good news headlines" : "Top headlines";
  $("#news-foot-key").hidden = GOOD.on || CYBER.on || WEATHER.on;
  $("#news-list").innerHTML = items.map((h, i) => {
    const others = h.outlets.filter(o => o !== h.outlet);
    const c = GOOD.on ? null : headlineConflict(h);
    const edge = c ? (STATUS_COLOR[c.status] || STATUS_COLOR.active) : h.topic === "cyber" ? CYBER_COLOR.news : h.topic === "weather" ? WX_KIND.flood : (LOCAL_COLOR[h.topic] || LOCAL_COLOR.other);
    const tip = c ? `${c.name}: ${STATUS_LABEL[c.status] || c.status}` : { violence: "violence & crime", tension: "protest & tension", good: "good news", cyber: "cyber news", weather: "weather news" }[h.topic] || "other news";
    return `<li tabindex="0" role="button" data-i="${i}" style="--hl:${edge}" title="${esc(h.place ? `Opens the article and shows ${h.place.name} on the map` : "Opens the article")}">
      <div class="t">${esc(h.title)}</div>
      <div class="m"><span class="tp" title="${esc(tip)}"></span>${esc(h.outlet)} · ${esc(ago(h.published))}${others.length ? ` · <span class="n" title="Also: ${esc(others.join(", "))}">${h.outlets.length} outlets</span>` : ""}${h.place ? ` · <span class="pl">${PIN}${esc(h.place.name)}</span>` : ""}</div>
      ${c ? `<button class="hl-c" data-c="${esc(c.id)}" style="--st:${STATUS_COLOR[c.status] || STATUS_COLOR.active}" title="Show this conflict">${esc(c.name)} ›</button>` : ""}</li>`;
  }).join("") || `<li class="empty">No headlines to show right now.</li>`;
}
function pingPlace(p) {
  if (NEWS.ping) NEWS.ping.remove();
  const el = document.createElement("div"); el.className = "hl-ping";
  NEWS.ping = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  const mine = NEWS.ping; setTimeout(() => { if (NEWS.ping === mine) { mine.remove(); NEWS.ping = null; } }, 7000);
}
function openHeadline(el) {
  const h = NEWS.items[+el.dataset.i]; if (!h) return;
  const others = h.outlets.filter(o => o !== h.outlet);
  openArticle(h.link, { title: h.title, source: h.outlet, context: others.length ? `Also running this story: ${esc(others.join(", "))}` : "" });
  if (h.place) {
    map.flyTo({ center: [h.place.lon, h.place.lat], zoom: h.place.zoom, speed: 0.9, curve: 1.3, essential: true, padding: sheetPadding() });
    pingPlace(h.place);
  }
}
$("#news-list").addEventListener("click", (e) => {
  const b = e.target.closest(".hl-c"); if (b) { e.stopPropagation(); select(b.dataset.c); return; }
  const li = e.target.closest("li[data-i]"); if (li) openHeadline(li);
});
$("#news-list").addEventListener("keydown", (e) => {
  if (e.target.closest(".hl-c")) return;                                   // the conflict button handles its own keys
  const li = e.target.closest("li[data-i]"); if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openHeadline(li); }
});
function setNewsOpen(on) { $("#news").classList.toggle("shut", !on); $("#news-toggle").setAttribute("aria-expanded", on); }
$("#news-toggle").addEventListener("click", () => {
  const on = $("#news").classList.contains("shut"); setNewsOpen(on);
  try { localStorage.setItem("news.open", on ? "1" : "0"); } catch (_) {}
});
{ let pref = null; try { pref = localStorage.getItem("news.open"); } catch (_) {} setNewsOpen(pref !== "0"); }
/* started after the first data load, so headlines can be matched to the conflicts */
function startHeadlines() {
  if (!isMobile()) { loadHeadlines(); setInterval(loadHeadlines, 5 * 60000); }
  else mobileMQ.addEventListener("change", function once() { if (!isMobile()) { mobileMQ.removeEventListener("change", once); startHeadlines(); } });
}

/* ---------- layers menu, legend (on phones only one of them is open at a time), bottom sheet ---------- */
function toggleMenu(on = !document.body.classList.contains("menu-open")) {
  document.body.classList.toggle("menu-open", on);
  $("#menu-btn").setAttribute("aria-expanded", on);
  if (on && isMobile()) toggleLegend(false);
}
function toggleLegend(on = !document.body.classList.contains("legend-open"), remember = false) {
  document.body.classList.toggle("legend-open", on);
  $("#legend").setAttribute("aria-expanded", on);
  if (on && isMobile()) toggleMenu(false);
  if (remember && !isMobile()) try { localStorage.setItem("legendOpen", on ? "1" : "0"); } catch (_) {}
}
/* the key starts open on desktop (until closed once) and closed on phones */
function initialLegend() {
  let pref = null; try { pref = localStorage.getItem("legendOpen"); } catch (_) {}
  toggleLegend(!isMobile() && pref !== "0");
}
/* the key only lists what is on the map: rows for switched-off layers are hidden */
function syncLegend() {
  document.querySelectorAll("#legend [data-layer]").forEach(r => r.classList.toggle("off", !document.getElementById(r.dataset.layer).checked));
  document.querySelectorAll("#legend [data-advice]").forEach(r => r.classList.toggle("off", $("#tg-advice").value !== r.dataset.advice));
}
$("#menu-btn").addEventListener("click", () => { toggleMenu(); if (document.body.classList.contains("menu-open")) $("#menu-close").focus(); });
$("#menu-close").addEventListener("click", () => { toggleMenu(false); $("#menu-btn").focus(); });
$("#legend").addEventListener("click", (e) => { if (!e.target.closest("a")) toggleLegend(undefined, true); });
$("#legend").addEventListener("keydown", (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleLegend(undefined, true); } });
$("#controls").addEventListener("change", syncLegend);
document.addEventListener("click", (e) => {       // click anywhere outside the layers popover closes it
  if (document.body.classList.contains("menu-open") && !e.target.closest("#controls, #menu-btn, #map")) toggleMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.body.classList.contains("menu-open")) { toggleMenu(false); $("#menu-btn").focus(); return; }
    if (e.target.closest && e.target.closest("input, select")) return;
    if (readerOpen) closeReader(); else if (selected) goBack(); else if (selectedCountry) select(null);
    return;
  }
  // Enter / Space on a focusable list row acts like a click
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".card, .src, .dev[role], .strike, .fig[role], .alt div")) {
    e.preventDefault(); e.target.click();
  }
});
initialLegend(); syncLegend();

/* ---------- list search / filters ---------- */
{
  let t = null;
  $("#q").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { LIST.q = $("#q").value.trim().toLowerCase(); if (STATE) applyListFilter(); }, 120);
  });
  $("#status-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    LIST.status = b.dataset.status; if (STATE) applyListFilter();
  });
  $("#region").addEventListener("change", () => STATE && applyListFilter());
  $("#sort").addEventListener("change", () => STATE && applyListFilter());
}

const SHEET = ["min", "peek", "full"];
function setSheet(state) {
  const p = $("#panel");
  if (p.dataset.sheet === state) return;
  p.dataset.sheet = state;
  if (state === "min") p.scrollTop = 0;
}
const sheetStep = (d) => setSheet(SHEET[Math.max(0, Math.min(2, SHEET.indexOf($("#panel").dataset.sheet) + d))]);
/* map padding so flyTo targets land in the part of the map the sheet doesn't cover */
function sheetPadding() {
  if (!isMobile()) return { top: 0, bottom: 0, left: 0, right: 0 };
  const p = $("#panel"), h = p.dataset.sheet === "full" ? 0.42 * $("#main").clientHeight : p.offsetHeight;
  return { top: 0, bottom: Math.round(h), left: 0, right: 0 };
}
{
  const handle = $("#sheet-handle");
  let y0 = null, moved = false;
  handle.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; moved = false; }, { passive: true });
  handle.addEventListener("touchmove", (e) => { if (y0 !== null && Math.abs(e.touches[0].clientY - y0) > 8) moved = true; }, { passive: true });
  handle.addEventListener("touchend", (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (moved && Math.abs(dy) > 30) { e.preventDefault(); sheetStep(dy < 0 ? 1 : -1); }
  });
  handle.addEventListener("click", () => {
    const s = $("#panel").dataset.sheet;
    setSheet(s === "min" ? "peek" : s === "peek" ? "full" : "min");
  });
}
mobileMQ.addEventListener("change", () => { toggleMenu(false); initialLegend(); syncConflictLabelVisibility(); map.setPadding(sheetPadding()); });
if (isMobile() && !sharedView) map.setPadding(sheetPadding());   // start with the globe above the sheet
$("#weapon-legend").innerHTML = [["missile", "missile"], ["drone", "drone"], ["airstrike", "airstrike"], ["bombing", "bombing"],
  ["artillery", "shelling"], ["ground", "ground"], ["naval", "naval"], ["other", "other"]]
  .map(([w, label]) => `${weaponSvg(w, 13)} ${label}`).join(" ");
