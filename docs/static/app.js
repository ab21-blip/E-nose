"use strict";

const APP = {
  PASSWORD: "vivafisika",
  BAUD_RATE: 9600,
  SAMPLE_RATE_HZ: 4,
  SAMPLE_INTERVAL_MS: 250,
  MAX_CHART_POINTS: 100,
  FILTERS: [{ usbVendorId: 0x1a86 }, { usbVendorId: 0x0403 }]
};

const names = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "Temp", "Hum"];
const colors = ["#2563EB", "#DC2626", "#F59E0B", "#7C3AED", "#06B6D4", "#EC4899", "#16A34A", "#EA580C"];

const $ = id => document.getElementById(id);

let chart, expandedChart, paused = false;
let serialPort = null, serialReader = null, serialWriter = null;
let connected = false, serialReady = false, processRunning = false;
let accumulatedData = [];
let rowNo = 0, phase = "READY";
let processTimer = null, processTimerResolve = null;

function timeNow() {
  return new Date().toLocaleTimeString("id-ID", { hour12: false });
}

function notice(message, type = "info") {
  const box = $("currentNotification");
  if (box) {
    box.className = `current-notification ${type}`;
    $("notificationText").textContent = message;
    $("notificationTime").textContent = timeNow();
    $("notificationMark")?.replaceChildren(
      type === "success" ? "✓" : type === "error" ? "×" : type === "warning" ? "!" : "i"
    );
  }
}

function makeChart(canvas) {
  return new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: names.map((name, i) => ({
        label: name,
        data: [],
        borderColor: colors[i % colors.length],
        borderWidth: 1.7,
        pointRadius: 0,
        tension: 0.25
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false }
      },
      scales: {
        x: { grid: { color: "#20432f" }, ticks: { color: "#9eb9a8", maxTicksLimit: 7 } },
        y: { min: 0, max: 5, grid: { color: "#20432f" }, ticks: { color: "#9eb9a8" } }
      }
    }
  });
}

function legend() {
  if ($("chartLegend")) {
    $("chartLegend").innerHTML = names
      .map((n, i) => `<span class="legend-item"><i class="legend-color" style="background:${colors[i % colors.length]}"></i>${n}</span>`)
      .join("");
  }
}

function draw(reading) {
  if (paused) return;
  const label = new Date(reading.timestamp || Date.now()).toLocaleTimeString("id-ID", { minute: "2-digit", second: "2-digit" });
  [chart, expandedChart].forEach(c => {
    if (!c) return;
    if (c.data.labels.length >= APP.MAX_CHART_POINTS) {
      c.data.labels.shift();
      c.data.datasets.forEach(d => d.data.shift());
    }
    c.data.labels.push(label);
    names.forEach((n, i) => c.data.datasets[i].data.push(Number(reading.values[n] || 0)));
    c.update();
  });
}

