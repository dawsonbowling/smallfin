/* ─────────────────────────────────────────────────────────────
   SmallFin — app.js  v2.0
   Vanilla JS + Firebase (compat SDK via CDN)
───────────────────────────────────────────────────────────── */

const VERSION = "2.31";

// ─── Firebase init ─────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true })
  .catch(err => console.warn("Firestore persistence:", err.code));

// ─── State ─────────────────────────────────────────────────
let currentUser   = null;
let currentBankId = null;
let banks         = {};   // bankId → bank data
let settings      = { bankName: "My Bank", monthlyRate: 10, bankLogo: "🏦" };
let investors     = {};   // id → investor
let transactions  = {};   // investorId → [deposit txns]

const listeners = [];
let handlingSignup = false;

// ─── Invite link: capture ?join= from URL on load ───────────
(function () {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("join");
  if (code) {
    sessionStorage.setItem("sf_pending_invite", code);
    window.history.replaceState({}, "", window.location.pathname);
  }
})();

// ─── Firestore refs ─────────────────────────────────────────
const bankRef      = () => db.collection("banks").doc(currentBankId);
const investorsRef = () => db.collection("investors");
const txnsRef      = () => db.collection("transactions");

// ─── DOM helpers ───────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

function show(id)  { $(id)?.classList.remove("hidden"); }
function hide(id)  { $(id)?.classList.add("hidden"); }
function toggle(id, visible) { visible ? show(id) : hide(id); }

// ─── Toast ─────────────────────────────────────────────────
function toast(msg, type = "default") {
  const icons = { success: "✓", error: "✕", default: "ℹ" };
  const t = el("div", `toast ${type}`, `${icons[type] || "ℹ"} ${msg}`);
  $("toast-container").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ─── Formatters ────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2
  }).format(n ?? 0);
}

