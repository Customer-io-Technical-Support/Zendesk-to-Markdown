const DEFAULT_ACTION_TITLE = "Export Zendesk ticket as Markdown";
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
  autoConvertMarkdownPaste: true,
  darkModeHelperEnabled: true,
  markdownTemplate: DEFAULT_MARKDOWN_TEMPLATE
};
const MESSAGE_TYPE_COPY = "runExtractionOnActiveTab";
const MESSAGE_TYPE_DOWNLOAD = "downloadMarkdownForActiveTab";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await runExtraction(tab.id, tab.url || "");
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "copy-current-ticket") {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }

  await runExtraction(tab.id, tab.url || "", "copy");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (![MESSAGE_TYPE_COPY, MESSAGE_TYPE_DOWNLOAD].includes(message?.type)) {
    return undefined;
  }

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab found." });
        return;
      }

      const mode = message.type === MESSAGE_TYPE_DOWNLOAD ? "download" : "copy";
      const prompt = typeof message.prompt === "string" ? message.prompt : "";
      const result = await runExtraction(tab.id, tab.url || "", mode, prompt);
      sendResponse(result);
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

async function runExtraction(tabId, tabUrl, mode = "copy", prompt = "") {
  if (!isZendeskTicketUrl(tabUrl)) {
    const message = "Open a Zendesk ticket page first (example: /agent/tickets/12345).";
    await flashActionState(tabId, {
      badgeText: "N/A",
      badgeColor: "#b54708",
      title: message
    });
    return { ok: false, error: message };
  }

  try {
    const options = await getOptions();
    const copyToClipboard = mode !== "download";
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractTicket,
      args: [options, { copyToClipboard, prompt }]
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Unknown extraction error.");
    }

    let filename = "";
    if (!copyToClipboard) {
      if (typeof result.markdown !== "string" || !result.markdown.trim()) {
        throw new Error("Extraction completed, but no Markdown output was returned.");
      }
      filename = buildDownloadFilename(result);
      await startMarkdownDownload(
        result.markdown,
        filename,
        options.promptForDownloadLocation !== false
      );
    }

    const actionTitle = copyToClipboard
      ? `Copied ${result.count} entries to clipboard.`
      : `Downloaded ${result.count} entries as ${filename}.`;
    await flashActionState(tabId, {
      badgeText: copyToClipboard ? "OK" : "DL",
      badgeColor: copyToClipboard ? "#16723b" : "#1d4ed8",
      title: actionTitle
    });

    const response = {
      ok: true,
      count: result.count,
      source: result.source,
      ticketId: result.ticketId,
      subject: result.subject || "",
      exportedAt: result.exportedAt,
      url: result.url
    };
    if (filename) {
      response.filename = filename;
    }
    return response;
  } catch (error) {
    console.error("Zendesk extraction failed:", error);
    await flashActionState(tabId, {
      badgeText: "ERR",
      badgeColor: "#b42318",
      title: `Extraction failed: ${error.message}`
    });
    return { ok: false, error: error.message };
  }
}

function isZendeskTicketUrl(url) {
  return /^https?:\/\/[^/]*\.zendesk\.com\/agent\/tickets\/\d+/i.test(url);
}

async function getOptions() {
  const saved = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  return normalizeOptions(saved);
}

function normalizeOptions(rawOptions) {
  const includePrivateNotes =
    rawOptions?.includePrivateNotes !== undefined
      ? Boolean(rawOptions.includePrivateNotes)
      : DEFAULT_OPTIONS.includePrivateNotes;
  const includeAttachments =
    rawOptions?.includeAttachments !== undefined
      ? Boolean(rawOptions.includeAttachments)
      : DEFAULT_OPTIONS.includeAttachments;
  const includeInlineImages =
    rawOptions?.includeInlineImages !== undefined
      ? Boolean(rawOptions.includeInlineImages)
      : DEFAULT_OPTIONS.includeInlineImages;
  const promptForDownloadLocation =
    rawOptions?.promptForDownloadLocation !== undefined
      ? Boolean(rawOptions.promptForDownloadLocation)
      : DEFAULT_OPTIONS.promptForDownloadLocation;
  const autoConvertMarkdownPaste =
    rawOptions?.autoConvertMarkdownPaste !== undefined
      ? Boolean(rawOptions.autoConvertMarkdownPaste)
      : DEFAULT_OPTIONS.autoConvertMarkdownPaste;
  const darkModeHelperEnabled =
    rawOptions?.darkModeHelperEnabled !== undefined
      ? Boolean(rawOptions.darkModeHelperEnabled)
      : DEFAULT_OPTIONS.darkModeHelperEnabled;
  const markdownTemplate =
    typeof rawOptions?.markdownTemplate === "string" && rawOptions.markdownTemplate.trim()
      ? rawOptions.markdownTemplate
      : DEFAULT_OPTIONS.markdownTemplate;

  return {
    includePrivateNotes,
    includeAttachments,
    includeInlineImages,
    promptForDownloadLocation,
    autoConvertMarkdownPaste,
    darkModeHelperEnabled,
    markdownTemplate
  };
}

