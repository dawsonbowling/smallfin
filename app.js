/* ─────────────────────────────────────────────────────────────
   SmallFin — app.js
   Vanilla JS + Firebase (compat SDK via CDN)
───────────────────────────────────────────────────────────── */

const VERSION = "1.6";

// ─── Firebase init ─────────────────────────────────────────
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();
db.enablePersistence({ synchronizeTabs: true })
  .catch(err => console.warn("Firestore persistence:", err.code));

// ─── State ─────────────────────────────────────────────────
let currentUser   = null;
let currentBankId = null;          // = currentUser.uid
let settings      = { bankName: "SmallFin", monthlyRate: 10, bankLogo: "🏦" };
let investors     = {};            // id → { name, emoji, createdAt }
let transactions  = {};            // investorId → [deposit txn, ...]

// Active Firestore listeners — stored so we can detach on logout
const listeners = [];

// Prevents onAuthStateChanged from double-firing during signup
let handlingSignup = false;

// ─── Firestore helpers ──────────────────────────────────────
const bankRef       = () => db.collection("banks").doc(currentBankId);
const investorsRef  = () => bankRef().collection("investors");
const txnsRef       = () => bankRef().collection("transactions");

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

// ─── Interest computation ────────────────────────────────────
// Interest is never stored — always derived from deposit history.
// Each month: priorBalance × rate, plus prorated interest for
// deposits made mid-month: amount × (daysInMonth - depositDay + 1) / daysInMonth × rate.
// Interest for month M is dated the 1st of month M+1.
function computeInterestTransactions(deposits, monthlyRate) {
  if (!deposits || deposits.length === 0) return [];
  const rate = monthlyRate / 100;
  const today = new Date();
  const currentYear  = today.getFullYear();
  const currentMonth = today.getMonth();

  const sorted = deposits.slice().sort((a, b) => {
    const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
    const db_ = b.date?.toDate ? b.date.toDate() : new Date(b.date);
    return da - db_;
  });

  const firstDate = sorted[0].date?.toDate ? sorted[0].date.toDate() : new Date(sorted[0].date);
  let year  = firstDate.getFullYear();
  let month = firstDate.getMonth();

  const result = [];
  let runningBalance = 0;

  while (year < currentYear || (year === currentYear && month < currentMonth)) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const depositsThisMonth = sorted.filter(d => {
      const dd = d.date?.toDate ? d.date.toDate() : new Date(d.date);
      return dd.getFullYear() === year && dd.getMonth() === month;
    });

    let interest = runningBalance * rate;
    depositsThisMonth.forEach(d => {
      const dd = d.date?.toDate ? d.date.toDate() : new Date(d.date);
      const daysEarning = daysInMonth - dd.getDate() + 1;
      interest += d.amount * (daysEarning / daysInMonth) * rate;
      runningBalance += d.amount;
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

// ─── Balance calculator ─────────────────────────────────────
function calcBalance(investorId) {
  const deposits  = transactions[investorId] || [];
  const interest  = computeInterestTransactions(deposits, settings.monthlyRate);
  const deposited = deposits.reduce((s, t) => s + t.amount, 0);
  const earned    = interest.reduce((s, t) => s + t.amount, 0);
  return { deposited, interest: earned, balance: deposited + earned };
}

// Running balance for statement / transaction modal
function txnsWithRunningBalance(investorId) {
  const deposits        = transactions[investorId] || [];
  const interestEntries = computeInterestTransactions(deposits, settings.monthlyRate);

  const all = [...deposits, ...interestEntries].sort((a, b) => {
    const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
    const db_ = b.date?.toDate ? b.date.toDate() : new Date(b.date);
    return da - db_;
  });

  let running = 0;
  return all.map(t => {
    running += t.amount;
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
    detachListeners();
    showLogin();
  }
});

function showLogin() {
  hide("app-shell");
  showLoginForm();
  show("view-login");
}

async function showApp() {
  hide("view-login");
  currentBankId = currentUser.uid;
  await setupBank();
  hide("loading-screen");
  show("app-shell");
  migrateDeleteInterestTransactions();
  attachListeners();
  navigateTo("dashboard");
}

// ─── Bank setup & migration ─────────────────────────────────
async function setupBank() {
  const bankDoc = await bankRef().get();
  if (bankDoc.exists) return; // Already set up

  // Check if this user has legacy data (is the original admin)
  const legacyCheck = await db.collection("transactions")
    .where("addedBy", "==", currentBankId).limit(1).get();

  if (!legacyCheck.empty) {
    await migrateOldDataToBank();
  } else {
    // Fresh bank for a new user
    await bankRef().set({
      bankName:    "My Bank",
      monthlyRate: 10,
      bankLogo:    "🏦",
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
  }
}

async function migrateOldDataToBank() {
  try {
    const [settingsSnap, investorsSnap, txnsSnap] = await Promise.all([
      db.collection("config").doc("settings").get(),
      db.collection("investors").get(),
      db.collection("transactions").where("type", "==", "deposit").get()
    ]);

    const old = settingsSnap.exists
      ? { bankName: "SmallFin", monthlyRate: 5, bankLogo: "🏦", ...settingsSnap.data() }
      : { bankName: "SmallFin", monthlyRate: 5, bankLogo: "🏦" };

    const batch = db.batch();

    // Bank settings doc
    batch.set(bankRef(), {
      bankName:    old.bankName,
      monthlyRate: old.monthlyRate,
      bankLogo:    old.bankLogo || "🏦",
      migratedAt:  firebase.firestore.FieldValue.serverTimestamp()
    });

    // Investors
    investorsSnap.forEach(doc => {
      batch.set(investorsRef().doc(doc.id), doc.data());
    });

    await batch.commit();

    // Transactions (separate batch)
    if (!txnsSnap.empty) {
      const txnBatch = db.batch();
      txnsSnap.forEach(doc => {
        txnBatch.set(txnsRef().doc(doc.id), doc.data());
      });
      await txnBatch.commit();
    }
  } catch (e) {
    console.error("Migration error:", e);
  }
}

// One-time cleanup: remove any stored interest transactions
async function migrateDeleteInterestTransactions() {
  try {
    // Legacy flat collection
    const oldSnap = await db.collection("transactions").where("type", "==", "interest").get();
    if (!oldSnap.empty) {
      const batch = db.batch();
      oldSnap.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    // Bank subcollection (shouldn't exist, but just in case)
    const newSnap = await txnsRef().where("type", "==", "interest").get();
    if (!newSnap.empty) {
      const batch = db.batch();
      newSnap.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  } catch (e) {
    console.error("Interest cleanup error:", e);
  }
}

function detachListeners() {
  listeners.forEach(unsub => unsub());
  listeners.length = 0;
  investors    = {};
  transactions = {};
}

// ─── Firestore listeners ────────────────────────────────────
function attachListeners() {
  // Bank settings (the bank doc itself)
  const unsubSettings = bankRef()
    .onSnapshot(snap => {
      if (snap.exists) {
        settings = { bankName: "SmallFin", monthlyRate: 10, bankLogo: "🏦", ...snap.data() };
      }
      renderAll();
    }, err => console.error("settings listener:", err));
  listeners.push(unsubSettings);

  // Investors
  const unsubInvestors = investorsRef()
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

  // Transactions — only deposits stored; interest computed on the fly
  const unsubTxns = txnsRef()
    .orderBy("date", "desc")
    .onSnapshot(snap => {
      transactions = {};
      snap.forEach(doc => {
        const t = { id: doc.id, ...doc.data() };
        if (t.type !== "deposit") return;
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

// ─── Render ────────────────────────────────────────────────
function renderAll() {
  if (currentView === "dashboard") renderDashboard();
  if (currentView === "settings")  renderSettings();
  renderNavBrand();
}

function renderNavBrand() {
  const nameEl = $("nav-bank-name");
  if (nameEl) nameEl.textContent = settings.bankName;
  const iconEl = $("nav-brand-icon");
  if (iconEl) iconEl.textContent = settings.bankLogo || "🏦";
  const verEl = $("nav-version");
  if (verEl) verEl.textContent = `v${VERSION}`;
}

function renderDashboard() {
  const rateEl = $("current-rate-display");
  if (rateEl) rateEl.textContent = `${settings.monthlyRate}%`;

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
    const avatar = inv.emoji || inv.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const card = el("div", "investor-card");
    card.innerHTML = `
      <div class="investor-card-header">
        <div class="investor-avatar" onclick="openAvatarModal('${id}')" title="Change avatar" style="cursor:pointer">${avatar}</div>
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
  renderEmojiPicker("bank-logo-picker", BANK_LOGOS, settings.bankLogo || "🏦", "setting-bank-logo");
}

function setInner(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
    await investorsRef().add({
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
  const note    = $("deposit-note").value.trim();
  const dateVal = $("deposit-date").value;
  const dateObj = dateVal ? new Date(dateVal + "T12:00:00") : new Date();

  const btn = $("btn-deposit-submit");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await txnsRef().add({
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
        <div style="display:flex;align-items:center;gap:8px">
          <div>
            <div class="txn-amount ${t.type}">+${fmt(t.amount)}</div>
            <div class="txn-balance">Bal: ${fmt(t.runningBalance)}</div>
          </div>
          ${t.type === "deposit" ? `<button class="btn-icon" onclick="deleteDepositTransaction('${t.id}','${investorId}')" title="Delete deposit" style="color:#ef4444">🗑</button>` : ""}
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

async function deleteDepositTransaction(txnId, investorId) {
  const confirmed = confirm("Delete this deposit? Interest will recalculate automatically.");
  if (!confirmed) return;
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

// ─── Delete Investor ────────────────────────────────────────
async function confirmDeleteInvestor(investorId) {
  const inv = investors[investorId];
  const confirmed = confirm(
    `Remove ${inv?.name}?\n\nThis will permanently delete all their transactions. This cannot be undone.`
  );
  if (!confirmed) return;
  try {
    const snap = await txnsRef().where("investorId", "==", investorId).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    batch.delete(investorsRef().doc(investorId));
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

  if (!bankName) { toast("Bank name can't be empty.", "error"); return; }
  if (isNaN(rateRaw) || rateRaw < 0 || rateRaw > 100) {
    toast("Rate must be between 0 and 100.", "error");
    return;
  }

  const btn = $("btn-save-settings");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await bankRef().set({
      bankName,
      monthlyRate: rateRaw,
      bankLogo:    $("setting-bank-logo").value || "🏦",
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy:   currentUser.uid
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
  const inv    = investors[investorId];
  const txns   = txnsWithRunningBalance(investorId);
  const { deposited, interest, balance } = calcBalance(investorId);

  // Serialize Firestore Timestamps to ISO strings for sessionStorage
  const serializedTxns = txns.map(t => ({
    ...t,
    date: (t.date?.toDate ? t.date.toDate() : new Date(t.date)).toISOString()
  }));

  sessionStorage.setItem("sf_print_data", JSON.stringify({
    investor: { id: inv.id, name: inv.name, emoji: inv.emoji },
    settings: { ...settings },
    txns:     serializedTxns,
    deposited,
    interest,
    balance
  }));

  window.open(`print.html?id=${investorId}`, "_blank");
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
    currentUser   = cred.user;
    currentBankId = cred.user.uid;

    // Create bank before showing app
    await bankRef().set({
      bankName:    `${name}'s Bank`,
      monthlyRate: 10,
      bankLogo:    "🏦",
      ownerName:   name,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });

    handlingSignup = false;
    await showApp();
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

// ─── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
  }
});

document.addEventListener("click", e => {
  if (e.target.classList.contains("modal-backdrop")) {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
  }
});
