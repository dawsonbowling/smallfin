# SmallFin — Project Notes

## What We Built
SmallFin is a compound interest investment tracker for kids. It lets you track investments, visualize growth over time, and teach kids about the power of compound interest.

## Current State (v2.3)
- App is fully built and deployed to GitHub Pages
- Live at: **smallfin.app** (custom domain active, HTTPS in progress)
- Version number displayed in the nav (v2.0)
- Multi-bank support: each user can create and manage multiple banks

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
- ✅ Dashboard with investor cards, stats bar, rate banner
- ✅ Add/delete investors with emoji avatars (click avatar on card to change)
- ✅ Log deposits with custom date and note
- ✅ Delete individual deposits from transaction history
- ✅ Automatic compound interest — computed from deposit dates, no manual step
- ✅ Printable bank statement per investor (with projection)
- ✅ Print tip: "uncheck Headers and Footers" shown near print button
- ✅ Settings: bank name, monthly rate, bank logo (emoji picker)
- ✅ Multi-bank support: My Banks screen, create/enter/exit banks
- ✅ Nav: shows bank emoji + name when inside a bank; SmallFin logo (in white rounded box) on My Banks screen
- ✅ Nav text (bank name + "by SmallFin") hidden on My Banks screen, shown inside a bank
- ✅ Tall, substantial header (80px) with large emoji/logo
- ✅ Back to Dashboard on statement page returns to the specific bank (via sessionStorage)
- ✅ Login screen has no "Sign in to your bank" subtitle
- ✅ SmallFin logo (logo.png) on login screen
- ✅ Version number in nav header (bumped with each deploy)
- ✅ Cache-busting via ?v= query string on app.js and styles.css
- ✅ Withdrawals: "New Transaction" button opens modal with Deposit / Withdrawal toggle; withdrawals reduce balance and affect interest proration; shown in red in transaction history and statements
- ✅ Per-investor interest rates with effective dates: each investor can have their own rate history; the correct rate for each month is used when computing interest; horizontal row layout replaces card grid

## Setup & Deploy
- GitHub Pages: push to `main` → auto-deploys in ~2 minutes
- To release a new version: bump `VERSION` in `app.js` and `?v=X.X` on both the `<script>` and `<link>` tags in `index.html`
- After deploying: hard refresh (`Ctrl+Shift+R`) to bypass CDN cache if changes aren't showing

## Future Ideas
- Invite others to a bank
- Logo in upper left should have no text