(() => {
  const STORAGE_KEY = "autoConvertMarkdownPaste";
  const BLOCK_MARK = "";
  const INLINE_MARK = "";
  // Zendesk's composer styles .ck-content p with margin:0, so adjacent <p>
  // elements render with no blank line between them. Zendesk's own
  // markdown-on-paste handler works around this by emitting an explicit
  // <p>&nbsp;</p> between every pair of top-level blocks, and its paste
  // pipeline passes those spacers through untouched. Matching that format is
  // what keeps blank lines visible in the composer and in the outgoing email.
  // Verified against CKEditor 45.2.1 in the Zendesk agent workspace.
  const BLOCK_SPACER = "<p>&nbsp;</p>";
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
    if (!text || !shouldConvertOnPaste(text)) return;

    const html = markdownToHtml(text);
    if (!html) return;

    event.preventDefault();
    event.stopPropagation();

    if (dispatchSyntheticPaste(editable, html, text)) {
      showToast("Pasted with formatting.");
      return;
    }

    const contentBefore = editable.innerHTML;
    if (insertHtmlAtSelection(html)) {
      confirmInsertion(editable, contentBefore, text);
      return;
    }

    showToast("Couldn't insert formatted paste — using plain text.", true);
    insertPlainTextAtSelection(text);
  }

  // Model-backed editors (CKEditor in the Zendesk composer) re-render from
  // their model on the next microtask and discard any DOM inserted behind their
  // back, yet execCommand still reports success. Confirm the content actually
  // stuck before claiming the paste worked, so a silently dropped paste falls
  // back to plain text instead of looking like it succeeded.
  function confirmInsertion(editable, contentBefore, text) {
    requestAnimationFrame(() => {
      if (editable.innerHTML !== contentBefore) {
        showToast("Pasted with formatting.");
        return;
      }
      showToast("Couldn't insert formatted paste — using plain text.", true);
      insertPlainTextAtSelection(text);
    });
  }

  function shouldConvertOnPaste(text) {
    if (looksLikeMarkdown(text)) return true;
    if (/\S\n[ \t]*\n\S/.test(text)) return true;
    return false;
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

  const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const HR_RE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;
  const TABLE_DELIM_RE = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

  function markdownToHtml(markdown) {
    let src = String(markdown || "").replace(/\r\n?/g, "\n");

    const codeBlocks = [];
    src = src.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: String(lang || "").trim(), code });
      return BLOCK_MARK + "B" + idx + BLOCK_MARK;
    });

    const lines = src.split("\n");
    const blocks = [];
    let i = 0;
    const blockLineRe = new RegExp("^" + BLOCK_MARK + "B(\\d+)" + BLOCK_MARK + "$");

    const pushBlock = (html) => blocks.push(html);
    const pushParagraph = (html) => blocks.push(`<p>${html}</p>`);

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
        pushBlock(`<pre><code${langAttr}>${escapeHtml(block.code)}</code></pre>`);
        i += 1;
        continue;
      }

      if (HR_RE.test(line)) {
        pushBlock("<hr>");
        i += 1;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        pushBlock(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
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
        pushBlock(`<blockquote>${inner}</blockquote>`);
        continue;
      }

      if (isTableStart(lines, i)) {
        const table = parseTable(lines, i);
        pushBlock(table.html);
        i = table.next;
        continue;
      }

      if (LIST_ITEM_RE.test(line)) {
        const list = parseList(lines, i);
        pushBlock(list.html);
        i = list.next;
        continue;
      }

      const para = [line];
      i += 1;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !HR_RE.test(lines[i]) &&
        !LIST_ITEM_RE.test(lines[i]) &&
        !isTableStart(lines, i) &&
        !blockLineRe.test(lines[i])
      ) {
        para.push(lines[i]);
        i += 1;
      }
      pushParagraph(para.map((l) => renderInline(l)).join("<br>"));
    }

    // Markdown separates top-level blocks with blank lines, so restore one
    // spacer paragraph between each pair. Soft line breaks *within* a
    // paragraph stay as <br>, which the composer preserves as-is.
    return blocks.join(BLOCK_SPACER);
  }

  function indentWidth(whitespace) {
    return String(whitespace || "").replace(/\t/g, "    ").length;
  }

  function collectListItems(lines, start) {
    const items = [];
    let i = start;

    while (i < lines.length) {
      if (/^\s*$/.test(lines[i])) {
        let j = i;
        while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
        if (j < lines.length && LIST_ITEM_RE.test(lines[j]) && !HR_RE.test(lines[j])) {
          i = j;
          continue;
        }
        break;
      }

      if (HR_RE.test(lines[i])) break;

      const match = lines[i].match(LIST_ITEM_RE);
      if (!match) break;

      const marker = match[2];
      const ordered = /\d/.test(marker);
      const item = {
        indent: indentWidth(match[1]),
        ordered,
        number: ordered ? parseInt(marker, 10) : null,
        lines: [match[3]]
      };
      i += 1;

      // Wrapped continuation lines belong to the item, but an indented list
      // marker starts a nested item instead.
      while (
        i < lines.length &&
        /^\s+\S/.test(lines[i]) &&
        !LIST_ITEM_RE.test(lines[i]) &&
        !HR_RE.test(lines[i])
      ) {
        item.lines.push(lines[i].trim());
        i += 1;
      }

      items.push(item);
    }

    return { items, next: i };
  }

  function buildList(items, pos) {
    const indent = items[pos].indent;
    const ordered = items[pos].ordered;
    const startNumber = items[pos].number;
    const rendered = [];
    let i = pos;

    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        const nested = buildList(items, i);
        if (rendered.length > 0) {
          rendered[rendered.length - 1] = rendered[rendered.length - 1].replace(
            /<\/li>$/,
            `${nested.html}</li>`
          );
        } else {
          rendered.push(`<li>${nested.html}</li>`);
        }
        i = nested.next;
        continue;
      }

      if (items[i].ordered !== ordered) break;

      rendered.push(`<li>${items[i].lines.map((l) => renderInline(l)).join("<br>")}</li>`);
      i += 1;
    }

    const tag = ordered ? "ol" : "ul";
    const startAttr =
      ordered && Number.isFinite(startNumber) && startNumber !== 1
        ? ` start="${startNumber}"`
        : "";

    return { html: `<${tag}${startAttr}>${rendered.join("")}</${tag}>`, next: i };
  }

  function parseList(lines, start) {
    const collected = collectListItems(lines, start);
    if (collected.items.length === 0) {
      return { html: "", next: start + 1 };
    }

    const parts = [];
    let pos = 0;
    while (pos < collected.items.length) {
      const built = buildList(collected.items, pos);
      parts.push(built.html);
      pos = built.next > pos ? built.next : pos + 1;
    }

    return { html: parts.join(""), next: collected.next };
  }

  function isTableStart(lines, index) {
    const line = lines[index];
    return Boolean(
      line &&
        line.includes("|") &&
        index + 1 < lines.length &&
        TABLE_DELIM_RE.test(lines[index + 1]) &&
        splitTableRow(line).length > 1
    );
  }

  function splitTableRow(line) {
    let row = String(line).trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
    return row.split("|").map((cell) => cell.trim());
  }

  function parseTable(lines, start) {
    const header = splitTableRow(lines[start]);
    const alignments = splitTableRow(lines[start + 1]).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });

    const cell = (tag, value, index) => {
      const align = alignments[index];
      const style = align ? ` style="text-align:${align}"` : "";
      return `<${tag}${style}>${renderInline(value)}</${tag}>`;
    };

    let i = start + 2;
    const bodyRows = [];
    while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
      const cells = splitTableRow(lines[i]);
      const padded = header.map((_h, index) => cells[index] || "");
      bodyRows.push(`<tr>${padded.map((value, index) => cell("td", value, index)).join("")}</tr>`);
      i += 1;
    }

    const head = `<tr>${header.map((value, index) => cell("th", value, index)).join("")}</tr>`;
    const body = bodyRows.length > 0 ? `<tbody>${bodyRows.join("")}</tbody>` : "";

    return { html: `<table><thead>${head}</thead>${body}</table>`, next: i };
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
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
      if (!isSafeUrl(url)) return match;
      const idx = links.length;
      links.push({ label, url });
      return INLINE_MARK + "L" + idx + INLINE_MARK;
    });

    s = s.replace(/(^|[\s(\[]|&quot;|&#39;)(https?:\/\/[^\s<>"']+)/g, (_m, lead, url) => {
      let trail = "";
      for (;;) {
        // escapeHtml already ran, so a trailing quote/bracket is an entity.
        const entity = url.match(/(?:&quot;|&#39;|&gt;|&lt;|&amp;)$/);
        if (entity) {
          trail = entity[0] + trail;
          url = url.slice(0, -entity[0].length);
          continue;
        }
        if (/[).,;:!?\]]$/.test(url)) {
          trail = url.slice(-1) + trail;
          url = url.slice(0, -1);
          continue;
        }
        break;
      }
      if (!url) return `${lead}${trail}`;
      return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
    });

    s = s.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "<del>$1</del>");

    // Emphasis delimiters must hug their content, otherwise arithmetic such as
    // "2 * 3 and 4 * 5" gets swallowed into an <em>.
    s = s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)/g, "$1<strong>$2</strong>");

    s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>");

    const linkRe = new RegExp(INLINE_MARK + "L(\\d+)" + INLINE_MARK, "g");
    s = s.replace(linkRe, (_m, idx) => {
      const link = links[Number(idx)];
      return `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.label}</a>`;
    });

    const codeRe = new RegExp(INLINE_MARK + "C(\\d+)" + INLINE_MARK, "g");
    s = s.replace(codeRe, (_m, idx) => `<code>${codes[Number(idx)]}</code>`);

    return s;
  }

  // Pasted markdown can carry a javascript:/data: link that would then be sent
  // on to a customer, so only well-known navigable schemes become anchors.
  function isSafeUrl(url) {
    const candidate = String(url || "")
      .trim()
      .replace(/&amp;/g, "&");
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      return /^(?:https?|mailto|tel):/i.test(candidate);
    }
    // Scheme-relative and relative URLs are inert.
    return true;
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