function fmtDate(ts) {
  if (!ts) return "—";
  return tsToDate(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function setInner(id, val) { const e = $(id); if (e) e.textContent = val; }

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── Timestamp normalizer ────────────────────────────────────
// Handles Firestore Timestamp, plain {seconds,nanoseconds} map,
// JS Date, or ISO string — all sources seen in real Firestore data.
function tsToDate(val) {
  if (!val) return new Date(0);
  if (typeof val.toDate === "function") return val.toDate();
  if (typeof val.seconds === "number")  return new Date(val.seconds * 1000);
  return new Date(val);
}

// ─── Per-investor rate helpers ───────────────────────────────
function getEffectiveRate(rateHistory, fallbackRate) {
  if (!rateHistory || rateHistory.length === 0) return fallbackRate;
  const now = new Date();
  const active = rateHistory
    .filter(r => tsToDate(r.effectiveDate) <= now)
    .sort((a, b) => tsToDate(b.effectiveDate) - tsToDate(a.effectiveDate))[0];
  return active !== undefined ? active.rate : fallbackRate;
}

function getRateForMonth(rateHistory, year, month, fallbackRate) {
  if (!rateHistory || rateHistory.length === 0) return fallbackRate;
  const monthStart = new Date(year, month, 1);
  const active = rateHistory
    .filter(r => tsToDate(r.effectiveDate) <= monthStart)
    .sort((a, b) => tsToDate(b.effectiveDate) - tsToDate(a.effectiveDate))[0];
  return active !== undefined ? active.rate : fallbackRate;
}

// ─── Interest computation ────────────────────────────────────
function computeInterestTransactions(txns, rateHistory, fallbackRate) {
  if (!txns || txns.length === 0) return [];
  const today = new Date();
  const currentYear  = today.getFullYear();
  const currentMonth = today.getMonth();

  const sorted = txns.slice().sort((a, b) => {
    const da  = tsToDate(a.date);
    const db_ = tsToDate(b.date);
    return da - db_;
  });

  const firstDate = tsToDate(sorted[0].date);
  let year  = firstDate.getFullYear();
  let month = firstDate.getMonth();

  const result = [];
  let runningBalance = 0;

  while (year < currentYear || (year === currentYear && month < currentMonth)) {
    const monthlyRate = getRateForMonth(rateHistory, year, month, fallbackRate);
    const rate = monthlyRate / 100;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const txnsThisMonth = sorted.filter(d => {
      const dd = tsToDate(d.date);
      return dd.getFullYear() === year && dd.getMonth() === month;
    });

    let interest = runningBalance * rate;
    txnsThisMonth.forEach(d => {
      const dd = tsToDate(d.date);
      const daysEarning = daysInMonth - dd.getDate() + 1;
      const sign = d.type === "withdrawal" ? -1 : 1;
      interest += sign * d.amount * (daysEarning / daysInMonth) * rate;
      runningBalance += sign * d.amount;
    });

    interest = parseFloat(interest.toFixed(2));
    if (interest > 0) {
      const monthLabel = new Date(year, month).toLocaleString("en-US", { month: "long", year: "numeric" });
      result.push({
        type:     "interest",
        amount:   interest,
        date:     new Date(year, month + 1, 1),
        note:     `Monthly interest @ ${monthlyRate}% — ${monthLabel}`,
        computed: true
      });
    }

    runningBalance += interest;
    month++;
    if (month > 11) { month = 0; year++; }
  }

  return result;
}

function calcBalance(investorId) {
  const txns      = transactions[investorId] || [];
  const inv       = investors[investorId] || {};
  const interest  = computeInterestTransactions(txns, inv.rateHistory, settings.monthlyRate);
  const deposited = txns.filter(t => t.type === "deposit").reduce((s, t) => s + t.amount, 0);
  const withdrawn = txns.filter(t => t.type === "withdrawal").reduce((s, t) => s + t.amount, 0);
  const earned    = interest.reduce((s, t) => s + t.amount, 0);
  return { deposited, withdrawn, interest: earned, balance: deposited - withdrawn + earned };
}

function txnsWithRunningBalance(investorId) {
  const txns            = transactions[investorId] || [];
  const inv             = investors[investorId] || {};
  const interestEntries = computeInterestTransactions(txns, inv.rateHistory, settings.monthlyRate);
  const all = [...txns, ...interestEntries].sort((a, b) => {
    return tsToDate(a.date) - tsToDate(b.date);
  });
  let running = 0;
  return all.map(t => {
    const sign = t.type === "withdrawal" ? -1 : 1;
    running += sign * t.amount;
    return { ...t, runningBalance: running };
  });
}

// ─── Auth ──────────────────────────────────────────────────
auth.onAuthStateChanged(async user => {
  if (user) {
    currentUser = user;
    if (!handlingSignup) {
      await showApp();
    }
  } else {
    hide("loading-screen");
    currentUser   = null;
    currentBankId = null;
    banks         = {};
    detachListeners();
    showLogin();
  }
});

function showLogin() {
  hide("app-shell");
  showLoginForm();
  show("view-login");
  const btn = $("btn-login");
  if (btn) { btn.disabled = false; btn.textContent = "Sign In"; }
}

async function showApp() {
  hide("view-login");
  await loadBanks();
  hide("loading-screen");
  show("app-shell");

  const inviteCode = sessionStorage.getItem("sf_pending_invite");
  if (inviteCode) {
    sessionStorage.removeItem("sf_pending_invite");
    await processInviteCode(inviteCode);
    return;
  }

  const returnBankId = sessionStorage.getItem("sf_return_bank");
  sessionStorage.removeItem("sf_return_bank");
  if (returnBankId) {
    enterBank(returnBankId);
  } else {
    navigateTo("banks");
  }
}

async function processInviteCode(code) {
  try {
    const snap = await db.collection("banks").where("inviteCode", "==", code).limit(1).get();
    if (snap.empty) {
      toast("This invite link is invalid or has expired.", "error");
      navigateTo("banks");
      return;
    }
    const bankDoc  = snap.docs[0];
    const bankData = bankDoc.data();

    if (bankData.ownerId === currentUser.uid) {
      banks[bankDoc.id] = { id: bankDoc.id, ...bankData };
      enterBank(bankDoc.id);
      toast(`Welcome back to ${bankData.bankName}!`, "default");
      return;
    }

    if ((bankData.memberIds || []).includes(currentUser.uid)) {
      banks[bankDoc.id] = { id: bankDoc.id, ...bankData };
      enterBank(bankDoc.id);
      toast(`Welcome back to ${bankData.bankName}!`, "default");
      return;
    }

    await bankDoc.ref.update({
      memberIds: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });
    banks[bankDoc.id] = {
      id: bankDoc.id, ...bankData,
      memberIds: [...(bankData.memberIds || []), currentUser.uid]
    };
    enterBank(bankDoc.id);
    toast(`You've joined ${bankData.bankName}!`, "success");
  } catch (e) {
    toast("Error joining bank: " + e.message, "error");
    navigateTo("banks");
  }
}

// ─── My Banks ──────────────────────────────────────────────
async function loadBanks() {
  try {
    const [ownedSnap, memberSnap] = await Promise.all([
      db.collection("banks").where("ownerId", "==", currentUser.uid).get(),
      db.collection("banks").where("memberIds", "array-contains", currentUser.uid).get()
    ]);
    banks = {};
    ownedSnap.forEach(doc => { banks[doc.id] = { id: doc.id, ...doc.data() }; });
    memberSnap.forEach(doc => { banks[doc.id] = { id: doc.id, ...doc.data() }; });
  } catch (err) {
    console.error("loadBanks:", err);
  }
}

function renderBanks() {
  const grid = $("banks-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const sorted = Object.values(banks).sort((a, b) => {
    const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : Infinity;
    const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : Infinity;
    return ta - tb;
  });

  if (sorted.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏦</div>
        <h3>No banks yet</h3>
        <p>Create your first bank to get started.</p>
      </div>`;
    return;
  }

  sorted.forEach(bank => {
    const card = el("div", "bank-card");
    const isOwner  = bank.ownerId === currentUser.uid;
    const isShared = (bank.memberIds || []).length > 0;
    card.innerHTML = `
      <div class="bank-card-logo"><img src="smallfin-pig.png" alt="SmallFin" style="width:100%;height:100%;object-fit:contain;padding:8px"></div>
      <div class="bank-card-name">${escHtml(bank.bankName)}${(!isOwner || isShared) ? ' <span class="bank-shared-badge">Shared</span>' : ''}</div>
      <button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="enterBank('${bank.id}')">Enter →</button>`;
    grid.appendChild(card);
  });
}

function enterBank(bankId) {
  currentBankId = bankId;
  settings = { bankName: "My Bank", monthlyRate: 10, bankLogo: "🏦", ...banks[bankId] };
  detachListeners();
  attachListeners();
  navigateTo("dashboard");
}

function exitBank() {
  detachListeners();
  currentBankId = null;
  settings      = { bankName: "My Bank", monthlyRate: 10, bankLogo: "🏦" };
  investors     = {};
  transactions  = {};
  navigateTo("banks");
}

// ─── Create Bank Modal ─────────────────────────────────────
function openCreateBankModal() {
  $("new-bank-name").value = "";
  renderEmojiPicker("create-bank-logo-picker", BANK_LOGOS, "🏦", "new-bank-logo");
  show("modal-create-bank");
  setTimeout(() => $("new-bank-name").focus(), 50);
}

function closeCreateBankModal() {
  hide("modal-create-bank");
}

async function submitCreateBank() {
  const name = $("new-bank-name").value.trim();
  if (!name) { toast("Please enter a bank name.", "error"); return; }
  const logo = $("new-bank-logo").value || "🏦";
  const btn  = $("btn-create-bank-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Creating…`;
  try {
    const ref = db.collection("banks").doc();
    const inviteCode = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    await ref.set({
      bankName:    name,
      bankLogo:    logo,
      monthlyRate: 10,
      ownerId:     currentUser.uid,
      inviteCode,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
    banks[ref.id] = { id: ref.id, bankName: name, bankLogo: logo, monthlyRate: 10, ownerId: currentUser.uid, inviteCode };
    closeCreateBankModal();
    toast(`${name} created!`, "success");
    renderBanks();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Bank";
  }
}

// ─── Firestore listeners ────────────────────────────────────
function detachListeners() {
  listeners.forEach(unsub => unsub());
  listeners.length = 0;
  investors    = {};
  transactions = {};
}

function attachListeners() {
  // Bank settings
  const unsubSettings = bankRef()
    .onSnapshot(snap => {
      if (snap.exists) {
        settings = { bankName: "My Bank", monthlyRate: 10, bankLogo: "🏦", ...snap.data() };
        banks[currentBankId] = { id: currentBankId, ...snap.data() };
      }
      renderAll();
    }, err => console.error("settings listener:", err));
  listeners.push(unsubSettings);

  // Investors — filtered by bankId, sorted client-side
  const unsubInvestors = investorsRef()
    .where("bankId", "==", currentBankId)
    .onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type === "removed") {
          delete investors[change.doc.id];
          delete transactions[change.doc.id];
        } else {
          investors[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
        }
      });
      renderAll();
    }, err => console.error("investors listener:", err));
  listeners.push(unsubInvestors);

  // Transactions — filtered by bankId
  const unsubTxns = txnsRef()
    .where("bankId", "==", currentBankId)
    .onSnapshot(snap => {
      transactions = {};
      snap.forEach(doc => {
        const t = { id: doc.id, ...doc.data() };
        if (t.type !== "deposit" && t.type !== "withdrawal") return;
        if (!transactions[t.investorId]) transactions[t.investorId] = [];
        transactions[t.investorId].push(t);
      });
      renderAll();
    }, err => console.error("transactions listener:", err));
  listeners.push(unsubTxns);
}

