/* ─────────────────────────────────────────────────────────────
   SmallFin — app.js
   Vanilla JS + Firebase (compat SDK via CDN)
───────────────────────────────────────────────────────────── */

// ─── Firebase init ─────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();

// ─── State ─────────────────────────────────────────────────
let currentUser   = null;
let settings      = { bankName: "SmallFin", monthlyRate: 5 };
let investors     = {};   // id → { name, createdAt }
let transactions  = {};   // investorId → [txn, ...]

// Active Firestore listeners — stored so we can detach on logout
const listeners = [];

// Prevent re-showing the interest banner after dismiss within a session
let interestBannerDismissed = false;

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

// ─── Currency formatter ─────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2
  }).format(n ?? 0);
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Balance calculator ─────────────────────────────────────
function calcBalance(investorId) {
  const txns = transactions[investorId] || [];
  let deposited = 0, interest = 0;
  txns.forEach(t => {
    if (t.type === "deposit")  deposited += t.amount;
    if (t.type === "interest") interest  += t.amount;
  });
  return { deposited, interest, balance: deposited + interest };
}

// Running balance for statement view
function txnsWithRunningBalance(investorId) {
  const txns = (transactions[investorId] || [])
    .slice()
    .sort((a, b) => {
      const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
      const db_ = b.date?.toDate ? b.date.toDate() : new Date(b.date);
      return da - db_;
    });
  let running = 0;
  return txns.map(t => {
    running += t.amount;
    return { ...t, runningBalance: running };
  });
}

// ─── Auth ──────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  hide("loading-screen");
  if (user) {
    currentUser = user;
    showApp();
  } else {
    currentUser = null;
    detachListeners();
    showLogin();
  }
});

function showLogin() {
  hide("app-shell");
  show("view-login");
}

function showApp() {
  hide("view-login");
  show("app-shell");
  attachListeners();
  navigateTo("dashboard");
}

function detachListeners() {
  listeners.forEach(unsub => unsub());
  listeners.length = 0;
  investors             = {};
  transactions          = {};
  interestBannerDismissed = false;
  hide("interest-banner");
}

// ─── Firestore listeners ────────────────────────────────────
function attachListeners() {
  // Settings
  const unsubSettings = db.collection("config").doc("settings")
    .onSnapshot(snap => {
      if (snap.exists) {
        settings = { bankName: "SmallFin", monthlyRate: 5, ...snap.data() };
      }
      renderAll();
    }, err => console.error("settings listener:", err));
  listeners.push(unsubSettings);

  // Investors
  const unsubInvestors = db.collection("investors")
    .orderBy("createdAt", "asc")
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

  // Transactions
  const unsubTxns = db.collection("transactions")
    .orderBy("date", "desc")
    .onSnapshot(snap => {
      // Rebuild from scratch on each update (simple and correct)
      transactions = {};
      snap.forEach(doc => {
        const t = { id: doc.id, ...doc.data() };
        if (!transactions[t.investorId]) transactions[t.investorId] = [];
        transactions[t.investorId].push(t);
      });
      renderAll();
    }, err => console.error("transactions listener:", err));
  listeners.push(unsubTxns);
}

// ─── Routing ───────────────────────────────────────────────
let currentView = "dashboard";

function navigateTo(view) {
  currentView = view;
  ["dashboard", "settings"].forEach(v => {
    toggle(`view-${v}`, v === view);
    $(`nav-btn-${v}`)?.classList.toggle("active", v === view);
  });
  renderAll();
}

// ─── Interest Banner ───────────────────────────────────────
function checkAutoInterest() {
  if (interestBannerDismissed) return;
  if (Object.keys(investors).length === 0) { hide("interest-banner"); return; }
  const d = new Date();
  const current = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  if ((settings.lastInterestYearMonth || "") < current) {
    show("interest-banner");
  } else {
    hide("interest-banner");
  }
}

function dismissInterestBanner() {
  interestBannerDismissed = true;
  hide("interest-banner");
}

// ─── Render ────────────────────────────────────────────────
function renderAll() {
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "settings")  renderSettings();
  renderNavBrand();
}

function renderNavBrand() {
  const el = $("nav-bank-name");
  if (el) el.textContent = settings.bankName;
}