function table(reading) {
  rowNo++;
  const body = $("dataTableBody");
  if (rowNo === 1) body.innerHTML = "";
  const cells = names.map(n => `${n}: ${Number(reading.values[n] || 0).toFixed(3)} V`).join(" | ");
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${rowNo}</td><td>${new Date(reading.timestamp || Date.now()).toLocaleTimeString("id-ID")}</td><td>${phase}</td><td>${cells}</td>`;
  body.prepend(tr);
  while (body.children.length > 5) body.lastElementChild.remove();
}

function controls() {
  const ready = connected && serialReady && !processRunning;
  ["samplingButton", "arrayButton", "cleanButton"].forEach(id => $(id).disabled = !ready);
  $("stopButton").disabled = !processRunning;
  $("connectButton").textContent = connected ? "DISCONNECT" : "CONNECT";
  $("connectButton").classList.toggle("disconnect", connected);
  $("exportButton").disabled = accumulatedData.length === 0;
}

function processPhase(next) {
  phase = next;
  $("phaseBadge").textContent = next;
  $("phaseText").textContent = next;
  $("phaseTitle").textContent = next === "READY" ? "Waiting for acquisition" : `${next} in progress`;
  const map = { "01 INJECTION": "stepInjection" };
  ["stepInjection"].forEach(id => $(id).classList.remove("active"));
  if (map[next]) $(map[next]).classList.add("active");
}

function runProgressTimer(durationSeconds) {
  return new Promise(resolve => {
    const progressBar = $("phaseProgress");
    const timerText = $("timerText");
    const startedAt = Date.now();

    const update = () => {
      const elapsed = Math.min((Date.now() - startedAt) / 1000, durationSeconds);
      const percent = Math.min((elapsed / durationSeconds) * 100, 100);
      const seconds = Math.floor(elapsed);
      if (timerText) timerText.textContent = `00:${String(seconds).padStart(2, "0")}`;
      if (progressBar) progressBar.style.width = `${percent}%`;
      if (!processRunning || elapsed >= durationSeconds) {
        clearInterval(processTimer);
        processTimer = null;
        processTimerResolve = null;
        resolve();
      }
    };

    update();
    processTimerResolve = resolve;
    processTimer = setInterval(update, 250);
  });
}

function resetProgress() {
  if (processTimer) {
    clearInterval(processTimer);
    processTimer = null;
  }
  if (processTimerResolve) {
    processTimerResolve();
    processTimerResolve = null;
  }
  $("phaseProgress").style.width = "0%";
  $("timerText").textContent = "00:00";
  $("sampleTargetText").textContent = "0 / 0 samples";
}

function parseLine(line) {
  const values = String(line).trim().split(/[;,\t ]+/).map(Number);
  if (!values.length || values.some(v => !Number.isFinite(v))) return null;
  const schema = values.length === 8 ? ["S1", "S2", "S3", "S4", "S5", "S6", "Temp", "Hum"] :
                 values.length === 12 ? ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "Temp", "Hum"] : null;
  if (!schema) return null;
  const data = {};
  schema.forEach((key, i) => data[key] = values[i]);
  return data;
}

async function serialLoop(port) {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (connected) {
      serialReader = port.readable.getReader();
      const result = await serialReader.read();
      serialReader.releaseLock();
      serialReader = null;
      if (result.done) break;
      
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      
      lines.forEach(line => {
        const values = parseLine(line);
        if (!values) return;
        
        const timestamp = new Date().toISOString();
        const reading = { timestamp, values };
        
        accumulatedData.push({
          No: accumulatedData.length + 1,
          Timestamp: timestamp,
          Phase: phase,
          ...values
        });

        $("exportButton").disabled = false;
        $("chartEmpty").classList.add("hidden");
        $("chartScaleLabel").textContent = `LIVE SENSOR RESPONSE · ${phase} · 0–5 V`;
        $("dataRateBadge").textContent = "4.00 Hz";
        
        draw(reading);
        table(reading);
        $("totalData").textContent = rowNo;
      });
    }
  } catch (error) {
    if (connected) notice(`Serial reading stopped: ${error.message}`, "error");
  }
}

async function connect() {
  if (connected) {
    await disconnect();
    return;
  }
  if (!("serial" in navigator)) {
    notice("Web Serial memerlukan Chrome atau Edge.", "error");
    return;
  }
  try {
    serialPort = await navigator.serial.requestPort({ filters: APP.FILTERS });
    await serialPort.open({ baudRate: APP.BAUD_RATE, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    connected = true;
    serialReady = false;
    $("connectionLamp").classList.add("online");
    $("connectionLamp").classList.remove("offline");
    $("deviceName").textContent = "CH340 / CH341 / FTDI SERIAL";
    $("connectionNote").textContent = "Serial connected · 9600 baud";
    controls();
    notice("Perangkat tersambung. Menyiapkan serial...", "info");
    
    serialWriter = serialPort.writable?.getWriter();
    if (serialWriter) {
      await serialWriter.write(new TextEncoder().encode("EK-Instrumentation\n"));
      serialWriter.releaseLock();
      serialWriter = null;
    }
    serialReady = true;
    controls();
    notice("Serial device connected and ready.", "success");
    void serialLoop(serialPort);
  } catch (error) {
    notice(error.name === "NotFoundError" ? "Pemilihan perangkat dibatalkan." : `Connection failed: ${error.message}`, "error");
    await disconnect();
  }
}

async function disconnect() {
  connected = false;
  serialReady = false;
  processRunning = false;
  resetProgress();
  try { await serialReader?.cancel(); } catch (_) {}
  try { serialReader?.releaseLock(); } catch (_) {}
  try { serialWriter?.releaseLock(); } catch (_) {}
  try { await serialPort?.close(); } catch (_) {}
  serialReader = null;
  serialWriter = null;
  serialPort = null;
  $("connectionLamp").classList.remove("online");
  $("connectionLamp").classList.add("offline");
  $("deviceName").textContent = "SERIAL DEVICE NOT CONNECTED";
  $("connectionNote").textContent = "Pilih perangkat CH340/CH341 atau FTDI.";
  processPhase("READY");
  controls();
  notice("Serial device disconnected.", "warning");
}

function settings() {
  const injection = Number($("injectionSeconds").value) || 10;
  const cycles = Number($("arrayCount").value) || 1;
  $("injectionSamples").textContent = `${Math.round(injection * 4)} samples @ 4 Hz`;
  $("arrayEstimate").textContent = `Estimated ${Math.ceil(injection * cycles / 60)} minutes`;
  return { injection, cycles };
}

function updateFileNamePreview() {
  const sample = $("sampleName")?.value.trim().replace(/\s+/g, "_") || "Nama_Sampel";
  if ($("fileNamePreview")) {
    $("fileNamePreview").textContent = `${sample}_Waktu.csv`;
  }
}

async function send(command) {
  if (!serialPort?.writable) return;
  const writer = serialPort.writable.getWriter();
  await writer.write(new TextEncoder().encode(command));
  writer.releaseLock();
}

async function start(cycles = 1) {
  if (!connected || !serialReady || processRunning) return;
  const value = settings();
  processRunning = true;
  controls();
  phase = "01 INJECTION";
  processPhase(phase);
  $("cycleCounter").textContent = `0 / ${cycles}`;
  $("sampleTargetText").textContent = `0 / ${Math.round(value.injection * 4 * cycles)} samples`;
  $("phaseProgress").style.width = "0%";
  notice(cycles > 1 ? `Array sampling started · ${cycles} cycles.` : "Sampling started.", "success");
  await send("S");
  const duration = value.injection * cycles * 1000;
  setTimeout(async () => {
    if (!processRunning) return;
    await send("Q");
    processRunning = false;
    processPhase("READY");
    controls();
    notice("Sampling completed.", "success");
  }, duration);
}

function clearData() {
  rowNo = 0;
  accumulatedData = [];
  $("exportButton").disabled = true;
  
  [chart, expandedChart].forEach(c => {
    if (!c) return;
    c.data.labels = [];
    c.data.datasets.forEach(d => d.data = []);
    c.update();
  });
  
  $("dataTableBody").innerHTML = '<tr><td colspan="4" class="empty-cell">NO DATA</td></tr>';
  $("chartEmpty").classList.remove("hidden");
  $("totalData").textContent = "0";
  notice("Displayed data cleared.", "warning");
}

function exportCSV() {
  if (accumulatedData.length === 0) {
    notice("Tidak ada data untuk diekspor.", "warning");
    return;
  }

  const keys = Object.keys(accumulatedData[0]);
  const csvRows = [keys.join(",")];

  for (const row of accumulatedData) {
    const values = keys.map(key => {
      const val = row[key];
      return typeof val === "string" ? `"${val}"` : val;
    });
    csvRows.push(values.join(","));
  }

  const csvString = csvRows.join("\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const sampleInput = $("sampleName")?.value.trim().replace(/\s+/g, "_");
  const sampleName = sampleInput || "MalikiNose_Data";
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${sampleName}_${dateStr}.csv`;

  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  notice(`Data berhasil diekspor ke ${filename}`, "success");
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ekDataReaderTheme", theme);
}