// ─── Routing ───────────────────────────────────────────────
let currentView = "banks";

function navigateTo(view) {
  currentView = view;
  const inBank = view === "dashboard" || view === "settings";

  toggle("view-banks",     view === "banks");
  toggle("view-dashboard", view === "dashboard");
  toggle("view-settings",  view === "settings");

  toggle("nav-btn-mybanks",   inBank);
  toggle("nav-btn-dashboard", inBank);
  toggle("nav-btn-settings",  inBank);

  $("nav-btn-dashboard")?.classList.toggle("active", view === "dashboard");
  $("nav-btn-settings")?.classList.toggle("active",  view === "settings");

  renderAll();
}

function handleNavBrandClick() {
  if (currentView === "dashboard" || currentView === "settings") {
    navigateTo("dashboard");
  }
}

// ─── Render ────────────────────────────────────────────────
function renderAll() {
  if (currentView === "banks")     renderBanks();
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "settings")  renderSettings();
  renderNavBrand();
}

function renderNavBrand() {
  const nameEl = $("nav-bank-name");
  const iconEl = $("nav-brand-icon");
  const verEl  = $("nav-version");

  const textEl    = $("nav-brand-text");
  const subtitleEl = $("nav-by-smallfin");
  if (nameEl)     nameEl.textContent = currentBankId ? settings.bankName : "SmallFin";
  if (textEl)     show("nav-brand-text");
  if (subtitleEl) toggle("nav-by-smallfin", !!currentBankId);
  if (iconEl) {
    iconEl.innerHTML = `<img src="logo-notxt.png" alt="SmallFin" style="height:44px;width:auto;display:block">`;
    iconEl.classList.add("nav-brand-icon--logo");
  }
  if (verEl)  verEl.textContent  = `v${VERSION}`;
  syncMobileMenu();
}

// ─── Mobile Menu ───────────────────────────────────────────
function toggleMobileMenu() {
  const menu = $("mobile-menu");
  const btn  = $("hamburger-btn");
  if (!menu) return;
  const isOpen = !menu.classList.contains("hidden");
  if (isOpen) {
    closeMobileMenu();
  } else {
    syncMobileMenu();
    menu.classList.remove("hidden");
    btn && btn.classList.add("active");
  }
}

function closeMobileMenu() {
  const menu = $("mobile-menu");
  const btn  = $("hamburger-btn");
  menu && menu.classList.add("hidden");
  btn  && btn.classList.remove("active");
}

function syncMobileMenu() {
  const inBank = !!currentBankId;
  const myBanksEl  = $("mmenu-mybanks");
  const settingsEl = $("mmenu-settings");
  const dividerEl  = $("mmenu-bank-divider");
  if (myBanksEl)  myBanksEl.classList.toggle("hidden",  !inBank);
  if (settingsEl) settingsEl.classList.toggle("hidden", !inBank);
  if (dividerEl)  dividerEl.classList.toggle("hidden",  !inBank);
}

// ─── EOY Forecast ──────────────────────────────────────────
const forecastSaveTimers = {};
let forecastChart = null;

function defaultForecastMonths() { return 12 - new Date().getMonth(); }

function calcEOYForecast(investorId, monthlyDeposit, months) {
  const { balance } = calcBalance(investorId);
  const inv = investors[investorId] || {};
  const m = parseInt(months) || defaultForecastMonths();
  const deposit = parseFloat(monthlyDeposit) || 0;
  let proj = balance;
  const now = new Date();
  for (let i = 0; i < m; i++) {
    const totalMonths = now.getMonth() + i;
    const yr = now.getFullYear() + Math.floor(totalMonths / 12);
    const mo = totalMonths % 12;
    const rate = getRateForMonth(inv.rateHistory, yr, mo, settings.monthlyRate) / 100;
    proj += deposit;
    proj *= (1 + rate);
  }
  return proj;
}

// Returns [{label, withDeposit, withoutDeposit}] for chart rendering
function calcForecastMonthByMonth(investorId, monthlyDeposit, months) {
  const { balance } = calcBalance(investorId);
  const inv = investors[investorId] || {};
  const m = parseInt(months) || defaultForecastMonths();
  const deposit = parseFloat(monthlyDeposit) || 0;
  const now = new Date();
  const points = [];
  let withDep = balance;
  let withoutDep = balance;
  for (let i = 0; i < m; i++) {
    const totalMonths = now.getMonth() + i;
    const yr = now.getFullYear() + Math.floor(totalMonths / 12);
    const mo = totalMonths % 12;
    const rate = getRateForMonth(inv.rateHistory, yr, mo, settings.monthlyRate) / 100;
    withDep += deposit;
    withDep *= (1 + rate);
    withoutDep *= (1 + rate);
    const label = new Date(yr, mo).toLocaleDateString("en-US", { month: "short", year: "numeric" });
    points.push({ label, withDeposit: withDep, withoutDeposit: withoutDep });
  }
  return points;
}

async function saveForecastSettings(investorId) {
  const inv = investors[investorId];
  if (!inv) return;
  try {
    await investorsRef().doc(investorId).update({
      forecastMonthly: inv.forecastMonthly ?? 0,
      forecastMonths:  inv.forecastMonths  ?? defaultForecastMonths()
    });
  } catch (e) { console.warn("Forecast save failed", e); }
}

function updateForecast(investorId, field, value) {
  const inv = investors[investorId];
  if (!inv) return;
  if (field === "monthly") inv.forecastMonthly = parseFloat(value) || 0;
  if (field === "months")  inv.forecastMonths  = parseInt(value)   || defaultForecastMonths();
  const el_ = $(`forecast-${investorId}`);
  if (el_) el_.textContent = fmt(calcEOYForecast(investorId, inv.forecastMonthly, inv.forecastMonths));
  clearTimeout(forecastSaveTimers[investorId]);
  forecastSaveTimers[investorId] = setTimeout(() => saveForecastSettings(investorId), 800);
}

// ─── Forecast Panel Modal ───────────────────────────────────
let forecastPanelId = null;

function openForecastPanel(investorId) {
  forecastPanelId = investorId;
  const inv = investors[investorId] || {};
  $("forecast-modal-name").textContent = inv.name || "";
  $("forecast-panel-monthly").value = inv.forecastMonthly || "";
  $("forecast-panel-months").value  = inv.forecastMonths  ?? defaultForecastMonths();
  const statCheck  = $("fp-check-summary");
  const chartCheck = $("fp-check-chart");
  if (statCheck)  statCheck.checked  = inv.forecastStatOnStmt  ?? true;
  if (chartCheck) chartCheck.checked = inv.forecastChartOnStmt ?? true;
  updateForecastPanel();
  show("modal-forecast");
}

