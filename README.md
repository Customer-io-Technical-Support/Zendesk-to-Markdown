<img width="128" height="128" alt="image" src="https://github.com/user-attachments/assets/34ca65b9-e960-4bb1-b4ae-0198fe4837d9" />

# Zendesk Ticket to Markdown (Chrome Extension)

Chrome extension to export a Zendesk ticket conversation into clean Markdown and copy it to your clipboard or download it as a `.md` file for use in an LLM.

## What It Does

- Extracts ticket conversation content from Zendesk Agent Workspace
- Includes both public replies and private notes (configurable)
- Strips inline formatting to plain text
- Optionally includes attachment links
- Optionally includes hosted inline image URLs from replies/comments
- Copies generated Markdown to clipboard
- Downloads generated Markdown as a `.md` file
- Supports a customizable Markdown template
- Auto-converts pasted markdown (e.g. from Claude) to rich text in the Zendesk reply editor so headings, lists, paragraphs, and code blocks are preserved
- Strips inline color/background/font styling from incoming email comments so they're readable in dark mode (toggleable)

## Scope and Restrictions

- Works only on Zendesk domains: `*.zendesk.com`
- Export action is allowed only on ticket pages matching:
  - `https://<subdomain>.zendesk.com/agent/tickets/<ticket_id>`

## Project Structure

- `manifest.json` - Extension config (MV3), permissions, popup, icons
- `background.js` - Extraction orchestration and Zendesk gating
- `content.js` - Paste handler for the Zendesk reply editor: detects markdown on paste and inserts converted HTML so formatting survives
- `dark-mode-helper.js` - Strips inline `style`/`color`/`bgcolor`/`<font>` from incoming email comments so they render legibly in dark mode
- `popup.html` - Popup UI
- `popup.css` - Popup styling
- `popup.js` - Settings persistence and export trigger
- `icons/` - Extension icon assets

## Installation (Unpacked)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/aaronarich/Desktop/Support/TS Team Chrome Extensions/CIO_Ticket_To_MD_LLM`

## Usage

1. Open a Zendesk ticket page:
   - `.../agent/tickets/<id>`
2. Click the extension icon.
3. Configure options in the popup:
   - Include private notes
   - Include attachment links
   - Include inline image URLs
   - Show save dialog when downloading
   - Markdown template
4. Click **Copy Current Ticket** to copy to clipboard or **Download Markdown** to save a file.
5. Paste/upload into your LLM.

### Keyboard Shortcut

You can copy the current ticket without opening the popup by binding a Chrome shortcut:

1. Visit `chrome://extensions/shortcuts`.
2. Find **Zendesk Ticket to Markdown** → **Copy current Zendesk ticket as Markdown**.
3. Click the input and press your desired combo (e.g. `Ctrl+Shift+Y`).

When triggered on a Zendesk ticket page, the extension copies the Markdown to your clipboard and shows an in-page toast confirming success.

### Pasting Markdown Back Into Zendesk

When you paste markdown (e.g. an LLM reply) into a Zendesk reply or internal note, the extension detects markdown syntax on the clipboard and inserts the converted HTML instead, so:

- `# Heading`, `## Heading` become real headings
- `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` `` are formatted
- Bulleted (`- `, `* `, `+ `) and numbered (`1. `, `1) `) lists become real lists, including nesting by indentation, and numbered lists keep their starting number
- Fenced code blocks (```` ``` ````) become `<pre><code>` blocks
- Pipe tables become real tables, and `---` becomes a horizontal rule
- Links and bare URLs become anchors; non-navigable schemes (`javascript:`, `data:`) are left as plain text
- Blank lines become paragraph breaks (no more squashed line breaks)
- Plain text without markdown syntax pastes as usual

Toggle this behavior in the popup with **"Auto-convert markdown to rich text when pasting into Zendesk"** (on by default). A small toast appears at the bottom-right of the page when a paste is converted.

Paragraph breaks are emitted as `<br><br>` inside a block rather than as separate `<p>` elements with empty spacer blocks between them. Zendesk's composer drops empty block elements and renders `<p>` with no margin, so spacer-based approaches lose the blank lines entirely; `<br>` is preserved by the composer and by every email client that renders the outgoing reply.

### Dark Mode Helper

Incoming emails often arrive with hard-coded `color`, `background`, `<font>`, and `bgcolor` attributes that render as black-on-white blocks inside a dark Zendesk theme. The extension strips this presentational markup from comment containers (and watches for newly loaded comments via `MutationObserver`) without touching the reply composer.

Toggle this behavior in the popup with **"Strip incoming email styling for dark mode"** (on by default). Changing this setting requires reloading the Zendesk tab to take effect.

## Markdown Template Placeholders

Use these tokens in the popup template editor:

- `{{ticket_id}}`
- `{{subject}}`
- `{{url}}`
- `{{exported_at}}`
- `{{source}}`
- `{{entries_count}}`
- `{{conversation}}`

If `{{conversation}}` is omitted, the conversation block is appended automatically.

## Data Handling

- Extraction is performed from the currently open Zendesk tab.
- Uses Zendesk API data when available.
- Falls back to DOM extraction if API extraction is unavailable.
- No backend service is used by this extension.

## Permissions

- `scripting` - Inject extraction function into the active Zendesk tab
- `storage` - Save popup settings (`chrome.storage.sync`)
- `clipboardWrite` - Copy generated Markdown to clipboard
- `downloads` - Save generated Markdown as a local `.md` file
- Host permissions: `https://*.zendesk.com/*`

## Troubleshooting

- **Copy/Download buttons are disabled**:
  - Open a Zendesk ticket page on `*.zendesk.com`.
- **No content exported**:
  - Ensure the ticket conversation is visible and loaded.
  - Retry after page refresh.
- **Clipboard failure**:
  - Check browser/OS clipboard permissions and retry.
- **Download failure**:
  - Reload the extension after permission changes.
  - Confirm Chrome allows downloads for extensions.

## Development Notes

- Manifest version: MV3
- Background runtime: service worker (`background.js`)
- Declares a `copy-current-ticket` command (no default key) — bind via `chrome://extensions/shortcuts`.
