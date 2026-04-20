# Chess Move Coach

Chess Move Coach is a standalone Chrome extension that provides independent local analysis in an extension-owned workspace, with optional import from finished Chess.com live games.

## What It Does

- opens an extension-owned analyzer page from the toolbar popup
- optionally imports the current finished Chess.com game into that analyzer
- allows manual PGN paste for user-triggered analysis
- decodes Chess.com's TCN move format into legal chess moves
- runs Stockfish locally inside the extension with no backend
- shows estimated white and black accuracy
- grades each move as `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, or `Blunder`
- draws a simple eval chart and shows the engine's best continuation

## Scope

This MVP is built for:

- `https://www.chess.com/game/live/...`
- `https://www.chess.com/analysis/game/live/...`

It is intentionally framed as a post-game analysis tool that runs outside Chess.com. If the imported Chess.com game result is still `*`, import is blocked.

## Files

- `manifest.json`: Chrome extension manifest (MV3)
- `content.js`: imports finished Chess.com games on request and powers the extension-owned analyzer page
- `overlay.css`: analyzer workspace styles reused by the extension page
- `popup.html` / `popup.js`: opens the analyzer and imports the current Chess.com game
- `analyzer.html` / `analyzer.css`: standalone analysis workspace
- `vendor-stockfish.js` / `vendor-stockfish.wasm`: local Stockfish 18 lite single-threaded engine
- `vendor-chess.js`: bundled `chess.js` used to reconstruct legal moves and SAN

## Load In Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this folder: `/Users/ted/Documents/chess-review-free`

## Notes

- The move grades and accuracy percentages are engine-based estimates, not a byte-for-byte clone of Chess.com's proprietary review formulas.
- Analysis is rendered only in the extension's own UI and is user-triggered by import or PGN paste.
- The included Stockfish engine is GPL-licensed. If you distribute this extension, keep the engine license and attribution with the project.