function closeForecastPanel() {
  hide("modal-forecast");
  if (forecastChart) { forecastChart.destroy(); forecastChart = null; }
  forecastPanelId = null;
}

function updateForecastPanel() {
  if (!forecastPanelId) return;
  const monthly = parseFloat($("forecast-panel-monthly").value) || 0;
  const months  = parseInt($("forecast-panel-months").value)    || defaultForecastMonths();
  const { balance } = calcBalance(forecastPanelId);
  const projected      = calcEOYForecast(forecastPanelId, monthly, months);
  const periodDeposited = monthly * months;
  const periodInterest  = projected - balance - periodDeposited;

  const titleEl = $("forecast-period-title");
  if (titleEl) titleEl.textContent = `In ${months} month${months !== 1 ? "s" : ""}…`;
  const depEl = $("fp-total-deposited");
  const intEl = $("fp-total-interest");
  const balEl = $("fp-projected-balance");
  if (depEl) depEl.textContent = fmt(periodDeposited);
  if (intEl) intEl.textContent = fmt(periodInterest);
  if (balEl) balEl.textContent = fmt(projected);

  // Build chart
  const points   = calcForecastMonthByMonth(forecastPanelId, monthly, months);
  const labels   = points.map(p => p.label);
  const withDep  = points.map(p => p.withDeposit);
  const noDep    = points.map(p => p.withoutDeposit);
  const sparse   = points.length > 24;
  const datasets = monthly > 0
    ? [
        { label: "With deposits",    data: withDep, borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.08)",  tension: 0.3, fill: true,  pointRadius: sparse ? 0 : 3 },
        { label: "Without deposits", data: noDep,   borderColor: "#1e3260", backgroundColor: "rgba(30,50,96,0.04)",   tension: 0.3, fill: false, pointRadius: sparse ? 0 : 3, borderDash: [4,3] }
      ]
    : [
        { label: "Projected balance", data: withDep, borderColor: "#1e3260", backgroundColor: "rgba(30,50,96,0.08)", tension: 0.3, fill: true, pointRadius: sparse ? 0 : 3 }
      ];

  const canvas = $("forecast-chart");
  if (!canvas) return;
  if (forecastChart) { forecastChart.destroy(); forecastChart = null; }
  forecastChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: monthly > 0, labels: { font: { size: 11 }, boxWidth: 20 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 12 } },
        y: { ticks: { font: { size: 10 }, callback: v => "$" + (v >= 1000 ? (v/1000).toFixed(1)+"k" : v.toFixed(0)) } }
      }
    }
  });
}

async function saveForecastPanel() {
  if (!forecastPanelId) return;
  const inv = investors[forecastPanelId];
  if (!inv) return;
  const monthly       = parseFloat($("forecast-panel-monthly").value) || 0;
  const months        = parseInt($("forecast-panel-months").value)    || defaultForecastMonths();
  const statOnStmt    = $("fp-check-summary")?.checked ?? true;
  const chartOnStmt   = $("fp-check-chart")?.checked   ?? true;
  inv.forecastMonthly     = monthly;
  inv.forecastMonths      = months;
  inv.forecastStatOnStmt  = statOnStmt;
  inv.forecastChartOnStmt = chartOnStmt;
  const btn = $("btn-forecast-save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await investorsRef().doc(forecastPanelId).update({
      forecastMonthly:     monthly,
      forecastMonths:      months,
      forecastStatOnStmt:  statOnStmt,
      forecastChartOnStmt: chartOnStmt
    });
    toast("Forecast saved!", "success");
    closeForecastPanel();
    renderDashboard();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

// ─── Rename Investor ───────────────────────────────────────
let renameInvestorId = null;

function openRenameModal(investorId) {
  renameInvestorId = investorId;
  const inv = investors[investorId] || {};
  $("rename-investor-input").value = inv.name || "";
  show("modal-rename");
  setTimeout(() => $("rename-investor-input").select(), 50);
}

function closeRenameModal() {
  hide("modal-rename");
  renameInvestorId = null;
}

async function submitRename() {
  if (!renameInvestorId) return;
  const name = $("rename-investor-input").value.trim();
  if (!name) return;
  const btn = $("btn-rename-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await investorsRef().doc(renameInvestorId).update({ name });
    investors[renameInvestorId].name = name;
    toast("Name updated!", "success");
    closeRenameModal();
    renderDashboard();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

function renderDashboard() {
  let totalDeposited = 0, totalInterest = 0;
  Object.keys(investors).forEach(id => {
    const b = calcBalance(id);
    totalDeposited += b.deposited;
    totalInterest  += b.interest;
  });
  setInner("stat-total-deposited", fmt(totalDeposited));
  setInner("stat-total-interest",  fmt(totalInterest));
  setInner("stat-total-balance",   fmt(totalDeposited + totalInterest));
  setInner("stat-investor-count",  Object.keys(investors).length);

  const grid = $("investor-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const ids = Object.keys(investors).sort((a, b) => {
    const ta = investors[a].createdAt?.toMillis ? investors[a].createdAt.toMillis() : 0;
    const tb = investors[b].createdAt?.toMillis ? investors[b].createdAt.toMillis() : 0;
    return ta - tb;
  });

  if (ids.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏦</div>
        <h3>No investors yet</h3>
        <p>Add your first kid to get started.</p>
      </div>`;
    return;
  }

  ids.forEach(id => {
    const inv = investors[id];
    const { deposited, interest, balance } = calcBalance(id);
    const currentRate = getEffectiveRate(inv.rateHistory, settings.monthlyRate);
    const avatar  = inv.emoji || inv.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const fMonthly = inv.forecastMonthly ?? 0;
    const fMonths  = inv.forecastMonths  ?? defaultForecastMonths();
    const forecast = calcEOYForecast(id, fMonthly, fMonths);
    const fSummary = `If I invest <strong>${fmt(fMonthly)}/mo</strong>, in <strong>${fMonths} months</strong> I'll have <strong>${fmt(forecast)}</strong>`;
    const card = el("div", "icard");
    card.innerHTML = `
      <div class="icard-header">
        <div class="icard-identity">
          <div class="investor-avatar" onclick="openAvatarModal('${id}')">${avatar}</div>
          <span class="investor-name icard-name-btn" onclick="openRenameModal('${id}')">${escHtml(inv.name)}</span>
        </div>
        <button class="rate-pill-btn" onclick="openRateModal('${id}')" title="Change interest rate">📈 ${currentRate}% / mo</button>
      </div>
      <div class="icard-divider"></div>
      <div class="icard-stats">
        <div class="icard-stat">
          <div class="s-label">Deposited</div>
          <div class="s-value">${fmt(deposited)}</div>
        </div>
        <div class="icard-stat interest">
          <div class="s-label">Interest</div>
          <div class="s-value">${fmt(interest)}</div>
        </div>
        <div class="icard-stat balance">
          <div class="s-label">Balance</div>
          <div class="s-value">${fmt(balance)}</div>
        </div>
      </div>
      <div class="icard-divider"></div>
      <div class="icard-actions">
        <div class="icard-txn-wrap">
          <button class="icard-txn-btn" onclick="toggleTxnMenu('${id}')">+ Transaction <span>▾</span></button>
          <div class="icard-txn-menu hidden" id="txn-menu-${id}">
            <button onclick="openDepositModal('${id}','deposit');closeTxnMenu('${id}')">Deposit</button>
            <button onclick="openDepositModal('${id}','withdrawal');closeTxnMenu('${id}')">Withdrawal</button>
          </div>
        </div>
        <button class="btn-icon" onclick="openTxnModal('${id}')" title="Transaction history">📋</button>
        <button class="btn-icon" onclick="printInvestor('${id}')" title="Statement">🖨️</button>
      </div>
      <div class="icard-divider"></div>
      <div class="icard-forecast">
        <span class="forecast-summary-text">${fSummary}</span>
        <button class="btn-icon forecast-panel-btn" onclick="openForecastPanel('${id}')" title="Edit forecast">📊</button>
      </div>`;
    grid.appendChild(card);
  });
}