function renderDashboard() {
  checkAutoInterest();

  // Rate banner
  const rateEl = $("current-rate-display");
  if (rateEl) rateEl.textContent = `${settings.monthlyRate}%`;

  // Stats bar
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

  // Investor grid
  const grid = $("investor-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const ids = Object.keys(investors);
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
    const initials = inv.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const card = el("div", "investor-card");
    card.innerHTML = `
      <div class="investor-card-header">
        <div class="investor-avatar">${initials}</div>
        <span class="investor-name">${escHtml(inv.name)}</span>
        <button class="btn-icon" onclick="openTxnModal('${id}')" title="View transactions" style="color:rgba(255,255,255,0.6)">📋</button>
      </div>
      <div class="investor-card-body">
        <div class="investor-stats">
          <div class="investor-stat">
            <div class="s-label">Deposited</div>
            <div class="s-value">${fmt(deposited)}</div>
          </div>
          <div class="investor-stat interest">
            <div class="s-label">Interest</div>
            <div class="s-value">${fmt(interest)}</div>
          </div>
          <div class="investor-stat balance" style="grid-column:1/-1">
            <div class="s-label">Current Balance</div>
            <div class="s-value">${fmt(balance)}</div>
          </div>
        </div>
      </div>
      <div class="investor-card-footer">
        <button class="btn btn-primary" onclick="openDepositModal('${id}')">+ Deposit</button>
        <button class="btn btn-ghost" onclick="printInvestor('${id}')">🖨 Statement</button>
        <button class="btn-icon" onclick="confirmDeleteInvestor('${id}')" title="Remove investor" style="margin-left:auto;color:#ef4444">🗑</button>
      </div>`;
    grid.appendChild(card);
  });
}

function renderSettings() {
  const nameEl = $("setting-bank-name");
  const rateEl = $("setting-monthly-rate");
  if (nameEl) nameEl.value = settings.bankName;
  if (rateEl) rateEl.value = settings.monthlyRate;
}

