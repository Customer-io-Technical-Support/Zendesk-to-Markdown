(() => {
  const STORAGE_KEY = "autoConvertMarkdownPaste";
  const BLOCK_MARK = "";
  const INLINE_MARK = "";
  let enabled = true;

  if (chrome?.storage?.sync) {
    chrome.storage.sync.get({ [STORAGE_KEY]: true }, (result) => {
      enabled = result?.[STORAGE_KEY] !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[STORAGE_KEY]) {
        enabled = changes[STORAGE_KEY].newValue !== false;
      }
    });
  }

  document.addEventListener("paste", handlePaste, true);

  function handlePaste(event) {
    if (!enabled) return;
    if (event.__zdMdReentry) return;

    const editable = findEditableAncestor(event.target);
    if (!editable) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const text = clipboard.getData("text/plain");
    if (!text || !looksLikeMarkdown(text)) return;

    const html = markdownToHtml(text);
    if (!html) return;

    event.preventDefault();
    event.stopPropagation();

    if (dispatchSyntheticPaste(editable, html, text)) {
      showToast("Pasted markdown as rich text.");
      return;
    }

    if (insertHtmlAtSelection(html)) {
      showToast("Pasted markdown as rich text.");
      return;
    }

    showToast("Couldn't insert markdown — pasting plain text instead.", true);
    insertPlainTextAtSelection(text);
  }

  function findEditableAncestor(node) {
    let el = node;
    if (el && el.nodeType === 3) el = el.parentElement;
    while (el && el.nodeType === 1) {
      if (el.isContentEditable) return el;
      const tag = el.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return null;
      el = el.parentElement;
    }
    return null;
  }

  function dispatchSyntheticPaste(editable, html, text) {
    try {
      if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") {
        return false;
      }
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      dt.setData("text/plain", text);
      const synth = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      synth.__zdMdReentry = true;
      const notCancelled = editable.dispatchEvent(synth);
      return notCancelled === false;
    } catch (_error) {
      return false;
    }
  }

  function insertHtmlAtSelection(html) {
    try {
      if (document.execCommand("insertHTML", false, html)) return true;
    } catch (_error) {
      // fall through
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const template = document.createElement("template");
    template.innerHTML = html;
    const fragment = template.content;
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.setEndAfter(lastNode);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  function insertPlainTextAtSelection(text) {
    try {
      document.execCommand("insertText", false, text);
    } catch (_error) {
      // best effort
    }
  }

  function looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;
    const patterns = [
      /^#{1,6}\s+\S/m,
      /^\s*[-*+]\s+\S/m,
      /^\s*\d+\.\s+\S/m,
      /^```/m,
      /\*\*[^*\n]+\*\*/,
      /\[[^\]]+\]\([^)\s]+\)/,
      /^>\s+\S/m,
      /(^|\s)`[^`\n]+`/
    ];
    for (const pattern of patterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  function markdownToHtml(markdown) {
    let src = String(markdown || "").replace(/\r\n?/g, "\n");

    const codeBlocks = [];
    src = src.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: String(lang || "").trim(), code });
      return BLOCK_MARK + "B" + idx + BLOCK_MARK;
    });

    const lines = src.split("\n");
    const out = [];
    let i = 0;
    const blockLineRe = new RegExp("^" + BLOCK_MARK + "B(\\d+)" + BLOCK_MARK + "$");

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }

      const blockMatch = line.match(blockLineRe);
      if (blockMatch) {
        const block = codeBlocks[Number(blockMatch[1])];
        const langAttr = block.lang ? ` class="language-${escapeAttr(block.lang)}"` : "";
        out.push(`<pre><code${langAttr}>${escapeHtml(block.code)}</code></pre>`);
        i += 1;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        const inner = quoteLines.map((l) => renderInline(l)).join("<br>");
        out.push(`<blockquote>${inner}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+\S/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+\S/.test(lines[i])) {
          let item = lines[i].replace(/^\s*[-*+]\s+/, "");
          i += 1;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
            item += "\n" + lines[i].replace(/^\s+/, "");
            i += 1;
          }
          items.push(`<li>${renderInline(item).replace(/\n/g, "<br>")}</li>`);
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      if (/^\s*\d+\.\s+\S/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+\S/.test(lines[i])) {
          let item = lines[i].replace(/^\s*\d+\.\s+/, "");
          i += 1;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
            item += "\n" + lines[i].replace(/^\s+/, "");
            i += 1;
          }
          items.push(`<li>${renderInline(item).replace(/\n/g, "<br>")}</li>`);
        }
        out.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      const para = [line];
      i += 1;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s+\S/.test(lines[i]) &&
        !/^\s*\d+\.\s+\S/.test(lines[i]) &&
        !blockLineRe.test(lines[i])
      ) {
        para.push(lines[i]);
        i += 1;
      }
      const html = para.map((l) => renderInline(l)).join("<br>");
      out.push(`<div>${html}</div>`);
    }

    return out.join("<div><br></div>");
  }

  function renderInline(text) {
    let s = escapeHtml(text);

    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_match, code) => {
      const idx = codes.length;
      codes.push(code);
      return INLINE_MARK + "C" + idx + INLINE_MARK;
    });

    const links = [];
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label, url) => {
      const idx = links.length;
      links.push({ label, url });
      return INLINE_MARK + "L" + idx + INLINE_MARK;
    });

    s = s.replace(/(^|[\s(\[])(https?:\/\/[^\s<>"']+)/g, (_m, lead, url) => {
      let trail = "";
      while (/[).,;:!?\]]$/.test(url)) {
        trail = url.slice(-1) + trail;
        url = url.slice(0, -1);
      }
      return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
    });

    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__([^_\n]+)__(?!\w)/g, "$1<strong>$2</strong>");

    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");

    const linkRe = new RegExp(INLINE_MARK + "L(\\d+)" + INLINE_MARK, "g");
    s = s.replace(linkRe, (_m, idx) => {
      const link = links[Number(idx)];
      return `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.label}</a>`;
    });

    const codeRe = new RegExp(INLINE_MARK + "C(\\d+)" + INLINE_MARK, "g");
    s = s.replace(codeRe, (_m, idx) => `<code>${codes[Number(idx)]}</code>`);

    return s;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function showToast(message, isError = false) {
    const existing = document.getElementById("zendesk-md-paste-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "zendesk-md-paste-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "16px",
      right: "16px",
      zIndex: "2147483647",
      padding: "8px 12px",
      borderRadius: "8px",
      fontSize: "12px",
      fontWeight: "600",
      background: isError ? "#fef3f2" : "#ecfdf3",
      color: isError ? "#b42318" : "#067647",
      border: `1px solid ${isError ? "#fecdca" : "#abefc6"}`,
      boxShadow: "0 6px 16px rgba(0, 0, 0, 0.2)",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
  }
})();
