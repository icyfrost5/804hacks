
"use strict";

let sites = [];
let ecoMap = null;
let markerLayer = null;
let selectedSiteId = null;

const $ = id => document.getElementById(id);

const PAGE_INFO = {
  overview: [
    "Virginia Overview",
    "Environmental monitoring workspace for connected data sources."
  ],
  sites: [
    "Monitoring Sites",
    "Browse monitoring records supplied by the backend."
  ],
  alerts: [
    "Anomaly Alerts",
    "Review findings generated from connected monitoring records."
  ],
  analysis: [
    "Environmental Analysis",
    "Summarize connected monitoring records."
  ],
  "environment-test-data": [
    "Environment Test Data",
    "Run hypothetical scenarios to explore potential environmental impacts."
  ]
};

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function statusClass(status) {
  return status;
}

async function initEcoSentinel() {
  bindNavigation();
  bindControls();
  const connectionStatus = document.querySelector(".connection-status");
  connectionStatus.textContent = "Loading environmental data…";
  connectionStatus.setAttribute("aria-live", "polite");
  $("siteCountTag").textContent = "Loading data…";
  $("sensorTable").innerHTML =
    '<tr><td colspan="5"><div class="empty">Loading monitoring records…</div></td></tr>';
  $("allAlerts").innerHTML = '<div class="empty">Loading monitoring records…</div>';
  $("recentAlerts").innerHTML = '<div class="empty">Loading monitoring records…</div>';
  initializeMap();
  sites = await loadSites();
  renderDataViews();
  showPage(getModuleFromUrl(), false);
  if (!sites.length) window.setTimeout(retryDataConnection, 15000);
  console.info(`EcoSentinel initialized with ${sites.length} backend records.`);
}