function setInner(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── Add Investor Modal ─────────────────────────────────────
function openAddInvestorModal() {
  $("modal-add-investor").classList.remove("hidden");
  $("new-investor-name").value = "";
  setTimeout(() => $("new-investor-name").focus(), 50);
}

function closeAddInvestorModal() {
  hide("modal-add-investor");
}

async function submitAddInvestor() {
  const name = $("new-investor-name").value.trim();
  if (!name) { toast("Please enter a name.", "error"); return; }
  const btn = $("btn-add-investor-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Adding…`;
  try {
    await db.collection("investors").add({
      name,
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

function openDepositModal(investorId) {
  depositTargetId = investorId;
  const inv = investors[investorId];
  $("deposit-investor-name").textContent = inv?.name || "Investor";
  $("deposit-amount").value = "";
  $("deposit-note").value = "";
  $("deposit-date").value = todayInputValue();
  show("modal-deposit");
  setTimeout(() => $("deposit-amount").focus(), 50);
}

function closeDepositModal() {
  hide("modal-deposit");
  depositTargetId = null;
}

async function submitDeposit() {
  const amountRaw = parseFloat($("deposit-amount").value);
  if (!amountRaw || amountRaw <= 0) { toast("Enter a valid amount.", "error"); return; }
  const note = $("deposit-note").value.trim();
  const dateVal = $("deposit-date").value;
  const dateObj = dateVal ? new Date(dateVal + "T12:00:00") : new Date();

  const btn = $("btn-deposit-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await db.collection("transactions").add({
      investorId: depositTargetId,
      type:       "deposit",
      amount:     amountRaw,
      date:       firebase.firestore.Timestamp.fromDate(dateObj),
      note:       note || "",
      addedBy:    currentUser.uid
    });
    closeDepositModal();
    toast(`${fmt(amountRaw)} deposit logged!`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log Deposit";
  }
}

// ─── Apply Monthly Interest ─────────────────────────────────
async function applyMonthlyInterest() {
  const ids = Object.keys(investors);
  if (ids.length === 0) { toast("No investors to apply interest to.", "error"); return; }

  const rate = settings.monthlyRate / 100;
  const confirmed = confirm(
    `Apply ${settings.monthlyRate}% monthly interest to all ${ids.length} investor(s)?\n\nThis will create an interest transaction for each investor based on their current balance.`
  );
  if (!confirmed) return;

  const btn = $("btn-apply-interest");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Applying…`; }

  try {
    const batch = db.batch();
    const now = firebase.firestore.Timestamp.now();
    ids.forEach(id => {
      const { balance } = calcBalance(id);
      if (balance <= 0) return;
      const interestAmount = parseFloat((balance * rate).toFixed(2));
      const ref = db.collection("transactions").doc();
      batch.set(ref, {
        investorId:  id,
        type:        "interest",
        amount:      interestAmount,
        date:        now,
        note:        `Monthly interest @ ${settings.monthlyRate}%`,
        appliedRate: settings.monthlyRate,
        addedBy:     currentUser.uid
      });
    });
    await batch.commit();
    const d = new Date();
    const currentYearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    await db.collection("config").doc("settings").set(
      { lastInterestYearMonth: currentYearMonth },
      { merge: true }
    );
    interestBannerDismissed = true;
    hide("interest-banner");
    toast("Monthly interest applied!", "success");
  } catch (e) {
    toast("Error applying interest: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Apply Monthly Interest"; }
  }
}

// ─── Transaction History Modal ──────────────────────────────
function openTxnModal(investorId) {
  const inv  = investors[investorId];
  const txns = txnsWithRunningBalance(investorId);
  const { deposited, interest, balance } = calcBalance(investorId);

  $("txn-modal-title").textContent = `${inv?.name}'s Transactions`;

  const list = $("txn-modal-list");
  list.innerHTML = "";

  if (txns.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted)">No transactions yet.</div>`;
  } else {
    [...txns].reverse().forEach(t => {
      const item = el("div", "txn-item");
      const icon = t.type === "deposit" ? "↓" : "★";
      item.innerHTML = `
        <div class="txn-icon ${t.type}">${icon}</div>
        <div class="txn-details">
          <div class="txn-desc">${t.note || (t.type === "deposit" ? "Deposit" : "Interest")}</div>
          <div class="txn-date">${fmtDate(t.date)}</div>
        </div>
        <div>
          <div class="txn-amount ${t.type}">+${fmt(t.amount)}</div>
          <div class="txn-balance">Bal: ${fmt(t.runningBalance)}</div>
        </div>`;
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

// ─── Delete Investor ────────────────────────────────────────
async function confirmDeleteInvestor(investorId) {
  const inv = investors[investorId];
  const confirmed = confirm(
    `Remove ${inv?.name}?\n\nThis will permanently delete all their transactions. This cannot be undone.`
  );
  if (!confirmed) return;
  try {
    // Delete all transactions first
    const snap = await db.collection("transactions")
      .where("investorId", "==", investorId).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection("investors").doc(investorId));
    await batch.commit();
    toast(`${inv?.name} removed.`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  }
}

// ─── Settings ──────────────────────────────────────────────
async function saveSettings() {
  const bankName = $("setting-bank-name").value.trim();
  const rateRaw  = parseFloat($("setting-monthly-rate").value);

  if (!bankName)              { toast("Bank name can't be empty.", "error"); return; }
  if (isNaN(rateRaw) || rateRaw < 0 || rateRaw > 100) {
    toast("Rate must be between 0 and 100.", "error");
    return;
  }

  const btn = $("btn-save-settings");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await db.collection("config").doc("settings").set({
      bankName,
      monthlyRate: rateRaw,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentUser.uid
    }, { merge: true });
    toast("Settings saved!", "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─── Print ─────────────────────────────────────────────────
function printInvestor(investorId) {
  window.open(`print.html?id=${investorId}`, "_blank");
}

// ─── Login ─────────────────────────────────────────────────
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

function friendlyAuthError(code) {
  const msgs = {
    "auth/user-not-found":    "No account found with that email.",
    "auth/wrong-password":    "Incorrect password.",
    "auth/invalid-email":     "Please enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/invalid-credential":"Incorrect email or password."
  };
  return msgs[code] || "Sign-in failed. Check your credentials.";
}

function handleLogout() {
  auth.signOut();
}

// ─── Utility ───────────────────────────────────────────────
function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
  }
});

// Close modals on backdrop click
document.addEventListener("click", e => {
  if (e.target.classList.contains("modal-backdrop")) {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
  }
});
