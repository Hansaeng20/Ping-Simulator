// --- Helpers ---------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);

const ipv4Regex =
  /^(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/;

function isIPv4(str) { return ipv4Regex.test(str); }

// Mulberry32 PRNG for deterministic pseudo-randoms
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function pad(n, w = 2) {
  return String(n).padStart(w, " ");
}

function fmtMs(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function randomIp(rng) {
  const a = Math.floor(rng() * 223) + 1; // 1..223
  const b = Math.floor(rng() * 255);
  const c = Math.floor(rng() * 255);
  const d = Math.floor(rng() * 254) + 1; // 1..254
  return `${a}.${b}.${c}.${d}`;
}

// --- Simulation core -------------------------------------------------------
/**
 * Build a pseudo path (hop list) between src and dst.
 * Returns array of hop IPs, last element = dst.
 */
function buildPath(src, dst, rng) {
  const hops = Math.floor(rng() * 7) + 5; // 5..11 hops
  const path = [];
  for (let i = 0; i < hops - 1; i++) path.push(randomIp(rng));
  path.push(dst);
  return path;
}

/**
 * Base latency influenced by hop count and src/dst bytes.
 */
function baseLatency(src, dst, hopCount, rng) {
  const [a1, b1, c1, d1] = src.split(".").map(Number);
  const [a2, b2, c2, d2] = dst.split(".").map(Number);
  const byteDist =
    Math.abs(a1 - a2) * 0.8 +
    Math.abs(b1 - b2) * 0.2 +
    Math.abs(c1 - c2) * 0.05 +
    Math.abs(d1 - d2) * 0.02;

  // 8..18 + hop cost + range based on address distance
  let base = 8 + hopCount * 1.8 + byteDist * 0.3;
  // environment noise
  base += rng() * 6;
  return base;
}

/**
 * Generate one RTT measurement with jitter and optional loss.
 */
function generateRtt(base, rng) {
  // 7% chance of packet loss
  const lost = rng() < 0.07;
  if (lost) return { lost: true };

  // jitter +-25%
  const jitter = (rng() - 0.5) * 0.5; // +/-25%
  let rtt = Math.max(0.3, base * (1 + jitter));
  // occasional spike
  if (rng() < 0.05) rtt *= 1.8;
  return { lost: false, rtt };
}

// --- UI wiring -------------------------------------------------------------
const form = $("#pingForm");
const consoleEl = $("#console");
const runBtn = $("#runBtn");
const clearBtn = $("#clearBtn");

clearBtn.addEventListener("click", () => (consoleEl.textContent = ""));

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const src = $("#srcIp").value.trim();
  const dst = $("#dstIp").value.trim();
  const count = Math.max(1, Math.min(20, parseInt($("#count").value || "4", 10)));
  const size = Math.max(8, Math.min(1500, parseInt($("#size").value || "56", 10)));
  const doTrace = $("#doTrace").checked;
  const stable = $("#stableSeed").checked;

  if (!isIPv4(src) || !isIPv4(dst)) {
    println(`error: please enter valid IPv4 addresses for Source and Destination.\n`);
    return;
  }

  runBtn.disabled = true;

  const seed = stable
    ? (hashString(src + "-" + dst) ^ 0x9E3779B9) >>> 0
    : ((hashString(src + "-" + dst) ^ Date.now()) >>> 0);
  const rng = mulberry32(seed);

  const path = buildPath(src, dst, rng);
  const hopCount = path.length;
  const ttlStart = 64; // typical on many systems
  const ttl = Math.max(1, ttlStart - hopCount);

  // Intro (Linux-like)
  println(`PING ${dst} (${dst}) ${size}(${size + 28}) bytes of data:\n`);

  if (doTrace) {
    await showTraceroute(src, dst, path, rng);
    println(""); // spacing
  }

  const rtts = [];
  let tx = 0, rx = 0;

  for (let seq = 1; seq <= count; seq++) {
    tx++;
    const base = baseLatency(src, dst, hopCount, rng);
    const { lost, rtt } = generateRtt(base, rng);

    if (lost) {
      println(`Request timeout for icmp_seq ${seq}`);
    } else {
      rx++;
      rtts.push(rtt);
      println(`${size} bytes from ${dst}: icmp_seq=${seq} ttl=${ttl} time=${fmtMs(rtt)} ms`);
    }

    // simulate 1-second interval-ish
    await delay(280 + Math.floor(rng() * 120));
  }

  // Stats
  const loss = ((tx - rx) / tx) * 100;
  const min = rtts.length ? Math.min(...rtts) : 0;
  const max = rtts.length ? Math.max(...rtts) : 0;
  const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
  const mdev = rtts.length
    ? Math.sqrt(rtts.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / rtts.length)
    : 0;

  println(`\n--- ${dst} ping statistics ---`);
  println(`${tx} packets transmitted, ${rx} received, ${loss.toFixed(0)}% packet loss`);
  if (rtts.length) {
    println(`rtt min/avg/max/mdev = ${fmtMs(min)}/${fmtMs(avg)}/${fmtMs(max)}/${fmtMs(mdev)} ms`);
  }

  println(""); // trailing newline
  runBtn.disabled = false;
});

function println(s = "") {
  consoleEl.textContent += s + "\n";
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

async function showTraceroute(src, dst, path, rng) {
  println(`traceroute to ${dst}, ${path.length} hops max`);
  for (let i = 0; i < path.length; i++) {
    const hopIp = path[i];
    let line = pad(i + 1, 2) + "  ";

    // Generate 3 probes per hop
    const rtts = [];
    for (let p = 0; p < 3; p++) {
      const base = 2 + i * 3 + rng() * 3;
      const { lost, rtt } = generateRtt(base, rng);
      if (lost && rng() < 0.6) {
        rtts.push("*");
      } else {
        rtts.push(fmtMs(rtt) + " ms");
      }
    }

    // If all lost, hide IP like real traceroute does sometimes
    if (rtts.every((x) => x === "*")) {
      line += "*  *  *";
    } else {
      line += `${hopIp}  ${rtts.map((x) => x.padStart(6, " ")).join("  ")}`;
    }

    println(line);
    await delay(120 + Math.floor(rng() * 100));
  }
}