function renderSettings() {
  const nameEl = $("setting-bank-name");
  if (nameEl) nameEl.value = settings.bankName;
  renderInviteSection();
  renderSettingsInvestorList();
}

function renderSettingsInvestorList() {
  const listEl = $("settings-investor-list");
  if (!listEl) return;
  const ids = Object.keys(investors).sort((a, b) => {
    const ta = investors[a].createdAt?.toMillis ? investors[a].createdAt.toMillis() : 0;
    const tb = investors[b].createdAt?.toMillis ? investors[b].createdAt.toMillis() : 0;
    return ta - tb;
  });
  if (ids.length === 0) {
    listEl.innerHTML = `<p style="color:var(--muted);font-size:0.88rem">No investors yet.</p>`;
    return;
  }
  listEl.innerHTML = ids.map(id => {
    const inv = investors[id];
    const avatar = inv.emoji || inv.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    return `
      <div class="settings-investor-row">
        <div class="settings-investor-identity">
          <span class="settings-investor-avatar">${escHtml(avatar)}</span>
          <span class="settings-investor-name">${escHtml(inv.name)}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="openDeleteInvestorModal('${id}')">Delete</button>
      </div>`;
  }).join("");
}

async function renderInviteSection() {
  let code = settings.inviteCode;
  if (!code) {
    code = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    try {
      await bankRef().update({ inviteCode: code });
      settings.inviteCode = code;
      if (banks[currentBankId]) banks[currentBankId].inviteCode = code;
    } catch (e) {
      console.error("Failed to generate invite code:", e);
      return;
    }
  }
  const link    = `${window.location.origin}${window.location.pathname}?join=${code}`;
  const display = $("invite-link-display");
  if (display) display.textContent = link;
}

function copyInviteLink() {
  const link = $("invite-link-display")?.textContent;
  if (!link || link === "—") return;
  navigator.clipboard.writeText(link)
    .then(() => toast("Invite link copied!", "success"))
    .catch(() => toast("Couldn't copy — please copy it manually.", "error"));
}

// ─── Emoji pickers ──────────────────────────────────────────
const INVESTOR_EMOJIS = ["😀","🦁","🐯","🦊","🐻","🐼","🦄","🐸","🦋","🚀","⭐","🏆","🎯","🌟","🔥","💎","🎸","⚽","🎨","🦅"];
const BANK_LOGOS      = ["🏦","🐟","🐠","🐡","🦈","💰","💵","💎","🌊","⭐","🚀","🏆","🔑","🛡️"];

function renderEmojiPicker(pickerId, emojis, selected, hiddenId) {
  const picker = $(pickerId);
  if (!picker) return;
  picker.innerHTML = emojis.map(e =>
    `<button type="button" class="emoji-btn${e === selected ? " selected" : ""}" data-emoji="${e}">${e}</button>`
  ).join("");
  if (hiddenId) $(hiddenId).value = selected;
  picker.onclick = ev => {
    const btn = ev.target.closest(".emoji-btn");
    if (!btn) return;
    if (hiddenId) $(hiddenId).value = btn.dataset.emoji;
    picker.querySelectorAll(".emoji-btn").forEach(b => b.classList.toggle("selected", b === btn));
  };
}

// ─── Add Investor Modal ─────────────────────────────────────
function openAddInvestorModal() {
  $("modal-add-investor").classList.remove("hidden");
  $("new-investor-name").value = "";
  const defaultEmoji = INVESTOR_EMOJIS[Math.floor(Math.random() * INVESTOR_EMOJIS.length)];
  renderEmojiPicker("investor-emoji-picker", INVESTOR_EMOJIS, defaultEmoji, "new-investor-emoji");
  setTimeout(() => $("new-investor-name").focus(), 50);
}

function closeAddInvestorModal() { hide("modal-add-investor"); }

