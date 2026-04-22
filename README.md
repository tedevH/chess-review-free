# Chess Move Coach

Chess Move Coach is a standalone Chrome extension that analyzes user-provided PGN locally inside an extension-owned workspace.

## What It Does

- opens a standalone analyzer page from the toolbar popup
- accepts PGN pasted by the user
- runs Stockfish locally inside the extension with no backend
- shows estimated white and black accuracy
- grades each move as `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, or `Blunder`
- draws a simple eval chart and shows the engine's best continuation

## Files

- `manifest.json`: Chrome extension manifest (MV3)
- `content.js`: powers the standalone analyzer page
- `overlay.css`: analyzer workspace styles
- `popup.html` / `popup.js`: opens the analyzer page
- `analyzer.html` / `analyzer.css`: standalone analysis workspace
- `vendor-stockfish.js` / `vendor-stockfish.wasm`: bundled local Stockfish engine
- `vendor-chess.js`: bundled `chess.js` used to reconstruct legal moves and SAN

## Load In Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this folder

## Notes

- The move grades and accuracy percentages are engine-based estimates.
- Analysis is performed locally inside the extension after the user pastes a PGN.
