# SmallFin — Project Notes

## What We Built
SmallFin is a compound interest investment tracker for kids. It lets you track investments, visualize growth over time, and teach kids about the power of compound interest.

## Current State (v1.3)
- App is fully built and deployed to GitHub Pages
- Live at: **smallfin.app** (custom domain active, HTTPS in progress)
- Version number displayed in the nav (v1.2)

## Firebase
- Project ID: `smallfin-4dc4f`
- Firebase Authentication: enabled
- Firestore: enabled
- Shared database — all logged-in users see the same bank (by design for now)

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
- ✅ Nav shows bank logo + name with "by SmallFin" subtitle
- ✅ SmallFin logo (logo.png) on login screen
- ✅ Version number in nav header (bumped with each deploy)
- ✅ Cache-busting via ?v= query string on app.js

## Setup & Deploy
- GitHub Pages: push to `main` → auto-deploys in ~2 minutes
- To release a new version: bump `VERSION` in `app.js` and `?v=X.X` in the `<script>` tag in `index.html`

## Future Ideas
- Multi-user support: separate "banks" per family/group, with the ability to invite others
- Each bank owned by a creator, shareable via invite code or email
- Allow manual return application per investor at a specific date (past or future)
- Create Accounts / Create New Bank flow
- ✅ SmallFin logo on login screen
- Select Avatar for Investor Photo from a larger selection
