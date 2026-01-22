# Libby Audiobook Downloader

A Chrome extension to download audiobooks from Overdrive/Libby.

## Installation

1. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select this project folder

## Usage

1. Navigate to an Overdrive audiobook page (URL like `*.listen.overdrive.com`)
2. Click the extension icon in the toolbar (shows a green dot when on a valid page)
3. The popup will show the book title and a pre-filled folder name
4. Click "Start Download" to begin
5. The extension will:
   - Restart the audiobook from the beginning
   - Scrub through the book to trigger audio file requests
   - Download each audio file to `~/Downloads/{book-title}/`
6. Files are named sequentially: `{kebab-title}-001.mp3`, `{kebab-title}-002.mp3`, etc.

## Development

Edit files in `src/` directly (plain JavaScript with JSDoc type annotations).

After making changes, reload the extension in `chrome://extensions/`.

Optional type checking:
```bash
pnpm install
pnpm run check
```

## How It Works

- **Background Service Worker**: Intercepts network requests to audio CDN domains (`odrmediaclips.cachefly.net`, `audioclips.cdn.overdrive.com`) and downloads the full files
- **Content Script**: Extracts book title, controls the player (restart, scrub through timeline)
- **Popup**: User interface for starting/stopping downloads and viewing progress

## Notes

- The extension downloads audio files using signed URLs from Overdrive, which don't require additional authentication
- Files are saved to your default Downloads folder in a subdirectory named after the book
- The first audio request after restarting is skipped to avoid duplicate detection issues
