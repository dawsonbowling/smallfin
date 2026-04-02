/* ─────────────────────────────────────────────────────────────
   SmallFin — app.js  v2.0
   Vanilla JS + Firebase (compat SDK via CDN)
───────────────────────────────────────────────────────────── */

const VERSION = "2.0";

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
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function setInner(id, val) { const e = $(id); if (e) e.textContent = val; }

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── Interest computation ────────────────────────────────────
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

function calcBalance(investorId) {
  const deposits  = transactions[investorId] || [];
  const interest  = computeInterestTransactions(deposits, settings.monthlyRate);
  const deposited = deposits.reduce((s, t) => s + t.amount, 0);
  const earned    = interest.reduce((s, t) => s + t.amount, 0);
  return { deposited, interest: earned, balance: deposited + earned };
}

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
    banks         = {};
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
  await loadBanks();
  hide("loading-screen");
  show("app-shell");
  const returnBankId = new URLSearchParams(window.location.search).get("bankId");
  if (returnBankId && banks[returnBankId]) {
    enterBank(returnBankId);
  } else {
    navigateTo("banks");
  }
}

// ─── My Banks ──────────────────────────────────────────────
async function loadBanks() {
  try {
    const snap = await db.collection("banks")
      .where("ownerId", "==", currentUser.uid)
      .get();
    banks = {};
    snap.forEach(doc => {
      banks[doc.id] = { id: doc.id, ...doc.data() };
    });
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
    card.innerHTML = `
      <div class="bank-card-logo">${bank.bankLogo || "🏦"}</div>
      <div class="bank-card-name">${escHtml(bank.bankName)}</div>
      <div class="bank-card-rate">${bank.monthlyRate ?? 10}% / mo</div>
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
    await ref.set({
      bankName:    name,
      bankLogo:    logo,
      monthlyRate: 10,
      ownerId:     currentUser.uid,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
    banks[ref.id] = { id: ref.id, bankName: name, bankLogo: logo, monthlyRate: 10, ownerId: currentUser.uid };
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
        if (t.type !== "deposit") return;
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

  if (nameEl) nameEl.textContent = currentBankId ? settings.bankName : "SmallFin";
  if (iconEl) iconEl.textContent = currentBankId ? (settings.bankLogo || "🏦") : "🏦";
  if (verEl)  verEl.textContent  = `v${VERSION}`;
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

function openDepositModal(investorId) {
  depositTargetId = investorId;
  const inv = investors[investorId];
  $("deposit-investor-name").textContent = inv?.name || "Investor";
  $("deposit-amount").value = "";
  $("deposit-note").value   = "";
  $("deposit-date").value   = todayInputValue();
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
      bankId:     currentBankId,
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
  if (!confirm("Delete this deposit? Interest will recalculate automatically.")) return;
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
  if (!confirm(`Remove ${inv?.name}?\n\nThis will permanently delete all their transactions. This cannot be undone.`)) return;
  try {
    const snap = await txnsRef()
      .where("bankId",     "==", currentBankId)
      .where("investorId", "==", investorId)
      .get();
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

  const logo = $("setting-bank-logo").value || "🏦";
  const btn  = $("btn-save-settings");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;
  try {
    await bankRef().set({
      bankName,
      monthlyRate: rateRaw,
      bankLogo:    logo,
      ownerId:     currentUser.uid,
      updatedAt:   firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    banks[currentBankId] = { ...banks[currentBankId], bankName, monthlyRate: rateRaw, bankLogo: logo };
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

  const serializedTxns = txns.map(t => ({
    ...t,
    date: (t.date?.toDate ? t.date.toDate() : new Date(t.date)).toISOString()
  }));

  sessionStorage.setItem("sf_print_data", JSON.stringify({
    bankId:   currentBankId,
    investor: { id: inv.id, name: inv.name, emoji: inv.emoji },
    settings: { ...settings },
    txns:     serializedTxns,
    deposited,
    interest,
    balance
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

// ─── Keyboard / backdrop ────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
    hide("modal-create-bank");
  }
});

document.addEventListener("click", e => {
  if (e.target.classList.contains("modal-backdrop")) {
    hide("modal-add-investor");
    hide("modal-deposit");
    hide("modal-txn");
    hide("modal-avatar");
    hide("modal-create-bank");
  }
});
