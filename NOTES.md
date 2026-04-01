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
1. Verify `smallfin.app` DNS has resolved
2. Enable HTTPS for `smallfin.app` in GitHub Pages settings (Settings → Pages → Custom domain)
3. Add `smallfin.app` to Firebase authorized domains (Firebase Console → Authentication → Settings → Authorized domains)
4. Test the full app flow: log in, add a kid, verify data saves correctly

## Future Ideas
- Multi-user support: separate "banks" per family/group, with the ability to invite others
- Each bank owned by a creator, shareable via invite code or email
