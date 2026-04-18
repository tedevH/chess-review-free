# Chess Review Free

Chess Review Free is a standalone Chrome extension that adds free post-game analysis to finished Chess.com live games.

## What It Does

- injects a floating `Analyze Free` button on supported Chess.com game pages
- loads the finished game move list from the page's live-game data
- decodes Chess.com's TCN move format into legal chess moves
- runs Stockfish locally inside the extension with no backend
- shows estimated white and black accuracy
- grades each move as `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, or `Blunder`
- draws a simple eval chart and shows the engine's best continuation

## Scope

This MVP is built for:

- `https://www.chess.com/game/live/...`
- `https://www.chess.com/analysis/game/live/...`

It is intentionally framed as a post-game analysis tool. If the game result is still `*`, analysis is blocked.

## Files

- `manifest.json`: Chrome extension manifest (MV3)
- `content.js`: injects the UI, fetches game data, decodes moves, runs analysis
- `overlay.css`: floating panel styles
- `popup.html`: simple popup instructions
- `vendor-stockfish.js` / `vendor-stockfish.wasm`: local Stockfish 18 lite single-threaded engine
- `vendor-chess.js`: bundled `chess.js` used to reconstruct legal moves and SAN

## Load In Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this folder: `/Users/ted/Documents/chess-review-free`

## Notes

- The move grades and accuracy percentages are engine-based estimates, not a byte-for-byte clone of Chess.com's proprietary review formulas.
- The included Stockfish engine is GPL-licensed. If you distribute this extension, keep the engine license and attribution with the project.

## Stripe Test Mode Verification

This extension now supports a local Stripe test-mode verification flow for the `$8/month` Pro subscription.

### Environment variables

Create [`stripe-test-server/.env`](/Users/changilhwang/Downloads/chess-review-free-main%202/stripe-test-server/.env.example) from the example file and set:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_WEBHOOK_SECRET`
- `APP_BASE_URL`

Recommended local value:

- `APP_BASE_URL=http://localhost:3000`

### Local server

The local verification server lives in [`stripe-test-server/server.js`](/Users/changilhwang/Downloads/chess-review-free-main%202/stripe-test-server/server.js).

It handles:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

It verifies webhook signatures with `STRIPE_WEBHOOK_SECRET` and stores a small local subscription state file under `stripe-test-server/data/`.

### Local testing steps

1. Install server dependencies:
   - `cd "/Users/changilhwang/Downloads/chess-review-free-main 2/stripe-test-server"`
   - `npm install`
2. Copy `.env.example` to `.env` and fill in your Stripe test keys and monthly Price ID.
3. Start the local Stripe test server:
   - `npm start`
4. Run the Stripe CLI listener:
   - `stripe listen --forward-to localhost:3000/api/stripe/webhook`
5. Copy the webhook signing secret printed by `stripe listen` into `STRIPE_WEBHOOK_SECRET`.
6. Refresh the Chrome extension in `chrome://extensions`.
7. If you want to verify the real Pro unlock instead of the dev bypass, set `ownerBypass` to `false` in `chrome.storage.local`.
8. Click `Upgrade with Stripe` or `View Your Chess DNA` from the extension and complete Checkout with a Stripe test card.
9. Confirm local logs show:
   - checkout session created
   - webhook received
   - event type
   - whether the user was upgraded to Pro
   - whether premium unlock logic ran
10. Reopen the extension popup or Chess DNA overlay and confirm premium features unlock.

### Testing checklist

1. Start the local app server on `localhost:3000`.
2. Run Stripe CLI:
   - `stripe listen --forward-to localhost:3000/api/stripe/webhook`
3. Use Stripe test mode and complete Checkout with a test card.
4. Confirm `checkout.session.completed` is received locally.
5. Confirm the extension user becomes `Pro`.
6. Refresh or reopen the extension and confirm premium features unlock.
7. Later, use Stripe sandbox simulations or test clocks to verify renewals and failed payments.
