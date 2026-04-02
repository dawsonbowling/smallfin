# SmallFin — Project Notes

## What We Built
SmallFin is a compound interest investment tracker for kids. It lets you track investments, visualize growth over time, and teach kids about the power of compound interest.

## Current State
- App is fully built and deployed to GitHub Pages
- Live at: https://dawsonbowling.github.io/smallfin
- Custom domain **smallfin.app** has been purchased and DNS is configured — still propagating

## Firebase
- Project ID: `smallfin-4dc4f`
- Firebase Authentication: enabled
- Firestore: enabled
- Note: currently one shared database (no per-user data isolation) — all logged-in users see the same data

## Next Steps
1. ✅ Verify `smallfin.app` DNS has resolved
2. ✅ Add `smallfin.app` to Firebase authorized domains
3. ⏳ Enable HTTPS for `smallfin.app` in GitHub Pages settings (in progress)
4. ✅ Test the full app flow — working, brother-in-law tested shared bank

## Future Ideas
- Multi-user support: separate "banks" per family/group, with the ability to invite others
- Each bank owned by a creator, shareable via invite code or email
- ✅ Printable version shows tip to uncheck "Headers and Footers" (can't be done programmatically)
- ✅ Interest banner auto-prompts on 1st of new month if interest hasn't been applied
- Allow Manual return application per investor at specific date in past or future
- Create Accounts
- Create New Bank
- Select Bank Logo from Selection
- Select Avatar for Investor Photo from selection
- Upper left has Inputted bank name with smaller "by SmallFin"