function setUiTheme(theme) {
  document.documentElement.setAttribute("data-ui-theme", theme);
  localStorage.setItem("ekDataReaderUiTheme", theme);
}

function unlock() {
  document.body.classList.remove("is-locked");
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
}

// Event Listeners
$("loginForm").addEventListener("submit", event => {
  event.preventDefault();
  if ($("loginPassword").value === APP.PASSWORD) {
    sessionStorage.setItem("malikiUnlocked", "1");
    unlock();
  } else {
    $("loginMessage").textContent = "ACCESS DENIED — incorrect password.";
  }
});

$("togglePassword").addEventListener("click", () => {
  $("loginPassword").type = $("loginPassword").type === "password" ? "text" : "password";
});

$("logoutButton").addEventListener("click", () => {
  sessionStorage.removeItem("malikiUnlocked");
  location.reload();
});

$("connectButton").addEventListener("click", connect);
if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", event => {
    if (event.target === serialPort) {
      notice("Perangkat serial terputus.", "error");
      void disconnect();
    }
  });
}
$("samplingButton").addEventListener("click", () => start(1));
$("arrayButton").addEventListener("click", () => start(Number($("arrayCount").value) || 1));
$("cleanButton").addEventListener("click", async () => {
  if (!connected || !serialReady || processRunning) return;
  processRunning = true;
  controls();
  processPhase("CLEANING");
  $("cycleCounter").textContent = "0 / 1";
  $("sampleTargetText").textContent = "Cleaning · 10 seconds";
  try {
    await send("W");
    notice("Sensor cleaning started.", "success");
    await runProgressTimer(10);
    if (processRunning) notice("Sensor cleaning completed.", "success");
  } catch (error) {
    notice(`Cleaning failed: ${error.message}`, "error");
  } finally {
    processRunning = false;
    processPhase("READY");
    resetProgress();
    controls();
  }
});

