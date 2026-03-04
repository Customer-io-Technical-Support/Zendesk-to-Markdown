const DEFAULT_ACTION_TITLE = "Copy Zendesk ticket as Markdown";
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
  markdownTemplate: DEFAULT_MARKDOWN_TEMPLATE
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await runExtraction(tab.id, tab.url || "");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "runExtractionOnActiveTab") {
    return undefined;
  }

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab found." });
        return;
      }

      const result = await runExtraction(tab.id, tab.url || "");
      sendResponse(result);
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});

async function runExtraction(tabId, tabUrl) {
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
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractAndCopyTicket,
      args: [options]
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Unknown extraction error.");
    }

    await flashActionState(tabId, {
      badgeText: "OK",
      badgeColor: "#16723b",
      title: `Copied ${result.count} entries to clipboard.`
    });

    return result;
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
  const markdownTemplate =
    typeof rawOptions?.markdownTemplate === "string" && rawOptions.markdownTemplate.trim()
      ? rawOptions.markdownTemplate
      : DEFAULT_OPTIONS.markdownTemplate;

  return {
    includePrivateNotes,
    includeAttachments,
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

function extractAndCopyTicket(rawOptions) {
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
    const copied = await copyText(markdown);
    if (!copied) {
      showToast("Extraction worked, but clipboard write failed.", true);
      return { ok: false, error: "Clipboard write failed." };
    }

    showToast(`Copied ${exportData.entries.length} entries as Markdown.`);
    return {
      ok: true,
      count: exportData.entries.length,
      source: exportData.source
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
      markdownTemplate:
        typeof input?.markdownTemplate === "string" && input.markdownTemplate.trim()
          ? input.markdownTemplate
          : templateFallback
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
    const attachmentLines = (comment.attachments || [])
      .map((attachment) => {
        const url = attachment.content_url || attachment.mapped_content_url || "";
        if (!url) {
          return null;
        }
        const name = attachment.file_name || "Attachment";
        return `- [${sanitizeInline(name)}](${url})`;
      })
      .filter(Boolean);

    let body = normalizeText(comment.plain_body || comment.body || stripHtml(comment.html_body || ""));
    if (exportOptions.includeAttachments && attachmentLines.length > 0) {
      body = `${body}\n\nAttachments:\n${attachmentLines.join("\n")}`.trim();
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
    ).filter((node) => normalizeText(node.innerText || node.textContent || "").length > 0);

    const entries = [];
    let index = 1;

    for (const bodyNode of bodyNodes) {
      const container =
        bodyNode.closest(
          "article, li, [data-comment-id], [data-test-id*='comment'], [class*='comment'], [class*='note']"
        ) || bodyNode;
      const body = normalizeText(bodyNode.innerText || bodyNode.textContent || "");
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
