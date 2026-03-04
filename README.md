<img width="128" height="128" alt="image" src="https://github.com/user-attachments/assets/34ca65b9-e960-4bb1-b4ae-0198fe4837d9" />

# Zendesk Ticket to Markdown (Chrome Extension)

Chrome extension to export a Zendesk ticket conversation into clean Markdown and copy it to your clipboard for use in an LLM.

## What It Does

- Extracts ticket conversation content from Zendesk Agent Workspace
- Includes both public replies and private notes (configurable)
- Strips inline formatting to plain text
- Optionally includes attachment links
- Copies generated Markdown to clipboard
- Supports a customizable Markdown template

## Scope and Restrictions

- Works only on Zendesk domains: `*.zendesk.com`
- Export action is allowed only on ticket pages matching:
  - `https://<subdomain>.zendesk.com/agent/tickets/<ticket_id>`

## Project Structure

- `manifest.json` - Extension config (MV3), permissions, popup, icons
- `background.js` - Extraction orchestration and Zendesk gating
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
   - Markdown template
4. Click **Copy Current Ticket**.
5. Paste into your LLM.

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
- Host permissions: `https://*.zendesk.com/*`

## Troubleshooting

- **Copy button is disabled**:
  - Open a Zendesk ticket page on `*.zendesk.com`.
- **No content exported**:
  - Ensure the ticket conversation is visible and loaded.
  - Retry after page refresh.
- **Clipboard failure**:
  - Check browser/OS clipboard permissions and retry.

## Development Notes

- Manifest version: MV3
- Background runtime: service worker (`background.js`)
- No keyboard shortcut is configured.
