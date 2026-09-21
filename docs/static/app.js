"use strict";

const APP = {
  PASSWORD: "vivafisika",
  BAUD_RATE: 9600,
  SAMPLE_RATE_HZ: 4,
  SAMPLE_INTERVAL_MS: 250,
  MAX_CHART_POINTS: 100,
  FILTERS: [] // Dibiarkan kosong agar port UART GPIO /dev/ttyAMA0 / dev/ttyS0 terdeteksi
};

const names = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "Temp", "Hum"];
const colors = ["#38BDF8", "#FB7185", "#FACC15", "#C084FC", "#2DD4BF", "#F472B6", "#4ADE80", "#FB923C", "#818CF8", "#A3E635", "#E879F9", "#22D3EE"];

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

function formatTimestamp(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function startHeaderClock() {
  const clock = $("loginClock");
  if (!clock) return;

  const updateClock = () => {
    const now = new Date();
    const date = now.toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
    const time = now.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    clock.textContent = `${date}, ${time}`;
  };

  updateClock();
  setInterval(updateClock, 1000);
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
  const toastRegion = $("toastRegion");
  if (toastRegion) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastRegion.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }
}

function updateConnectionIndicator(isOnline) {
  [$("connectionLamp"), $("headerConnectionLamp")].forEach(indicator => {
    if (!indicator) return;
    indicator.classList.toggle("online", isOnline);
    indicator.classList.toggle("offline", !isOnline);
    indicator.setAttribute("aria-label", isOnline ? "Serial terhubung" : "Serial tidak terhubung");
    indicator.title = isOnline ? "Serial terhubung" : "Serial tidak terhubung";
  });
  const status = $("headerConnectionStatus");
  if (status) status.querySelector("span").textContent = isOnline ? "ONLINE" : "OFFLINE";
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
  const markup = names
    .map((n, i) => `<span class="legend-item"><i class="legend-color" style="background:${colors[i % colors.length]}"></i>${n}</span>`)
    .join("");
  [$("chartLegend"), $("expandedChartLegend")].forEach(element => {
    if (element) element.innerHTML = markup;
  });
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
  tr.innerHTML = `<td>${rowNo}</td><td>${formatTimestamp(reading.timestamp || Date.now())}</td><td>${phase}</td><td>${cells}</td>`;
  body.appendChild(tr);
  while (body.children.length > 5) body.lastElementChild.remove();
  body.parentElement.scrollTop = body.parentElement.scrollHeight;
}

function controls() {
  const ready = connected && serialReady && !processRunning;
  ["samplingButton", "arrayButton", "cleanButton"].forEach(id => $(id).disabled = !ready);$("stopButton").disabled = !processRunning;
  $("connectButton").disabled = processRunning;
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
      const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
      const remainder = String(seconds % 60).padStart(2, "0");
      if (timerText) timerText.textContent = `${minutes}:${remainder}`;
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

// PERBAIKAN PARSING DATA SERIAL UNTUK GRAFIK
function parseLine(line) {
  const cleanLine = String(line).replace(/[^\d.,; \t-]/g, "").trim();
  if (!cleanLine) return null;

  const values = cleanLine.split(/[;,\t ]+/).map(Number);
  if (!values.length || values.some(v => !Number.isFinite(v))) return null;

  const schema = values.length === 8
    ? ["S1", "S2", "S3", "S4", "S5", "S6", "Temp", "Hum"]
    : values.length === 12
      ? ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "Temp", "Hum"]
      : values.map((_, index) => index < values.length - 2 ? `S${index + 1}` : index === values.length - 2 ? "Temp" : "Hum");
  
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
        console.log("Raw Serial Line:", line); // Cek data masuk di F12 Console
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

// PERBAIKAN UTAMA DI FUNGSI CONNECT (LEWATKAN APP.FILTERS SECARA EKSPLISIT)
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
    updateConnectionIndicator(true);
    $("connectionLamp").classList.add("online");
    $("connectionLamp").classList.remove("offline");
    $("deviceName").textContent = "UART GPIO / CH340 / FTDI SERIAL";
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
  updateConnectionIndicator(false);
  $("connectionLamp").classList.remove("online");
  $("connectionLamp").classList.add("offline");
  $("deviceName").textContent = "SERIAL DEVICE NOT CONNECTED";
  $("connectionNote").textContent = "Pilih port serial internal atau USB.";
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
  try {
    await writer.write(new TextEncoder().encode(command));
  } finally {
    writer.releaseLock();
  }
}

async function start(cycles = 1) {
  if (!connected || !serialReady || processRunning) return;
  const value = settings();
  processRunning = true;
  controls();
  phase = "01 INJECTION";
  processPhase(phase);
  const targetSamples = Math.round(value.injection * APP.SAMPLE_RATE_HZ * cycles);
  $("cycleCounter").textContent = `1 / ${cycles}`;
  $("sampleTargetText").textContent = `0 / ${targetSamples} samples`;
  notice(cycles > 1 ? `Array sampling started · ${cycles} cycles.` : "Sampling started.", "success");
  try {
    await send("S");
    await runProgressTimer(value.injection * cycles);
    if (processRunning) {
      await send("Q");
      notice("Sampling completed.", "success");
    }
  } catch (error) {
    notice(`Sampling failed: ${error.message}`, "error");
  } finally {
    processRunning = false;
    processPhase("READY");
    resetProgress();
    controls();
  }
}

function clearData() {
  if (accumulatedData.length > 0 && !window.confirm("Hapus seluruh data yang sudah direkam?")) return;
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

  const keys = [...new Set(accumulatedData.flatMap(row => Object.keys(row)))];
  const formatCell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csvRows = [keys.map(formatCell).join(",")];

  for (const row of accumulatedData) {
    const values = keys.map(key => formatCell(row[key]));
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
  setTimeout(() => URL.revokeObjectURL(url), 100);

  notice(`Data berhasil diekspor ke ${filename}`, "success");
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
  try {
    await send("Q");
    notice("Acquisition stopped.", "warning");
  } catch (error) {
    notice(`Stop command failed: ${error.message}`, "error");
  } finally {
    resetProgress();
    processRunning = false;
    processPhase("READY");
    controls();
  }
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

  setTimeout(() => {
    if (!expandedChart) {
      expandedChart = makeChart($("expandedSensorChart"));
    }
    expandedChart.resize();
    expandedChart.update();
  }, 50);
});

$("closeChartModal").addEventListener("click", () => $("chartModal").classList.add("hidden"));
$("chartModal").addEventListener("click", event => {
  if (event.target === $("chartModal")) $("chartModal").classList.add("hidden");
});
$("aboutButton").addEventListener("click", () => $("aboutModal").classList.remove("hidden"));
$("aboutClose").addEventListener("click", () => $("aboutModal").classList.add("hidden"));
$("aboutModal").addEventListener("click", event => {
  if (event.target === $("aboutModal")) $("aboutModal").classList.add("hidden");
});

["injectionSeconds", "arrayCount"].forEach(id => $(id)?.addEventListener("input", settings));
$("sampleName")?.addEventListener("input", updateFileNamePreview);

window.addEventListener("DOMContentLoaded", () => {
  updateConnectionIndicator(false);
  startHeaderClock();
  chart = makeChart($("sensorChart"));
  legend();
  settings();
  updateFileNamePreview();
  controls();
  notice("Aplikasi siap. Silakan hubungkan perangkat serial.", "info");
  if (sessionStorage.getItem("malikiUnlocked") === "1") unlock();
  if (!("serial" in navigator)) notice("Web Serial is unavailable in this browser.", "warning");
});
