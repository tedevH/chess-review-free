# Chess Analysis Studio

Chess Analysis Studio is a standalone Chrome extension for local chess analysis with visible PGN input and optional one-click game import.

## What It Does

- opens a standalone analyzer page from the toolbar popup
- optionally imports a game from the active page on user click
- accepts PGN pasted by the user
- accepts uploaded PGN files
- runs Stockfish locally inside the extension with no backend
- shows estimated white and black accuracy
- grades each move as `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, or `Blunder`
- draws a simple eval chart and shows the engine's best continuation

## Files

- `manifest.json`: Chrome extension manifest (MV3)
- `content.js`: powers the standalone analyzer page and loads pending input
- `overlay.css`: analyzer workspace styles
- `popup.html` / `popup.js`: opens the analyzer and performs user-triggered game import
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
- Analysis is performed locally inside the extension after PGN input or user-triggered import.
