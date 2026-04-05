# SmallFin — Project Notes

## What We Built
SmallFin is a compound interest investment tracker for kids. It lets you track investments, visualize growth over time, and teach kids about the power of compound interest.

## Current State (v2.23)
- App is fully built and deployed to GitHub Pages
- Live at: **smallfin.app** (custom domain active)
- Version number displayed in the nav

## Firebase
- Project ID: `smallfin-4dc4f`
- Firebase Authentication: enabled
- Firestore: enabled
- Per-user data — each user owns their own banks, investors, and transactions

## How Interest Works
- Interest is computed on the fly from deposit history — nothing is stored in Firestore
- Each month: prior balance × rate, plus prorated interest for mid-month deposits
- Proration: `(daysInMonth - depositDay + 1) / daysInMonth × rate` (deposit day counts)
- Interest for month M is dated the 1st of month M+1
- Deleting a deposit instantly recalculates all interest

## Completed Features
- ✅ Dashboard with investor cards, stats bar
- ✅ Add investors with emoji avatars (click avatar on card to change)
- ✅ Log deposits/withdrawals via "+ Transaction" dropdown (Deposit / Withdrawal / Change Interest Rate)
- ✅ Delete individual deposits from transaction history
- ✅ Automatic compound interest — computed from deposit dates, no manual step
- ✅ Printable bank statement per investor (with projection)
- ✅ Settings: bank name, bank logo (emoji picker)
- ✅ Multi-bank support: My Banks screen, create/enter/exit banks
- ✅ Bank sharing: invite others via share link; invited users join with full access
- ✅ Shared badge on bank cards (shown to owner when bank has members, and to members)
- ✅ Delete bank in Settings (blocked if bank has members)
- ✅ Per-investor interest rates with effective dates and full rate change history
- ✅ Rate changes appear in transaction log (deletable)
- ✅ Our Story and How It Works modals (nav links on desktop, hamburger menu on mobile)
- ✅ Nav: SmallFin logo on My Banks screen (no white box), bank name inside a bank
- ✅ Cache-busting via ?v= query string on app.js and styles.css
- ✅ Sign-in button always resets to "Sign In" when login screen loads

## Investor Cards (v2.18+)
- Vertical 4-section layout: Header / Stats / Actions / Forecast
- 2-column grid on desktop, 1-column on mobile
- **Section 1 — Header:** avatar + name + ✏ pencil (opens avatar picker) + rate pill (read-only)
- **Section 2 — Stats:** Deposited / Interest (gold) / Balance (green)
- **Section 3 — Actions:** "+ Transaction ▾" dropdown (Deposit, Withdrawal, Change Interest Rate) + 📋 history + 🖨️ statement
- **Section 4 — Forecast:** "If I invest $X/mo, in X months I'll have $X" + 📊 icon opens Forecast Panel
- Trash/delete removed from card — delete moves to investor settings (via ✏ pencil, not yet built)
- "+ Transaction" dropdown uses `position: fixed` via `getBoundingClientRect` to escape card boundaries

## Forecast
- **Forecast Panel modal:** editable monthly deposit + months (default = months remaining in year), live projected total, saves per investor to Firestore (`forecastMonthly`, `forecastMonths`)
- **Rate-aware projection:** `calcEOYForecast` iterates month-by-month using `getRateForMonth` — future scheduled rate changes are applied at the correct month
- **`tsToDate` helper:** normalizes all Firestore Timestamp forms (Timestamp instance, plain `{seconds,nanoseconds}` map, string) — fixes silent failure where plain maps returned `Invalid Date` and caused all rate history to be dropped
- Forecast card text: "If I invest **$X/mo**, in **X months** I'll have **$X**" (always shown, defaults to $0/mo)

## Mobile
- ✅ Hamburger menu replaces all nav links; dropdown has My Banks, Settings, Our Story, How It Works, Sign Out
- ✅ Stats grid: 2×2 on mobile
- ✅ Investor cards: single column on mobile (same vertical card layout as desktop)
- ✅ Date inputs replaced with Month/Day/Year select dropdowns (iOS Safari can't reliably style native date inputs)
- ✅ overflow-x: hidden on body/page to prevent horizontal scroll

## Statement Page
- ✅ Header stacks vertically on mobile
- ✅ TYPE column hidden on mobile
- ✅ Projection shows: "Projected balance" with note "If [name] invests $X/mo for X months" (or balance-only note)

## Setup & Deploy
- GitHub Pages: push to `main` → auto-deploys in ~2 minutes
- To release a new version: bump `VERSION` in `app.js` and `?v=X.X` on both the `<script>` and `<link>` tags in `index.html`
- After deploying: hard refresh (`Ctrl+Shift+R`) to bypass CDN cache if changes aren't showing

## Up Next
- **Investor settings modal** (via ✏ pencil): edit name, change avatar, delete investor
- **Forecast Panel v2:** comprehensive modal with month-by-month chart, breakdown of deposited/interest/projected balance, "include on statement" checkboxes per section
  - Section 1: inputs (monthly deposit, months)
  - Section 2: big numbers — total deposited, total interest earned, projected balance (all live)
  - Section 3: line chart — balance over time; two lines if monthly deposit > $0 (with/without deposits)
  - Statement checkboxes: ☑ Projected balance summary, ☑ Month-by-month chart (persist per investor)
- **Statement page:** render forecast sections based on saved checkboxes; projected balance always most prominent

## Post-MVP Ideas
- Kid-forward design / DiceBear Avatars

## MVP Edits
- Forcesating editor should open a panel with other cool options and expressions of differences in inveseting
- Build the Forecast Panel for each investor. It opens as a modal when the 📊 icon is clicked on the investor card.
  Panel layout — single scrollable modal:
  Section 1 — Inputs:

  Additional monthly deposit input: "Additional monthly deposit: $___"
  Number of months input: "Over the next ___ months" (default to months remaining in current year)
  Both inputs recalculate the forecast live as the user types

  Section 2 — Projected summary:

  Header: "In [X] months..." where X is the months input
  Three stat cards side by side:

  Total deposited during forecast period (additional deposits only, not existing balance)
  Total interest earned during forecast period
  Projected balance at end of period


  All three numbers recalculate live
  Forecast logic must account for any future rate change transactions already logged — if a future transaction changes the interest rate, use the current rate up until that date then switch to the new rate for remaining months

  Section 3 — Month by month chart:

  Line chart showing balance from today through the end of the forecast period
  If monthly deposit > $0, show two lines: "With deposits" and "Without deposits"
  X axis: months, Y axis: dollar amount
  Use Chart.js

  Section 4 — Statement checkboxes:

  ☑ Include projected balance summary on statement (default on)
  ☑ Include month by month chart on statement (default on)
  These settings persist per investor in Firestore

  Save button:

  Saves monthly deposit amount, number of months, and checkbox settings to Firestore per investor
  After saving, the investor card forecast summary updates to reflect the saved values

  Statement page:

  If "Include projected balance summary" is checked, show at the bottom: "If [name] invests an additional $[X]/mo for [X] months, projected balance: $[XXX]"
  If "Include month by month chart" is checked, render the chart on the statement
  Only render what is checked