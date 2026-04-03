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