async function flashActionState(tabId, state) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: state.badgeColor });
  await chrome.action.setBadgeText({ tabId, text: state.badgeText });
  await chrome.action.setTitle({ tabId, title: state.title });

  setTimeout(async () => {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
  }, 4000);
}

function buildDownloadFilename(result) {
  const ticketId = sanitizeFilenamePart(result?.ticketId || "") || "unknown-ticket";
  const subject = sanitizeFilenamePart(result?.subject || "");
  const dateStamp = getDateStamp(result?.exportedAt);
  const parts = [`zendesk-ticket-${ticketId}`];
  if (subject) {
    parts.push(subject);
  }
  if (dateStamp) {
    parts.push(dateStamp);
  }
  return `${parts.join("-")}.md`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function getDateStamp(rawDate) {
  const date = new Date(rawDate || Date.now());
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function startMarkdownDownload(markdown, filename, saveAs = true) {
  const text = String(markdown || "");
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: "uniquify",
    saveAs
  });
  if (typeof downloadId !== "number") {
    throw new Error("Browser did not start the download.");
  }
}

function extractTicket(rawOptions, rawRunOptions) {
  return (async () => {
    const defaultTemplate = [
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
    const options = sanitizeOptions(rawOptions, defaultTemplate);
    const runOptions = sanitizeRunOptions(rawRunOptions);

    const ticketId = getTicketIdFromPath();
    if (!ticketId) {
      showToast("Could not determine the ticket ID from the current URL.", true);
      return { ok: false, error: "Could not determine ticket ID from URL." };
    }

    let exportData;
    try {
      exportData = await buildExportFromApi(ticketId, options);
    } catch (apiError) {
      exportData = buildExportFromDom(ticketId, options);
      exportData.source = "DOM fallback";
      if (exportData.entries.length === 0) {
        showToast("Unable to extract ticket comments from this page.", true);
        return {
          ok: false,
          error: `Zendesk API failed (${apiError.message}) and DOM fallback found no entries.`
        };
      }
    }

    if (exportData.entries.length === 0) {
      showToast("No comments matched your export filters.", true);
      return {
        ok: false,
        error: "No comments matched your export filters."
      };
    }

    const markdown = renderMarkdown(exportData, options);
    if (runOptions.copyToClipboard) {
      const clipboardText = runOptions.prompt
        ? `${runOptions.prompt}\n\n${markdown}`
        : markdown;
      const copied = await copyText(clipboardText);
      if (!copied) {
        showToast("Extraction worked, but clipboard write failed.", true);
        return { ok: false, error: "Clipboard write failed." };
      }

      showToast(`Copied ${exportData.entries.length} entries as Markdown.`);
    } else {
      showToast(`Prepared ${exportData.entries.length} entries for download.`);
    }

    return {
      ok: true,
      count: exportData.entries.length,
      source: exportData.source,
      markdown,
      ticketId: exportData.ticketId,
      subject: exportData.subject || "",
      exportedAt: exportData.exportedAt,
      url: exportData.url
    };
  })();

  function getTicketIdFromPath() {
    const match = window.location.pathname.match(/\/agent\/tickets\/(\d+)/i);
    return match ? match[1] : null;
  }

  function sanitizeOptions(input, templateFallback) {
    return {
      includePrivateNotes:
        input?.includePrivateNotes !== undefined ? Boolean(input.includePrivateNotes) : true,
      includeAttachments:
        input?.includeAttachments !== undefined ? Boolean(input.includeAttachments) : true,
      includeInlineImages:
        input?.includeInlineImages !== undefined ? Boolean(input.includeInlineImages) : false,
      markdownTemplate:
        typeof input?.markdownTemplate === "string" && input.markdownTemplate.trim()
          ? input.markdownTemplate
          : templateFallback
    };
  }

  function sanitizeRunOptions(input) {
    return {
      copyToClipboard: input?.copyToClipboard !== false,
      prompt: typeof input?.prompt === "string" ? input.prompt.trim() : ""
    };
  }

  async function buildExportFromApi(ticketIdValue, exportOptions) {
    const [ticketPayload, comments] = await Promise.all([
      fetchJson(`/api/v2/tickets/${ticketIdValue}.json`),
      fetchAllComments(ticketIdValue)
    ]);

    if (comments.length === 0) {
      throw new Error("No comments returned by Zendesk API.");
    }

    comments.sort((a, b) => {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });

    const userNames = await fetchUserNames(
      comments.map((comment) => comment.author_id).filter((id) => id !== null && id !== undefined)
    );

    const entries = comments
      .map((comment) => normalizeComment(comment, userNames, exportOptions))
      .filter((entry) => entry.body.length > 0)
      .filter((entry) => shouldIncludeEntry(entry, exportOptions));

    return {
      source: "Zendesk API",
      ticketId: ticketIdValue,
      subject: ticketPayload?.ticket?.subject || getSubjectFromPage(),
      url: window.location.href,
      exportedAt: new Date().toISOString(),
      entries
    };
  }

  async function fetchAllComments(ticketIdValue) {
    const results = [];
    const seen = new Set();
    let nextUrl = `/api/v2/tickets/${ticketIdValue}/comments.json?page[size]=100`;

    while (nextUrl && !seen.has(nextUrl)) {
      seen.add(nextUrl);
      const payload = await fetchJson(nextUrl);
      if (Array.isArray(payload.comments)) {
        results.push(...payload.comments);
      }

      nextUrl = resolveNextPage(payload);
    }

    return results;
  }

  async function fetchUserNames(authorIds) {
    const ids = [...new Set(authorIds.map((id) => String(id)))];
    const names = new Map();

    for (const idChunk of chunk(ids, 100)) {
      try {
        const payload = await fetchJson(
          `/api/v2/users/show_many.json?ids=${encodeURIComponent(idChunk.join(","))}`
        );
        for (const user of payload.users || []) {
          names.set(String(user.id), user.name || user.email || `User ${user.id}`);
        }
      } catch (_error) {
        // User enrichment is best effort only.
      }
    }

    return names;
  }

  function normalizeComment(comment, userNames, exportOptions) {
    const attachments = (comment.attachments || [])
      .map((attachment) => {
        const url = normalizeHttpUrl(attachment.content_url || attachment.mapped_content_url || "");
        if (!url) {
          return null;
        }
        const name = attachment.file_name || "Attachment";
        return {
          url,
          line: `- [${sanitizeInline(name)}](${url})`
        };
      })
      .filter(Boolean);
    const attachmentLines = attachments.map((attachment) => attachment.line);
    const attachmentUrls = new Set(attachments.map((attachment) => attachment.url));

    let body = normalizeText(comment.plain_body || comment.body || stripHtml(comment.html_body || ""));
    if (exportOptions.includeInlineImages) {
      const inlineImageExclusions = exportOptions.includeAttachments ? attachmentUrls : new Set();
      const inlineImages = extractInlineImagesFromHtml(comment.html_body || "", inlineImageExclusions);
      body = appendSection(body, "Inline images:", renderInlineImageLines(inlineImages));
    }
    if (exportOptions.includeAttachments && attachmentLines.length > 0) {
      body = appendSection(body, "Attachments:", attachmentLines);
    }

    return {
      id: comment.id,
      type: comment.public ? "Public reply" : "Private note",
      author:
        userNames.get(String(comment.author_id)) ||
        (comment.author_id !== undefined ? `User ${comment.author_id}` : "Unknown"),
      timestamp: formatTimestamp(comment.created_at),
      body
    };
  }

  function shouldIncludeEntry(entry, exportOptions) {
    if (exportOptions.includePrivateNotes) {
      return true;
    }
    return entry.type !== "Private note";
  }

  function buildExportFromDom(ticketIdValue, exportOptions) {
    const selectors = [
      "[data-test-id*='comment-body']",
      "[data-test-id*='message-content']",
      "[data-testid*='comment-body']",
      "[data-testid*='message-content']",
      "[data-comment-body]",
      ".zd-comment",
      ".comment-body",
      "[class*='commentBody']",
      "[class*='comment-body']",
      "[class*='private-note']",
      "[class*='public-reply']"
    ];

    const bodyNodes = unique(
      selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    ).filter((node) => {
      if (normalizeText(node.innerText || node.textContent || "").length > 0) {
        return true;
      }
      return exportOptions.includeInlineImages && Boolean(node.querySelector("img"));
    });

    const entries = [];
    let index = 1;

    for (const bodyNode of bodyNodes) {
      const container =
        bodyNode.closest(
          "article, li, [data-comment-id], [data-test-id*='comment'], [class*='comment'], [class*='note']"
        ) || bodyNode;
      let body = normalizeText(bodyNode.innerText || bodyNode.textContent || "");
      if (exportOptions.includeInlineImages) {
        const inlineImages = extractInlineImagesFromElement(bodyNode);
        body = appendSection(body, "Inline images:", renderInlineImageLines(inlineImages));
      }
      if (!body) {
        continue;
      }

      const entry = {
        id: `dom-${index}`,
        type: detectType(container),
        author: detectAuthor(container, bodyNode),
        timestamp: detectTimestamp(container),
        body
      };

      if (shouldIncludeEntry(entry, exportOptions)) {
        entries.push(entry);
      }

      index += 1;
    }

    return {
      source: "DOM",
      ticketId: ticketIdValue,
      subject: getSubjectFromPage(),
      url: window.location.href,
      exportedAt: new Date().toISOString(),
      entries: dedupeEntries(entries)
    };
  }

  function dedupeEntries(entries) {
    const seen = new Set();
    const result = [];

    for (const entry of entries) {
      const key = `${entry.type}|${entry.author}|${entry.timestamp}|${entry.body}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
    }

    return result;
  }

  function detectType(container) {
    const haystack = `${container.className || ""} ${container.textContent || ""}`.toLowerCase();
    if (haystack.includes("private note") || haystack.includes("internal note")) {
      return "Private note";
    }
    if (haystack.includes("public reply") || haystack.includes("public comment")) {
      return "Public reply";
    }
    return "Comment";
  }

  function detectAuthor(container, bodyNode) {
    const selectors = [
      "[data-test-id*='author']",
      "[data-testid*='author']",
      "[class*='author']",
      "header strong",
      "header span",
      "strong",
      "h4",
      "h3"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(container.querySelectorAll(selector));
      for (const node of nodes) {
        if (bodyNode.contains(node)) {
          continue;
        }

        const text = sanitizeInline(node.textContent || "");
        if (!text || text.length > 80) {
          continue;
        }
        if (/(public|private|note|reply|comment)$/i.test(text)) {
          continue;
        }
        return text;
      }
    }

    return "Unknown";
  }

  function detectTimestamp(container) {
    const timeEl = container.querySelector("time");
    if (timeEl) {
      const raw = timeEl.getAttribute("datetime") || timeEl.textContent || "";
      return formatTimestamp(raw);
    }

    const candidates = [
      "[data-test-id*='time']",
      "[data-testid*='time']",
      "[class*='time']",
      "[class*='timestamp']"
    ];
    for (const selector of candidates) {
      const node = container.querySelector(selector);
      const text = sanitizeInline(node?.textContent || "");
      if (text) {
        return text;
      }
    }

    return "";
  }

  function getSubjectFromPage() {
    const selectors = [
      "[data-test-id='ticket-subject']",
      "[data-test-id*='subject']",
      "[data-testid='ticket-subject']",
      "[data-testid*='subject']",
      "h1"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = sanitizeInline(node?.textContent || "");
      if (text) {
        return text;
      }
    }

    return sanitizeInline(document.title.replace(/\s*[-|]\s*Zendesk.*$/i, ""));
  }

  function renderMarkdown(payload, exportOptions) {
    const conversation = renderConversation(payload.entries);
    let output = exportOptions.markdownTemplate;
    const replacements = {
      ticket_id: sanitizeInline(payload.ticketId),
      subject: sanitizeInline(payload.subject || "(No subject)"),
      url: payload.url,
      exported_at: payload.exportedAt,
      source: payload.source,
      entries_count: String(payload.entries.length),
      conversation
    };

    for (const [token, value] of Object.entries(replacements)) {
      output = output.split(`{{${token}}}`).join(value);
    }

    if (!exportOptions.markdownTemplate.includes("{{conversation}}")) {
      output = `${output.trim()}\n\n${conversation}`;
    }

    return `${output.replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  function renderConversation(entries) {
    const lines = [];

    entries.forEach((entry, index) => {
      lines.push(`### ${index + 1}. ${sanitizeInline(entry.type)}`);
      lines.push(`- Author: ${sanitizeInline(entry.author)}`);
      if (entry.timestamp) {
        lines.push(`- Timestamp: ${sanitizeInline(entry.timestamp)}`);
      }
      lines.push("");
      lines.push(entry.body);
      lines.push("");
      lines.push("---");
      lines.push("");
    });

    return lines.join("\n").trim();
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        // Fall through to execCommand fallback.
      }
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (_error) {
      copied = false;
    }

    textArea.remove();
    return copied;
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function resolveNextPage(payload) {
    const next = payload?.links?.next || payload?.next_page || null;
    if (!next) {
      return null;
    }

    try {
      const parsed = new URL(next, window.location.origin);
      return `${parsed.pathname}${parsed.search}`;
    } catch (_error) {
      return null;
    }
  }

  function chunk(values, size) {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body?.textContent || "";
  }

  function extractInlineImagesFromHtml(html, excludedUrls = new Set()) {
    if (!html || typeof html !== "string") {
      return [];
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    return extractInlineImagesFromElement(doc.body, excludedUrls);
  }

  function extractInlineImagesFromElement(root, excludedUrls = new Set()) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }

    const images = [];
    for (const imageNode of root.querySelectorAll("img")) {
      const url = resolveInlineImageUrl(imageNode);
      if (!url || excludedUrls.has(url)) {
        continue;
      }
      images.push({
        url,
        alt: sanitizeInline(imageNode.getAttribute("alt") || "")
      });
    }

    const deduped = [];
    const seenUrls = new Set();
    for (const image of images) {
      if (seenUrls.has(image.url)) {
        continue;
      }
      seenUrls.add(image.url);
      deduped.push(image);
    }

    return deduped;
  }

  function resolveInlineImageUrl(imageNode) {
    const candidates = [
      imageNode.getAttribute("src"),
      imageNode.getAttribute("data-src"),
      imageNode.getAttribute("data-original-src"),
      imageNode.getAttribute("data-mce-src"),
      imageNode.closest("a[href]")?.getAttribute("href")
    ];

    for (const candidate of candidates) {
      const url = normalizeHttpUrl(candidate);
      if (url) {
        return url;
      }
    }

    return "";
  }

  function normalizeHttpUrl(rawUrl) {
    const candidate = String(rawUrl || "").trim();
    if (!candidate) {
      return "";
    }

    try {
      const parsed = new URL(candidate, window.location.href);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return "";
      }
      return parsed.href;
    } catch (_error) {
      return "";
    }
  }

  function renderInlineImageLines(images) {
    return images.map((image, index) => {
      const fallbackAlt = `Inline image ${index + 1}`;
      return `- ![${escapeMarkdownAlt(image.alt || fallbackAlt)}](${image.url})`;
    });
  }

  function escapeMarkdownAlt(value) {
    return sanitizeInline(value).replace(/[[\]\\]/g, "\\$&");
  }

  function appendSection(body, heading, lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return normalizeText(body);
    }

    const normalizedBody = normalizeText(body);
    const section = `${heading}\n${lines.join("\n")}`;
    return normalizedBody ? `${normalizedBody}\n\n${section}` : section;
  }

  function formatTimestamp(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return sanitizeInline(String(value));
    }
    return date.toISOString();
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sanitizeInline(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function unique(elements) {
    return [...new Set(elements)];
  }

  function showToast(message, isError = false) {
    const existing = document.getElementById("zendesk-md-export-toast");
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement("div");
    toast.id = "zendesk-md-export-toast";
    toast.textContent = message;
    toast.style.position = "fixed";
    toast.style.bottom = "16px";
    toast.style.right = "16px";
    toast.style.zIndex = "2147483647";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "8px";
    toast.style.fontSize = "13px";
    toast.style.fontWeight = "600";
    toast.style.background = isError ? "#fef3f2" : "#ecfdf3";
    toast.style.color = isError ? "#b42318" : "#067647";
    toast.style.border = `1px solid ${isError ? "#fecdca" : "#abefc6"}`;
    toast.style.boxShadow = "0 6px 16px rgba(0, 0, 0, 0.2)";
    toast.style.maxWidth = "340px";
    toast.style.fontFamily =
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }
}