async function submitAddInvestor() {
  const name = $("new-investor-name").value.trim();
  if (!name) { toast("Please enter a name.", "error"); return; }
  const btn = $("btn-add-investor-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Adding…`;
  try {
    await investorsRef().add({
      bankId:    currentBankId,
      name,
      emoji:     $("new-investor-emoji").value || "😀",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    closeAddInvestorModal();
    toast(`${name} added!`, "success");
  } catch (e) {
    toast("Error adding investor: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Investor";
  }
}

// ─── Deposit Modal ──────────────────────────────────────────
let depositTargetId = null;
let depositType     = "deposit";

function setTxnType(type) {
  depositType = type;
  document.querySelectorAll(".txn-type-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.type === type)
  );
  $("btn-deposit-submit").textContent = type === "deposit" ? "Log Deposit" : "Log Withdrawal";
}

function openDepositModal(investorId, type = "deposit") {
  depositTargetId = investorId;
  const inv = investors[investorId];
  $("deposit-investor-name").textContent = inv?.name || "Investor";
  $("deposit-amount").value = "";
  $("deposit-note").value   = "";
  populateDatePicker("deposit-date", todayInputValue());
  setTxnType(type);
  show("modal-deposit");
  setTimeout(() => $("deposit-amount").focus(), 50);
}

function toggleTxnMenu(investorId) {
  const menu = $(`txn-menu-${investorId}`);
  if (!menu) return;
  const isOpen = !menu.classList.contains("hidden");
  document.querySelectorAll(".icard-txn-menu").forEach(m => m.classList.add("hidden"));
  if (!isOpen) {
    const btn = menu.previousElementSibling;
    const rect = btn.getBoundingClientRect();
    menu.style.top   = (rect.bottom + 4) + "px";
    menu.style.left  = rect.left + "px";
    menu.style.width = rect.width + "px";
    menu.classList.remove("hidden");
  }
}

function closeTxnMenu(investorId) {
  $(`txn-menu-${investorId}`)?.classList.add("hidden");
}

document.addEventListener("click", e => {
  if (!e.target.closest(".icard-txn-wrap")) {
    document.querySelectorAll(".icard-txn-menu").forEach(m => m.classList.add("hidden"));
  }
});

window.addEventListener("scroll", () => {
  document.querySelectorAll(".icard-txn-menu").forEach(m => m.classList.add("hidden"));
}, { passive: true });

function closeDepositModal() {
  hide("modal-deposit");
  depositTargetId = null;
}

async function submitDeposit() {
  const amountRaw = parseFloat($("deposit-amount").value);
  if (!amountRaw || amountRaw <= 0) { toast("Enter a valid amount.", "error"); return; }
  const note    = $("deposit-note").value.trim();
  const dateVal = getDatePickerValue("deposit-date");
  const dateObj = new Date(dateVal + "T12:00:00");

  const btn = $("btn-deposit-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await txnsRef().add({
      bankId:     currentBankId,
      investorId: depositTargetId,
      type:       depositType,
      amount:     amountRaw,
      date:       firebase.firestore.Timestamp.fromDate(dateObj),
      note:       note || "",
      addedBy:    currentUser.uid
    });
    closeDepositModal();
    toast(`${depositType === "deposit" ? "Deposit" : "Withdrawal"} of ${fmt(amountRaw)} logged!`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log Deposit";
  }
}

// ─── Transaction History Modal ──────────────────────────────
function openTxnModal(investorId) {
  const inv  = investors[investorId];
  const txns = txnsWithRunningBalance(investorId);
  const { deposited, interest, balance } = calcBalance(investorId);

  // Merge rate-change events from rateHistory for display only
  const rateEvents = (inv.rateHistory || []).map(r => {
    const d = tsToDate(r.effectiveDate);
    return { type: "rate-change", rate: r.rate, date: r.effectiveDate, dateIso: d.toISOString().slice(0, 10), computed: true };
  });
  const all = [...txns, ...rateEvents].sort((a, b) => {
    return tsToDate(a.date) - tsToDate(b.date);
  });

  $("txn-modal-title").textContent = `${inv?.name}'s Transactions`;

  const list = $("txn-modal-list");
  list.innerHTML = "";

  if (all.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted)">No transactions yet.</div>`;
  } else {
    [...all].reverse().forEach(t => {
      const item = el("div", "txn-item");
      if (t.type === "rate-change") {
        item.innerHTML = `
          <div class="txn-icon rate-change">%</div>
          <div class="txn-details">
            <div class="txn-desc">Rate changed to ${t.rate}% / mo</div>
            <div class="txn-date">${fmtDate(t.date)}</div>
          </div>
          <button class="btn-icon" onclick="deleteRateChange('${investorId}','${t.dateIso}')" title="Delete" style="color:#ef4444">🗑</button>`;
      } else {
        const icon = t.type === "deposit" ? "↓" : t.type === "withdrawal" ? "↑" : "★";
        const amtPrefix = t.type === "withdrawal" ? "−" : "+";
        const desc = t.note || (t.type === "deposit" ? "Deposit" : t.type === "withdrawal" ? "Withdrawal" : "Interest");
        item.innerHTML = `
          <div class="txn-icon ${t.type}">${icon}</div>
          <div class="txn-details">
            <div class="txn-desc">${desc}</div>
            <div class="txn-date">${fmtDate(t.date)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <div>
              <div class="txn-amount ${t.type}">${amtPrefix}${fmt(t.amount)}</div>
              <div class="txn-balance">Bal: ${fmt(t.runningBalance)}</div>
            </div>
            ${!t.computed ? `<button class="btn-icon" onclick="deleteDepositTransaction('${t.id}','${investorId}')" title="Delete" style="color:#ef4444">🗑</button>` : ""}
          </div>`;
      }
      list.appendChild(item);
    });
  }

  $("txn-modal-summary").innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 16px;background:var(--bg);border-radius:10px;font-size:0.88rem">
      <span><strong>Deposited:</strong> ${fmt(deposited)}</span>
      <span><strong>Interest:</strong> ${fmt(interest)}</span>
      <span style="color:var(--green)"><strong>Balance:</strong> ${fmt(balance)}</span>
    </div>`;

  show("modal-txn");
}

function closeTxnModal() { hide("modal-txn"); }

async function deleteDepositTransaction(txnId, investorId) {
  if (!confirm("Delete this transaction? Interest will recalculate automatically.")) return;
  try {
    await txnsRef().doc(txnId).delete();
    closeTxnModal();
    toast("Deposit deleted.", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

// ─── Avatar Picker Modal ────────────────────────────────────
function openAvatarModal(investorId) {
  const inv = investors[investorId];
  $("avatar-modal-name").textContent = inv?.name || "";
  const picker = $("avatar-picker");
  picker.innerHTML = INVESTOR_EMOJIS.map(e =>
    `<button type="button" class="emoji-btn${e === (inv?.emoji || "") ? " selected" : ""}" data-emoji="${e}">${e}</button>`
  ).join("");
  picker.onclick = async ev => {
    const btn = ev.target.closest(".emoji-btn");
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    picker.querySelectorAll(".emoji-btn").forEach(b => b.classList.toggle("selected", b === btn));
    try {
      await investorsRef().doc(investorId).update({ emoji });
      closeAvatarModal();
      toast("Avatar updated!", "success");
    } catch (e) {
      toast("Error: " + e.message, "error");
    }
  };
  show("modal-avatar");
}

function closeAvatarModal() { hide("modal-avatar"); }

// ─── Rate Modal ─────────────────────────────────────────────
let rateTargetId = null;

function openRateModal(investorId) {
  rateTargetId = investorId;
  const inv = investors[investorId];
  $("rate-modal-name").textContent = inv?.name || "";
  $("rate-amount").value = getEffectiveRate(inv?.rateHistory, settings.monthlyRate);
  populateDatePicker("rate-date", todayInputValue());
  renderRateHistory(investorId);
  show("modal-rate");
  setTimeout(() => $("rate-amount").focus(), 50);
}

function closeRateModal() { hide("modal-rate"); rateTargetId = null; }

function renderRateHistory(investorId) {
  const inv = investors[investorId] || {};
  const history = (inv.rateHistory || []).slice().sort((a, b) => {
    return tsToDate(b.effectiveDate) - tsToDate(a.effectiveDate);
  });
  const el_ = $("rate-history-list");
  if (!history.length) {
    el_.innerHTML = `<p style="font-size:0.85rem;color:var(--muted);margin-top:8px">No custom rate set — using bank default (${settings.monthlyRate}% / mo).</p>`;
    return;
  }
  el_.innerHTML = `
    <div style="margin-top:12px">
      <div style="font-size:0.75rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Rate History</div>
      ${history.map((r, i) => {
        const d = tsToDate(r.effectiveDate);
        return `<div class="rate-history-item">
          <span class="rate-history-date">${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
          <span class="rate-history-rate">${r.rate}% / mo</span>
          <button class="btn-icon" onclick="deleteRateEntry(${i})" title="Remove" style="color:#ef4444;font-size:0.85rem">🗑</button>
        </div>`;
      }).join("")}
    </div>`;
}

async function submitRateChange() {
  const rateRaw = parseFloat($("rate-amount").value);
  const dateVal = getDatePickerValue("rate-date");
  if (isNaN(rateRaw) || rateRaw < 0 || rateRaw > 100) {
    toast("Rate must be between 0 and 100.", "error"); return;
  }
  if (!dateVal) { toast("Please select an effective date.", "error"); return; }

  const effectiveDate = firebase.firestore.Timestamp.fromDate(new Date(dateVal + "T00:00:00"));
  const btn = $("btn-rate-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    const inv = investors[rateTargetId] || {};
    const existing = inv.rateHistory || [];
    const filtered = existing.filter(r => {
      return tsToDate(r.effectiveDate).toISOString().slice(0, 10) !== dateVal;
    });
    const updated = [...filtered, { rate: rateRaw, effectiveDate }];
    await investorsRef().doc(rateTargetId).update({ rateHistory: updated });
    investors[rateTargetId] = { ...inv, rateHistory: updated };
    toast("Rate updated!", "success");
    closeRateModal();
    renderAll();
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Set Rate";
  }
}

async function deleteRateEntry(index) {
  if (!confirm("Remove this rate entry?")) return;
  const inv = investors[rateTargetId] || {};
  const sorted = (inv.rateHistory || []).slice().sort((a, b) => {
    return tsToDate(b.effectiveDate) - tsToDate(a.effectiveDate);
  });
  sorted.splice(index, 1);
  try {
    await investorsRef().doc(rateTargetId).update({ rateHistory: sorted });
    investors[rateTargetId] = { ...inv, rateHistory: sorted };
    renderRateHistory(rateTargetId);
    renderAll();
    toast("Rate entry removed.", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

async function deleteRateChange(investorId, dateIso) {
  if (!confirm("Remove this rate change? Interest will recalculate automatically.")) return;
  const inv = investors[investorId] || {};
  const updated = (inv.rateHistory || []).filter(r => {
    return tsToDate(r.effectiveDate).toISOString().slice(0, 10) !== dateIso;
  });
  try {
    await investorsRef().doc(investorId).update({ rateHistory: updated });
    investors[investorId] = { ...inv, rateHistory: updated };
    closeTxnModal();
    renderAll();
    toast("Rate change removed.", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

// ─── Delete Investor ────────────────────────────────────────
let deleteInvestorId = null;

function openDeleteInvestorModal(investorId) {
  deleteInvestorId = investorId;
  const inv = investors[investorId] || {};
  $("delete-investor-name-display").textContent = inv.name || "";
  $("delete-investor-confirm-input").value = "";
  $("delete-investor-confirm-input").placeholder = inv.name || "";
  $("btn-delete-investor-confirm").disabled = true;
  show("modal-delete-investor");
  setTimeout(() => $("delete-investor-confirm-input").focus(), 50);
}

function closeDeleteInvestorModal() {
  hide("modal-delete-investor");
  deleteInvestorId = null;
}

function onDeleteInvestorInput() {
  const inv = investors[deleteInvestorId] || {};
  $("btn-delete-investor-confirm").disabled =
    $("delete-investor-confirm-input").value !== inv.name;
}

async function submitDeleteInvestor() {
  if (!deleteInvestorId) return;
  const inv = investors[deleteInvestorId];
  const btn = $("btn-delete-investor-confirm");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Deleting…`;
  try {
    const snap = await txnsRef()
      .where("bankId",     "==", currentBankId)
      .where("investorId", "==", deleteInvestorId)
      .get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    batch.delete(investorsRef().doc(deleteInvestorId));
    await batch.commit();
    toast(`${inv?.name} removed.`, "success");
    closeDeleteInvestorModal();
  } catch (e) {
    toast("Error: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = "Delete";
  }
}

// ─── Settings ──────────────────────────────────────────────
async function saveSettings() {
  const bankName = $("setting-bank-name").value.trim();

  if (!bankName) { toast("Bank name can't be empty.", "error"); return; }

  const logo = $("setting-bank-logo").value || "🏦";
  const btn  = $("btn-save-settings");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await bankRef().set({
      bankName,
      bankLogo:  logo,
      ownerId:   currentUser.uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    banks[currentBankId] = { ...banks[currentBankId], bankName, bankLogo: logo };
    toast("Settings saved!", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─── Delete Bank ───────────────────────────────────────────
function confirmDeleteBank() {
  if ((settings.memberIds || []).length > 0) {
    toast("Shared banks can't be deleted while members have access.", "error");
    return;
  }
  $("delete-bank-name-display").textContent = settings.bankName;
  $("delete-bank-confirm-input").value = "";
  $("delete-bank-confirm-input").placeholder = settings.bankName;
  $("btn-delete-bank-confirm").disabled = true;
  show("modal-delete-bank");
  setTimeout(() => $("delete-bank-confirm-input").focus(), 50);
}

function closeDeleteBankModal() {
  hide("modal-delete-bank");
}

function onDeleteBankInput() {
  $("btn-delete-bank-confirm").disabled =
    $("delete-bank-confirm-input").value !== settings.bankName;
}

async function submitDeleteBank() {
  const btn = $("btn-delete-bank-confirm");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Deleting…`;
  try {
    const [invSnap, txnSnap] = await Promise.all([
      investorsRef().where("bankId", "==", currentBankId).get(),
      txnsRef().where("bankId", "==", currentBankId).get()
    ]);
    const batch = db.batch();
    invSnap.forEach(doc => batch.delete(doc.ref));
    txnSnap.forEach(doc => batch.delete(doc.ref));
    batch.delete(bankRef());
    await batch.commit();
    delete banks[currentBankId];
    closeDeleteBankModal();
    exitBank();
    toast("Bank deleted.", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = "Delete";
  }
}

// ─── Print ─────────────────────────────────────────────────
function printInvestor(investorId) {
  const inv    = investors[investorId];
  const txns   = txnsWithRunningBalance(investorId);
  const { deposited, interest, balance } = calcBalance(investorId);
  const currentRate    = getEffectiveRate(inv.rateHistory, settings.monthlyRate);
  const monthlyDeposit = inv.forecastMonthly   ?? 0;
  const monthsLeft     = inv.forecastMonths    ?? defaultForecastMonths();
  const eoyForecast    = calcEOYForecast(investorId, monthlyDeposit, monthsLeft);
  const forecastChartData = calcForecastMonthByMonth(investorId, monthlyDeposit, monthsLeft);

  const serializedTxns = txns.slice(-8).map(t => ({
    ...t,
    date: tsToDate(t.date).toISOString()
  }));

  sessionStorage.setItem("sf_return_bank", currentBankId);
  sessionStorage.setItem("sf_print_data", JSON.stringify({
    bankId:   currentBankId,
    investor: { id: inv.id, name: inv.name, emoji: inv.emoji },
    settings: { ...settings, currentRate },
    txns:     serializedTxns,
    deposited,
    interest,
    balance,
    eoyForecast,
    monthlyDeposit,
    monthsLeft,
    forecastStatOnStmt:  inv.forecastStatOnStmt  ?? true,
    forecastChartOnStmt: inv.forecastChartOnStmt ?? true,
    forecastChartData
  }));

  window.location.href = `print.html?id=${investorId}`;
}

// ─── Login ─────────────────────────────────────────────────
function showLoginForm(e) {
  if (e) e.preventDefault();
  show("form-login");
  hide("form-signup");
  $("login-error").textContent = "";
}

function showSignupForm(e) {
  if (e) e.preventDefault();
  hide("form-login");
  show("form-signup");
  $("signup-error").textContent = "";
  setTimeout(() => $("signup-name").focus(), 50);
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const pass  = $("login-password").value;
  const errEl = $("login-error");
  const btn   = $("btn-login");

  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Signing in…`;

  try {
    await auth.signInWithEmailAndPassword(email, pass);
  } catch (err) {
    errEl.textContent = friendlyAuthError(err.code);
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const name  = $("signup-name").value.trim();
  const email = $("signup-email").value.trim();
  const pass  = $("signup-password").value;
  const errEl = $("signup-error");
  const btn   = $("btn-signup");

  if (!name)  { errEl.textContent = "Please enter your name."; return; }
  if (!email) { errEl.textContent = "Please enter your email."; return; }
  if (pass.length < 6) { errEl.textContent = "Password must be at least 6 characters."; return; }

  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Creating account…`;

  handlingSignup = true;
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    currentUser = cred.user;

    // Create their first bank
    const bankDocRef = db.collection("banks").doc();
    await bankDocRef.set({
      bankName:    `${name}'s Bank`,
      bankLogo:    "🏦",
      monthlyRate: 10,
      ownerId:     currentUser.uid,
      ownerName:   name,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });

    currentBankId = bankDocRef.id;
    banks[currentBankId] = {
      id:          currentBankId,
      bankName:    `${name}'s Bank`,
      bankLogo:    "🏦",
      monthlyRate: 10,
      ownerId:     currentUser.uid
    };
    settings = { ...banks[currentBankId] };

    handlingSignup = false;
    hide("view-login");
    hide("loading-screen");
    show("app-shell");
    attachListeners();
    navigateTo("dashboard");
  } catch (err) {
    handlingSignup = false;
    errEl.textContent = friendlyAuthError(err.code);
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
}

function friendlyAuthError(code) {
  const msgs = {
    "auth/user-not-found":       "No account found with that email.",
    "auth/wrong-password":       "Incorrect password.",
    "auth/invalid-email":        "Please enter a valid email address.",
    "auth/too-many-requests":    "Too many attempts. Please try again later.",
    "auth/invalid-credential":   "Incorrect email or password.",
    "auth/email-already-in-use": "An account with that email already exists.",
    "auth/weak-password":        "Password must be at least 6 characters."
  };
  return msgs[code] || "Something went wrong. Please try again.";
}

function handleLogout() {
  auth.signOut();
}

// ─── Utility ───────────────────────────────────────────────
function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── Custom Date Picker ─────────────────────────────────────
const DP_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function populateDatePicker(prefix, isoDate) {
  const [yr, mo, dy] = isoDate.split("-").map(Number);
  const mSel = $(prefix + "-m");
  const dSel = $(prefix + "-d");
  const ySel = $(prefix + "-y");
  if (!mSel || !dSel || !ySel) return;
  const curYear = new Date().getFullYear();

  mSel.innerHTML = DP_MONTHS.map((name, i) =>
    `<option value="${String(i+1).padStart(2,"0")}"${i+1===mo?" selected":""}>${name}</option>`
  ).join("");

  ySel.innerHTML = "";
  for (let y = curYear - 10; y <= curYear + 5; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    if (y === yr) opt.selected = true;
    ySel.appendChild(opt);
  }
  _refreshDPDays(prefix, mo, yr, dy);
}

function _refreshDPDays(prefix, month, year, selDay) {
  const dSel = $(prefix + "-d");
  if (!dSel) return;
  const days = new Date(year, month, 0).getDate();
  const cur  = selDay != null ? selDay : (parseInt(dSel.value) || 1);
  dSel.innerHTML = "";
  for (let d = 1; d <= days; d++) {
    const opt = document.createElement("option");
    opt.value = String(d).padStart(2, "0");
    opt.textContent = d;
    if (d === Math.min(cur, days)) opt.selected = true;
    dSel.appendChild(opt);
  }
}

function onDatePickerChange(prefix) {
  _refreshDPDays(prefix,
    parseInt($(prefix + "-m").value),
    parseInt($(prefix + "-y").value),
    null
  );
}

function getDatePickerValue(prefix) {
  const m = $(prefix + "-m")?.value;
  const d = $(prefix + "-d")?.value;
  const y = $(prefix + "-y")?.value;
  return (m && d && y) ? `${y}-${m}-${d}` : todayInputValue();
}

// ─── Keyboard / backdrop ────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
    hide("modal-create-bank");
    hide("modal-rate");
    hide("modal-our-story");
    hide("modal-how-it-works");
    closeMobileMenu();
  }
});

document.addEventListener("click", e => {
  if (e.target.classList.contains("modal-backdrop")) {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
    hide("modal-create-bank");
    hide("modal-rate");
    hide("modal-our-story");
    hide("modal-how-it-works");
  }
  // Close mobile menu when clicking outside of it
  const menu = document.getElementById("mobile-menu");
  const btn  = document.getElementById("hamburger-btn");
  if (menu && !menu.classList.contains("hidden")) {
    if (!menu.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
      closeMobileMenu();
    }
  }
});
