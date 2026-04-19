## Chess DNA Archive

This archive preserves the removed Chess DNA / Chess Profile feature so it can be restored later without keeping any active runtime hooks in the published extension.

### What the archived feature included

- Premium Chess DNA profile UI and copy
- In-page profile overlay flow
- Popup CTA and locked-state premium upsell
- Local game history storage helpers
- Chess DNA aggregation and profile summary logic
- Stripe test-mode verification server and related notes

### Archived files

Feature files:

- `feature-files/profile.html`
- `feature-files/profile.js`
- `feature-files/stats.js`
- `feature-files/storage.js`

Integration snapshots from the live extension before cleanup:

- `integration-snapshots/background.js`
- `integration-snapshots/content.js`
- `integration-snapshots/overlay.css`
- `integration-snapshots/popup.html`
- `integration-snapshots/popup.js`
- `integration-snapshots/manifest.json`
- `integration-snapshots/README.md`

Stripe local test server snapshot:

- `stripe-test-server/package.json`
- `stripe-test-server/.env.example`
- `stripe-test-server/server.js`

### Active files that were cleaned

- `content.js`
- `overlay.css`
- `popup.html`
- `manifest.json`
- `README.md`

### Active files that were removed

- `background.js`
- `popup.js`
- `profile.html`
- `profile.js`
- `stats.js`
- `storage.js`
- `stripe-test-server/`

### What was disconnected from runtime

- Chess DNA button and premium CTA UI
- Chess DNA modal / overlay
- Chess DNA page and embedded iframe flow
- Background message handlers for profile access and review saving
- Storage writes and reads for saved DNA/profile data
- Manifest references to profile and premium helper files
- Stripe test-mode server files from the active extension folder

### How to restore later

1. Copy the archived feature files back into the extension root.
2. Reapply the integration pieces from `integration-snapshots/` into:
   - `content.js`
   - `overlay.css`
   - `popup.html`
   - `popup.js`
   - `background.js`
   - `manifest.json`
3. Restore the storage/profile helper files and any web-accessible resource entries.
4. If you want Stripe test-mode verification again, restore the archived `stripe-test-server/` folder and its README setup.
5. Reload the extension and test the profile flow end to end.

The active extension is now intentionally disconnected from all Chess DNA/Profile runtime paths.