async function loadSites() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await new Promise(resolve => window.setTimeout(resolve, attempt * 1000));
    }

    try {
      const response = await fetch("/api/sites", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Monitoring data request failed (${response.status}).`);
      }
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error("Monitoring data response was not a list.");
      return records;
    } catch (error) {
      if (attempt === 2) {
        console.error("EcoSentinel could not load backend monitoring records:", error);
      }
    }
  }

  return [];
}

async function retryDataConnection() {
  if (sites.length) return;

  sites = await loadSites();
  renderDataViews();
  if (!sites.length) window.setTimeout(retryDataConnection, 15000);
}

function renderDataViews() {
  const connectionStatus = document.querySelector(".connection-status");
  connectionStatus.textContent = sites.length
    ? `Connected data · ${sites.length} records`
    : "Monitoring data unavailable · retrying";
  renderMetrics();
  renderTable();
  renderAlerts();
  renderRecentAlerts();
  $("analyzeBtn").disabled = sites.length === 0;
  renderMarkers();
}

function bindNavigation() {
  document.querySelectorAll(".nav-btn").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      showPage(button.dataset.page);
    });
  });

  document.querySelectorAll("[data-goto]").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      showPage(link.dataset.goto);
    });
  });

  window.addEventListener("popstate", () => {
    showPage(getModuleFromUrl(), false);
  });
}

function getModuleFromUrl() {
  const requested = new URLSearchParams(window.location.search).get("module");
  return PAGE_INFO[requested] ? requested : "overview";
}

function showPage(pageName, updateUrl = true) {
  if (!PAGE_INFO[pageName]) return;

  document.querySelectorAll(".nav-btn").forEach(button => {
    const isActive = button.dataset.page === pageName;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle(
      "active",
      page.id === `page-${pageName}`
    );
  });

  $("pageTitle").textContent = PAGE_INFO[pageName][0];
  $("pageSubtitle").textContent = PAGE_INFO[pageName][1];

  if (updateUrl && getModuleFromUrl() !== pageName) {
    const url = new URL(window.location.href);
    url.searchParams.set("module", pageName);
    window.history.pushState({ module: pageName }, "", url);
  }

  // Critical fix for Leaflet when its container was hidden.
  if (pageName === "overview" && ecoMap) {
    requestAnimationFrame(() => ecoMap.invalidateSize(true));
    setTimeout(() => {
      if (ecoMap) ecoMap.invalidateSize(true);
    }, 250);
  }
}

function bindControls() {
  $("sensorSearch").addEventListener("input", renderTable);
  $("sensorTypeFilter").addEventListener("change", renderTable);
  $("sensorStatusFilter").addEventListener("change", renderTable);

  $("alertTypeFilter").addEventListener("change", renderAlerts);
  $("alertStatusFilter").addEventListener("change", renderAlerts);

  $("resetMapBtn").addEventListener("click", () => {
    if (ecoMap) ecoMap.setView([37.5, -79.0], 7);
  });

  $("analyzeBtn").addEventListener("click", runAnalysis);
  $("scenarioSeverity").addEventListener("input", event => {
    $("severityValue").value = `${event.target.value} / 5`;
  });
  $("scenarioForm").addEventListener("submit", event => {
    event.preventDefault();
    runEnvironmentSimulation();
  });
}

function initializeMap() {
  const mapElement = $("map");

  if (!mapElement) {
    console.error("EcoSentinel: #map element was not found.");
    return;
  }

  if (typeof L === "undefined") {
    mapElement.innerHTML =
      '<div style="padding:20px;color:#222">Leaflet failed to load. Check your internet connection and script tag.</div>';

    console.error("EcoSentinel: Leaflet did not load.");
    return;
  }

  // Prevent Leaflet from initializing twice.
  if (ecoMap) {
    ecoMap.invalidateSize(true);
    return;
  }

  // Center map over Virginia.
  ecoMap = L.map(mapElement).setView([37.5, -79.0], 7);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(ecoMap);

  markerLayer = L.layerGroup().addTo(ecoMap);
  renderMarkers();

  // Fix blank or partially rendered maps after layout changes.
  requestAnimationFrame(() => {
    if (ecoMap) ecoMap.invalidateSize(true);
  });

  setTimeout(() => {
    if (ecoMap) ecoMap.invalidateSize(true);
  }, 300);

  ecoMap.on("tileerror", event => {
    console.warn("Map tile failed to load:", event.tile?.src);
  });

  console.info("EcoSentinel: Leaflet map initialized.");
}

function renderMarkers() {
  if (!ecoMap || !markerLayer) return;

  markerLayer.clearLayers();

  sites.forEach(site => {
    const color = site.status === "Anomaly"
      ? "#ff7777"
      : site.status === "Watch"
        ? "#e8b949"
        : "#3dbb78";

    const radius = site.status === "Anomaly"
      ? 10
      : site.status === "Watch"
        ? 8
        : 6;

    const marker = L.circleMarker(
      [site.lat, site.lng],
      {
        radius,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.8
      }
    );

    marker.bindPopup(`
      <strong>${escapeHTML(site.name)}</strong><br>
      ${escapeHTML(site.city)}, Virginia<br>
      ${escapeHTML(site.category)} · ${escapeHTML(site.status)}<br>
      ${escapeHTML(site.metric)}:
      ${escapeHTML(site.value)} ${escapeHTML(site.unit)}<br>
      <small>Connected monitoring record</small>
    `);

    marker.on("click", () => {
      selectSite(site.id, false);
    });

    markerLayer.addLayer(marker);
  });
}

function selectSite(id, panToSite = true) {
  const site = sites.find(item => item.id === Number(id));
  if (!site) return;

  selectedSiteId = site.id;
  renderDetails(site);

  if (panToSite) {
    showPage("overview");

    if (ecoMap) {
      ecoMap.setView(
        [site.lat, site.lng],
        Math.max(ecoMap.getZoom(), 8)
      );

      const marker = markerLayer.getLayers().find(layer => {
        const point = layer.getLatLng();
        return Math.abs(point.lat - site.lat) < 0.0001 &&
               Math.abs(point.lng - site.lng) < 0.0001;
      });

      if (marker) marker.openPopup();
    }
  }
}

function renderDetails(site) {
  const host = $("sensorDetails");

  if (!site) {
    host.innerHTML =
      '<div class="empty">Select a marker to view its details.</div>';
    return;
  }

  host.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:14px">
      <div>
        <strong>${escapeHTML(site.name)}</strong>
        <div class="muted">${escapeHTML(site.city)}, Virginia</div>
      </div>
      <span class="status ${statusClass(site.status)}">
        ${escapeHTML(site.status)}
      </span>
    </div>

    <div class="detail-grid">
      <div class="detail-cell">
        <span>Category</span>
        <strong>${escapeHTML(site.category)}</strong>
      </div>
      <div class="detail-cell">
        <span>Sample reading</span>
        <strong>${escapeHTML(site.value)}
          <small>${escapeHTML(site.unit)}</small>
        </strong>
      </div>
      <div class="detail-cell">
        <span>Reference baseline</span>
        <strong>${escapeHTML(site.baseline)}
          <small>${escapeHTML(site.unit)}</small>
        </strong>
      </div>
      <div class="detail-cell">
        <span>Indicator</span>
        <strong>${escapeHTML(site.metric)}</strong>
      </div>
    </div>

    <div class="detail-note">
      <strong style="color:white">Finding</strong><br>
      ${escapeHTML(site.issue)}
    </div>

    <div class="detail-note">
      <strong style="color:#83e0a4">Suggested next step</strong><br>
      ${escapeHTML(site.recommendation)}
    </div>

    ${Array.isArray(site.readings) ? `
      <div class="detail-note">
        <strong style="color:white">Sample readings</strong>
        <div class="detail-grid" style="margin-top:10px">
          ${site.readings.map(reading => `
            <div class="detail-cell">
              <span>${escapeHTML(reading.metric)}</span>
              <strong>${escapeHTML(reading.value)} <small>${escapeHTML(reading.unit)}</small></strong>
              <small class="site-sub">Reference: ${escapeHTML(reading.baseline)} ${escapeHTML(reading.unit)}</small>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="detail-note">Observed ${escapeHTML(site.observed_at)}</div>
    ` : ""}

    <div class="detail-note">
      Coordinates: ${site.lat.toFixed(4)}, ${site.lng.toFixed(4)}<br>
      Source: <a href="${escapeHTML(site.source_url)}" target="_blank" rel="noreferrer">${escapeHTML(site.source)}</a>
      ${site.license ? `<br>License: ${escapeHTML(site.license)}` : ""}
    </div>
  `;
}

function renderMetrics() {
  if (!sites.length) {
    $("metricSites").textContent = "—";
    $("metricAlerts").textContent = "—";
    $("metricReview").textContent = "—";
    $("metricSitesNote").textContent = "No connected records";
    $("metricAlertsNote").textContent = "No anomaly-level records";
    $("metricReviewNote").textContent = "No records to review";
    $("mapDescription").textContent = "No monitoring locations are available.";
    return;
  }

  $("metricSites").textContent = sites.length;
  $("metricSitesNote").textContent = `${new Set(sites.map(site => site.city)).size} Virginia locations`;

  const anomalies = sites.filter(site => site.status === "Anomaly").length;
  $("metricAlerts").textContent = anomalies;
  $("metricAlertsNote").textContent = `${anomalies} anomaly-level records`;

  const flagged = sites.filter(site => site.status !== "Normal").length;
  $("metricReview").textContent = flagged;
  $("metricReviewNote").textContent = `${flagged} records flagged for review`;
  $("mapDescription").textContent =
    `${sites.length} records across ${new Set(sites.map(site => site.city)).size} Virginia locations. Select a marker to inspect its source data.`;
}

function renderTable() {
  const query = $("sensorSearch").value.trim().toLowerCase();
  const category = $("sensorTypeFilter").value;
  const status = $("sensorStatusFilter").value;

  const filtered = sites.filter(site => {
    const searchable = [
      site.name,
      site.city,
      site.category,
      site.metric,
      site.issue
    ].join(" ").toLowerCase();

    return (!query || searchable.includes(query)) &&
      (category === "all" || site.category === category) &&
      (status === "all" || site.status === status);
  });

  $("siteCountTag").textContent = sites.length
    ? `${filtered.length} of ${sites.length} records`
    : "Awaiting data";

  $("sensorTable").innerHTML = filtered.length
    ? filtered.map(site => `
        <tr data-site-id="${site.id}" tabindex="0">
          <td>
            <strong>${escapeHTML(site.name)}</strong>
            <span class="site-sub">${escapeHTML(site.city)}, VA</span>
          </td>
          <td>${escapeHTML(site.category)}</td>
          <td>
            ${escapeHTML(site.value)} ${escapeHTML(site.unit)}
            <span class="site-sub">${escapeHTML(site.metric)}</span>
          </td>
          <td>
            <span class="status ${statusClass(site.status)}">
              ${escapeHTML(site.status)}
            </span>
          </td>
          <td>${escapeHTML(site.source || "Backend record")}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="5"><div class="empty">${sites.length
      ? "No matching sites. Change your search or filters."
      : "No monitoring records are available. Connect a backend data provider to populate this list."}</div></td></tr>`;

  $("sensorTable").querySelectorAll("[data-site-id]").forEach(row => {
    row.addEventListener("click", () => {
      selectSite(row.dataset.siteId, true);
    });

    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSite(row.dataset.siteId, true);
      }
    });
  });
}

function alertCard(site, compact = false) {
  return `
    <article class="alert-card">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
        <strong>${escapeHTML(site.name)}</strong>
        <span class="status ${statusClass(site.status)}">
          ${escapeHTML(site.status)}
        </span>
      </div>

      <p>${escapeHTML(site.city)} · ${escapeHTML(site.category)}</p>
      <p>${escapeHTML(site.issue)}</p>

      ${compact ? "" : `
        <p>
          ${escapeHTML(site.metric)}:
          ${escapeHTML(site.value)} ${escapeHTML(site.unit)}
        </p>
        <p>${escapeHTML(site.recommendation)}</p>
      `}

      <div style="margin-top:10px">
        <button class="secondary-btn" data-open-site="${site.id}">
          Inspect site
        </button>
      </div>
    </article>
  `;
}

function bindInspectButtons(host) {
  host.querySelectorAll("[data-open-site]").forEach(button => {
    button.addEventListener("click", () => {
      selectSite(button.dataset.openSite, true);
    });
  });
}

function renderAlerts() {
  const category = $("alertTypeFilter").value;
  const status = $("alertStatusFilter").value;

  const flagged = sites
    .filter(site =>
      site.status !== "Normal" &&
      (category === "all" || site.category === category) &&
      (status === "all" || site.status === status)
    )
    .sort((a, b) =>
      (a.status === "Anomaly" ? 0 : 1) -
      (b.status === "Anomaly" ? 0 : 1)
    );

  const host = $("allAlerts");

  host.innerHTML = flagged.length
    ? flagged.map(site => alertCard(site)).join("")
    : `<div class="empty">${sites.length
      ? "No alerts match these filters."
      : "Alerts will appear when monitoring records are connected."}</div>`;

  bindInspectButtons(host);
}

function renderRecentAlerts() {
  const host = $("recentAlerts");

  const flagged = sites
    .filter(site => site.status !== "Normal")
    .sort((a, b) =>
      (a.status === "Anomaly" ? 0 : 1) -
      (b.status === "Anomaly" ? 0 : 1)
    )
    .slice(0, 4);

  host.innerHTML = flagged.length
    ? flagged.map(site => alertCard(site, true)).join("")
    : '<div class="empty">No connected monitoring alerts.</div>';

  bindInspectButtons(host);
}

function runAnalysis() {
  if (!sites.length) {
    $("analysisOutput").textContent = "Analysis is unavailable until backend monitoring records are connected.";
    return;
  }

  const categories = ["Air", "Water", "Waste", "Biodiversity"];
  const flagged = sites.filter(site => site.status !== "Normal");
  const anomalies = sites.filter(site => site.status === "Anomaly");
  const metricGroups = new Map();

  sites.forEach(site => {
    if (site.category === "Biodiversity") return;

    const readings = Array.isArray(site.readings) && site.readings.length
      ? site.readings
      : [{ metric: site.metric, value: site.value, unit: site.unit, baseline: site.baseline }];

    readings.forEach(reading => {
      const value = Number(reading.value);
      if (!Number.isFinite(value)) return;

      const metric = String(reading.metric || site.metric || "Measurement");
      const unit = String(reading.unit || "");
      const key = `${site.category}|${metric.toLowerCase()}|${unit.toLowerCase()}`;
      const group = metricGroups.get(key) || {
        category: site.category,
        metric,
        unit,
        values: [],
        baselines: []
      };
      group.values.push(value);

      const baselineValue = reading.baseline ?? (metric === site.metric ? site.baseline : null);
      const baseline = baselineValue === null ? NaN : Number(baselineValue);
      if (Number.isFinite(baseline)) group.baselines.push(baseline);
      metricGroups.set(key, group);
    });
  });

  const lines = [
    "ECOSENTINEL · CONNECTED DATA ANALYSIS",
    "================================",
    `Records analyzed: ${sites.length}`,
    `Records flagged for review: ${flagged.length}`,
    `Anomaly-level sites: ${anomalies.length}`,
    "",
    "CATEGORY SUMMARY"
  ];

  categories.forEach(category => {
    const subset = sites.filter(site => site.category === category);
    const categoryFlagged = subset.filter(site => site.status !== "Normal");
    lines.push(
      `${category}: ${subset.length} records; ${categoryFlagged.length} flagged`
    );
  });

  lines.push("", "CURRENT MEASUREMENTS BY METRIC");
  [...metricGroups.values()]
    .sort((a, b) => `${a.category} ${a.metric}`.localeCompare(`${b.category} ${b.metric}`))
    .forEach(group => {
      const average = group.values.reduce((sum, value) => sum + value, 0) / group.values.length;
      const baseline = group.baselines.length
        ? group.baselines.reduce((sum, value) => sum + value, 0) / group.baselines.length
        : null;
      const valueText = `${average.toFixed(2)} ${group.unit}`.trim();
      let referenceText = "reference unavailable";

      if (baseline !== null) {
        const difference = average - baseline;
        const signedDifference = `${difference > 0 ? "+" : ""}${difference.toFixed(2)} ${group.unit}`.trim();
        referenceText = /^ph$/i.test(group.metric) || baseline === 0
          ? `change ${signedDifference} vs baseline ${baseline.toFixed(2)}`
          : `change ${((difference / Math.abs(baseline)) * 100).toFixed(1)}% vs baseline ${baseline.toFixed(2)}`;
      }

      lines.push(`${group.category} · ${group.metric}: ${valueText} (${group.values.length} readings; ${referenceText})`);
    });

  const biodiversityRecords = sites.filter(site => site.category === "Biodiversity");
  if (biodiversityRecords.length) {
    const uniqueSpecies = new Set(biodiversityRecords.map(site => site.name)).size;
    lines.push(
      `Biodiversity: ${biodiversityRecords.length} occurrence records across ${uniqueSpecies} species; these are not population estimates.`
    );
  }

  lines.push("", "PRIORITY ITEMS TO VERIFY");

  if (anomalies.length) {
    anomalies.forEach(site => {
      lines.push(
        `• ${site.city}: ${site.metric} = ${site.value} ${site.unit}.`
      );
      lines.push(`  Suggested step: ${site.recommendation}`);
    });
  } else {
    lines.push("No anomaly-level items in the connected records.");
  }

  lines.push(
    "",
    "IMPORTANT LIMITATION",
    "This summary is based on backend records and does not establish environmental causation. Verify findings with appropriate measurements and trusted public data."
  );

  $("analysisOutput").textContent = lines.join("\n");
}

function runEnvironmentSimulation() {
  const formatNumber = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  const scenarios = {
    air: {
      name: "Air pollution event",
      categories: ["air"],
      system: "Air quality and respiratory exposure",
      direction: 1,
      impact: "Air measurements are projected upward from their backend averages to model a pollution event.",
      response: "Compare projected averages with official air-quality guidance and prioritize sensitive populations."
    },
    runoff: {
      name: "Heavy rainfall and runoff",
      categories: ["water"],
      system: "Watersheds, waterways, and soil",
      direction: 1,
      impact: "Water measurements are projected from backend averages; dissolved oxygen is modeled downward while other indicators rise.",
      response: "Compare projected averages with local water-quality guidance and review drainage, erosion, and upstream conditions."
    },
    heat: {
      name: "Prolonged extreme heat",
      categories: ["air", "water"],
      contextCategories: ["biodiversity"],
      system: "Habitats, surface water, and urban health",
      direction: 1,
      impact: "Air and water measurements are adjusted to model a heat event. Species occurrence records are not projected because they do not measure population size or trend.",
      response: "Compare projected averages with heat, air, and water guidance; review biodiversity observations separately and prioritize vulnerable people and ecosystems."
    },
    waste: {
      name: "Waste collection disruption",
      categories: ["waste"],
      system: "Land, waterways, and public health",
      direction: 1,
      impact: "Numeric waste indicators are projected upward from their backend averages to model a collection disruption.",
      response: "Prioritize locations with the highest projected averages and inspect nearby storm drains and waterways."
    }
  };
  const scenario = scenarios[$("scenarioType").value];
  const severity = Number($("scenarioSeverity").value);
  const duration = Number($("scenarioDuration").value);

  if (!Number.isFinite(duration) || duration < 1 || duration > 168) {
    $("scenarioDuration").setCustomValidity("Enter a duration from 1 to 168 hours.");
    $("scenarioDuration").reportValidity();
    return;
  }
  $("scenarioDuration").setCustomValidity("");

  const matchingSites = sites.filter(site =>
    scenario.categories.includes(String(site.category).toLowerCase())
  );
  const metricGroups = new Map();

  matchingSites.forEach(site => {
    const readings = Array.isArray(site.readings) && site.readings.length
      ? site.readings
      : [{ metric: site.metric, value: site.value, unit: site.unit }];

    readings.forEach(reading => {
      const value = Number(reading.value);
      if (!Number.isFinite(value)) return;

      const metric = String(reading.metric || site.metric || "Measurement");
      const unit = String(reading.unit || "");
      const key = `${metric.toLowerCase()}|${unit.toLowerCase()}`;
      const group = metricGroups.get(key) || {
        metric,
        unit,
        values: [],
        baselines: [],
        baselineLabels: new Set()
      };

      group.values.push(value);
      const baselineValue = reading.baseline ?? (metric === site.metric ? site.baseline : null);
      const baseline = baselineValue === null ? NaN : Number(baselineValue);
      if (Number.isFinite(baseline)) {
        group.baselines.push(baseline);
        if (reading.baseline_label) group.baselineLabels.add(reading.baseline_label);
      }
      metricGroups.set(key, group);
    });
  });

  const measurements = [...metricGroups.values()].map(group => {
    const average = group.values.reduce((sum, value) => sum + value, 0) / group.values.length;
    const baseline = group.baselines.length
      ? group.baselines.reduce((sum, value) => sum + value, 0) / group.baselines.length
      : null;
    const metricName = group.metric.toLowerCase();
    let direction = scenario.direction;

    if (scenario === scenarios.runoff && /dissolved oxygen|oxygen/.test(metricName)) direction = -1;
    if (scenario === scenarios.heat && /dissolved oxygen|oxygen|biodiversity|species|habitat/.test(metricName)) direction = -1;
    if (scenario === scenarios.heat && /temperature/.test(metricName)) direction = 1;

    const referenceValue = baseline !== null && baseline !== 0 ? Math.abs(baseline) : Math.abs(average);
    const changePercent = Math.min(50, severity * 2.5 + (Math.min(duration, 168) / 24) * 1.5);
    const projected = Math.max(
      0,
      average + (referenceValue * changePercent / 100 * direction)
    );
    const baselineChangePercent = baseline === null || baseline === 0 || /^ph$/i.test(group.metric)
      ? null
      : ((projected - baseline) / Math.abs(baseline)) * 100;
    const risk = baselineChangePercent === null
      ? null
      : Math.max(0, Math.min(100, baselineChangePercent * direction));
    const change = baseline === null
      ? "Reference unavailable"
      : baseline === 0
        ? `${projected === baseline ? "No change" : `${projected > baseline ? "+" : ""}${formatNumber(projected - baseline)} ${group.unit} from zero baseline`}`
        : /^ph$/i.test(group.metric)
          ? `${projected >= baseline ? "+" : ""}${formatNumber(projected - baseline)} pH from baseline`
          : `${baselineChangePercent >= 0 ? "+" : ""}${formatNumber(baselineChangePercent)}% vs baseline`;

    return {
      metric: group.metric,
      unit: group.unit,
      count: group.values.length,
      average,
      baseline,
      projected,
      risk,
      change,
      baselineLabel: [...group.baselineLabels].join(", ")
    };
  });

  if (!measurements.length) {
    $("scenarioResult").innerHTML = `
      <div class="eyebrow">Backend measurements required</div>
      <h2>${escapeHTML(scenario.name)}</h2>
      <div class="empty">No numeric backend measurements were found for ${escapeHTML(scenario.categories.join(", "))}. Connect matching monitoring records to calculate average readings and scenario projections.</div>
    `;
    return;
  }

  const risks = measurements.filter(item => item.risk !== null).map(item => item.risk);
  const riskScore = risks.length
    ? Math.round(risks.reduce((sum, value) => sum + value, 0) / risks.length)
    : null;
  const riskLevel = riskScore === null
    ? "Baseline unavailable"
    : riskScore >= 75 ? "High" : riskScore >= 45 ? "Elevated" : "Lower";
  const riskColor = riskScore === null
    ? "var(--muted)"
    : riskScore >= 75 ? "var(--red)" : riskScore >= 45 ? "var(--yellow)" : "var(--green)";
  const contextualObservations = scenario.contextCategories
    ? sites.filter(site => scenario.contextCategories.includes(String(site.category).toLowerCase())).length
    : 0;
  const formatValue = formatNumber;
  const averageRows = measurements.map(item => `
    <tr>
      <td>${escapeHTML(item.metric)}</td>
      <td>${item.count}</td>
      <td>${formatValue(item.average)} ${escapeHTML(item.unit)}</td>
      <td>${item.baseline === null ? "Unavailable" : `${formatValue(item.baseline)} ${escapeHTML(item.unit)}${item.baselineLabel ? `<span class="site-sub">${escapeHTML(item.baselineLabel)}</span>` : ""}`}</td>
      <td>${formatValue(item.projected)} ${escapeHTML(item.unit)}</td>
      <td>${escapeHTML(item.change)}</td>
    </tr>
  `).join("");

  $("scenarioResult").innerHTML = `
    <div class="eyebrow">Scenario output · ${riskLevel} relative risk</div>
    <h2>${escapeHTML(scenario.name)}</h2>
    <div class="risk-score"><strong>${riskScore === null ? "—" : riskScore}</strong><span>average deviation from backend baselines / 100</span></div>
    <div class="risk-meter" aria-label="Average deviation from backend baselines ${riskScore === null ? "unavailable" : `${riskScore} out of 100`}">
      <span style="width:${riskScore === null ? 0 : riskScore}%;background:${riskColor}"></span>
    </div>
    <div class="detail-grid">
      <div class="detail-cell"><span>Scenario intensity</span><strong>${severity} / 5</strong></div>
      <div class="detail-cell"><span>Duration</span><strong>${duration} hours</strong></div>
      <div class="detail-cell"><span>Systems to review</span><strong>${escapeHTML(scenario.system)}</strong></div>
    </div>
    <p class="detail-note">${escapeHTML(scenario.impact)}</p>
    ${contextualObservations ? `<p class="footer-note">${contextualObservations} biodiversity occurrence records are available as context and are not treated as population measurements.</p>` : ""}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Metric</th><th>Readings averaged</th><th>Current average</th><th>Reference baseline</th><th>Projected average</th><th>Change vs baseline</th></tr></thead>
        <tbody>${averageRows}</tbody>
      </table>
    </div>
    <div class="detail-note"><strong style="color:var(--green)">Possible response</strong><br>${escapeHTML(scenario.response)}</div>
    <p class="footer-note">Projection applies a scenario adjustment to backend averages. It is a conceptual simulation, not a forecast or measured risk.</p>
  `;
}

// Wait for HTML elements to exist before initializing Leaflet and controls.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initEcoSentinel);
} else {
  initEcoSentinel();
}