$("stopButton").addEventListener("click", async () => {
  await send("Q");
  resetProgress();
  processRunning = false;
  processPhase("READY");
  controls();
  notice("Acquisition stopped.", "warning");
});

$("pauseChartButton").addEventListener("click", () => {
  paused = !paused;
  $("pauseChartButton").textContent = paused ? "RESUME" : "PAUSE";
});

$("clearDataButton").addEventListener("click", clearData);
$("exportButton").addEventListener("click", exportCSV);

$("adaptiveYToggle").addEventListener("change", e => {
  const y = chart.options.scales.y;
  if (e.target.checked) {
    delete y.min;
    delete y.max;
    $("adaptiveYStatus").textContent = "ON";
  } else {
    y.min = 0;
    y.max = 5;
    $("adaptiveYStatus").textContent = "OFF";
  }
  chart.update();
});

$("expandChartButton").addEventListener("click", () => {
  $("chartModal").classList.remove("hidden");

  // Beri sedikit jeda agar DOM modal selesai dirender sebelum chart dibuat/di-resize
  setTimeout(() => {
    if (!expandedChart) {
      expandedChart = makeChart($("expandedSensorChart"));
    }
    expandedChart.resize();
    expandedChart.update();
  }, 50);
});

$("closeChartModal").addEventListener("click", () => $("chartModal").classList.add("hidden"));
$("aboutButton").addEventListener("click", () => $("aboutModal").classList.remove("hidden"));
$("aboutClose").addEventListener("click", () => $("aboutModal").classList.add("hidden"));

$("appearanceButton")?.addEventListener("click", () => $("appearancePopover")?.classList.toggle("hidden"));
$("appearanceClose")?.addEventListener("click", () => $("appearancePopover")?.classList.add("hidden"));
$("darkModeButton")?.addEventListener("click", () => setTheme("dark"));
$("lightModeButton")?.addEventListener("click", () => setTheme("light"));

$("themeOptionGrid")?.addEventListener("click", e => {
  const option = e.target.closest("[data-ui-theme-option]");
  if (option) {
    setUiTheme(option.getAttribute("data-ui-theme-option"));
    $("appearancePopover")?.classList.add("hidden");
  }
});

["injectionSeconds", "arrayCount"].forEach(id => $(id)?.addEventListener("input", settings));
$("sampleName")?.addEventListener("input", updateFileNamePreview);

window.addEventListener("DOMContentLoaded", () => {
  chart = makeChart($("sensorChart"));
  legend();
  settings();
  updateFileNamePreview();
  controls();
  if (sessionStorage.getItem("malikiUnlocked") === "1") unlock();
  if (!("serial" in navigator)) notice("Web Serial is unavailable in this browser.", "warning");
});
