# SmallFin — Project Notes

## What We Built
SmallFin is a compound interest investment tracker for kids. It lets you track investments, visualize growth over time, and teach kids about the power of compound interest.

## Current State (v2.16)
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
- ✅ Add/delete investors with emoji avatars (click avatar on card to change)
- ✅ Log deposits/withdrawals with custom date and note ("New Transaction" modal with toggle)
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
- ✅ Forecast: desktop bottom row shows rate pill + edit + Statement (left), summary text + 📈 icon (right)
- ✅ Forecast Panel modal: editable monthly deposit + months, live projected total, saves per investor
- ✅ Forecast accounts for scheduled future rate changes (rate-aware month-by-month projection)
- ✅ Our Story and How It Works modals (nav links on desktop, hamburger menu on mobile)
- ✅ Nav: SmallFin logo on My Banks screen (no white box), bank name inside a bank
- ✅ Cache-busting via ?v= query string on app.js and styles.css

## Mobile
- ✅ Hamburger menu replaces all nav links; dropdown has My Banks, Settings, Our Story, How It Works, Sign Out
- ✅ Stats grid: 2×2 on mobile
- ✅ Investor card: 3-row stacked layout on ≤768px — avatar+name row, stats row, actions row
- ✅ Forecast row on mobile: rate+edit top-left, Statement top-right, sentence centered below with line break after "mo,"
- ✅ Date inputs replaced with Month/Day/Year select dropdowns (iOS Safari can't reliably style native date inputs)
- ✅ overflow-x: hidden on body/page to prevent horizontal scroll

## Statement Page
- ✅ Header stacks vertically on mobile
- ✅ TYPE column hidden on mobile
- ✅ Projection wording matches dashboard: "At X%/mo interest" / "My EOY forecast — end of [year]"
- ✅ If monthly deposit set: "If I invest an additional $X/mo, my EOY forecast — end of [year] — is"

## Setup & Deploy
- GitHub Pages: push to `main` → auto-deploys in ~2 minutes
- To release a new version: bump `VERSION` in `app.js` and `?v=X.X` on both the `<script>` and `<link>` tags in `index.html`
- After deploying: hard refresh (`Ctrl+Shift+R`) to bypass CDN cache if changes aren't showing

## Post-MVP Ideas
- Kid-forward design / DiceBear Avatars

## MVP Edits
- Forecasting should be $x/mo over x months equals a forecast of $x. This should be editable and save per investor.
- Forecasting should have be editable via a forecasting pop up that is signified by up upward graph emoji.
- Forcesating editor should open a panel with other cool options and expressions of differences in inveseting
2