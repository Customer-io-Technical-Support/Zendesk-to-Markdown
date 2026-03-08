const DEFAULT_MARKDOWN_TEMPLATE = [
  "# Zendesk Ticket Export",
  "",
  "- Ticket ID: {{ticket_id}}",
  "- Subject: {{subject}}",
  "- URL: {{url}}",
  "- Exported At: {{exported_at}}",
  "- Source: {{source}}",
  "- Entries: {{entries_count}}",
  "",
  "## Conversation",
  "",
  "{{conversation}}"
].join("\n");

const DEFAULT_OPTIONS = {
  includePrivateNotes: true,
  includeAttachments: true,
  includeInlineImages: false,
  promptForDownloadLocation: true,
  markdownTemplate: DEFAULT_MARKDOWN_TEMPLATE
};

const includePrivateNotesEl = document.getElementById("includePrivateNotes");
const includeAttachmentsEl = document.getElementById("includeAttachments");
const includeInlineImagesEl = document.getElementById("includeInlineImages");
const promptForDownloadLocationEl = document.getElementById("promptForDownloadLocation");
const markdownTemplateEl = document.getElementById("markdownTemplate");
const saveOptionsEl = document.getElementById("saveOptions");
const resetDefaultsEl = document.getElementById("resetDefaults");
const copyNowEl = document.getElementById("copyNow");
const downloadNowEl = document.getElementById("downloadNow");
const statusMessageEl = document.getElementById("statusMessage");
const ZENDESK_TICKET_URL_PATTERN = /^https?:\/\/[^/]*\.zendesk\.com\/agent\/tickets\/\d+/i;

init().catch((error) => {
  showStatus(`Failed to load settings: ${String(error?.message || error)}`, true);
});

saveOptionsEl.addEventListener("click", async () => {
  try {
    await saveOptions();
    showStatus("Settings saved.");
  } catch (error) {
    showStatus(`Save failed: ${String(error?.message || error)}`, true);
  }
});

resetDefaultsEl.addEventListener("click", async () => {
  applyOptions(DEFAULT_OPTIONS);
  try {
    await saveOptions();
    showStatus("Defaults restored.");
  } catch (error) {
    showStatus(`Reset failed: ${String(error?.message || error)}`, true);
  }
});

copyNowEl.addEventListener("click", async () => {
  setBusy(true);
  try {
    await saveOptions();
    const result = await chrome.runtime.sendMessage({ type: "runExtractionOnActiveTab" });

    if (result?.ok) {
      showStatus(`Copied ${result.count} entries to clipboard.`);
    } else {
      showStatus(result?.error || "Extraction failed.", true);
    }
  } catch (error) {
    showStatus(`Extraction failed: ${String(error?.message || error)}`, true);
  } finally {
    setBusy(false);
  }
});

downloadNowEl.addEventListener("click", async () => {
  setBusy(true);
  try {
    await saveOptions();
    const result = await chrome.runtime.sendMessage({ type: "downloadMarkdownForActiveTab" });

    if (result?.ok) {
      const filename = result?.filename || "zendesk-ticket-export.md";
      showStatus(`Downloaded ${result.count} entries as ${filename}.`);
    } else {
      showStatus(result?.error || "Download failed.", true);
    }
  } catch (error) {
    showStatus(`Download failed: ${String(error?.message || error)}`, true);
  } finally {
    setBusy(false);
  }
});

async function init() {
  const saved = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  applyOptions(normalizeOptions(saved));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSupportedTab = Boolean(tab?.url && ZENDESK_TICKET_URL_PATTERN.test(tab.url));
  if (!isSupportedTab) {
    copyNowEl.disabled = true;
    downloadNowEl.disabled = true;
    showStatus("Open a Zendesk ticket page under *.zendesk.com to export.", true);
  }
}

function applyOptions(options) {
  includePrivateNotesEl.checked = options.includePrivateNotes;
  includeAttachmentsEl.checked = options.includeAttachments;
  includeInlineImagesEl.checked = options.includeInlineImages;
  promptForDownloadLocationEl.checked = options.promptForDownloadLocation;
  markdownTemplateEl.value = options.markdownTemplate;
}

async function saveOptions() {
  const options = normalizeOptions({
    includePrivateNotes: includePrivateNotesEl.checked,
    includeAttachments: includeAttachmentsEl.checked,
    includeInlineImages: includeInlineImagesEl.checked,
    promptForDownloadLocation: promptForDownloadLocationEl.checked,
    markdownTemplate: markdownTemplateEl.value
  });

  await chrome.storage.sync.set(options);
}

function normalizeOptions(rawOptions) {
  return {
    includePrivateNotes:
      rawOptions?.includePrivateNotes !== undefined
        ? Boolean(rawOptions.includePrivateNotes)
        : DEFAULT_OPTIONS.includePrivateNotes,
    includeAttachments:
      rawOptions?.includeAttachments !== undefined
        ? Boolean(rawOptions.includeAttachments)
        : DEFAULT_OPTIONS.includeAttachments,
    includeInlineImages:
      rawOptions?.includeInlineImages !== undefined
        ? Boolean(rawOptions.includeInlineImages)
        : DEFAULT_OPTIONS.includeInlineImages,
    promptForDownloadLocation:
      rawOptions?.promptForDownloadLocation !== undefined
        ? Boolean(rawOptions.promptForDownloadLocation)
        : DEFAULT_OPTIONS.promptForDownloadLocation,
    markdownTemplate:
      typeof rawOptions?.markdownTemplate === "string" && rawOptions.markdownTemplate.trim()
        ? rawOptions.markdownTemplate
        : DEFAULT_OPTIONS.markdownTemplate
  };
}

function setBusy(isBusy) {
  copyNowEl.disabled = isBusy;
  downloadNowEl.disabled = isBusy;
  saveOptionsEl.disabled = isBusy;
  resetDefaultsEl.disabled = isBusy;
}

function showStatus(message, isError = false) {
  statusMessageEl.textContent = message;
  statusMessageEl.classList.toggle("error", isError);
}
