(() => {
  'use strict';

  const STORAGE_KEY = "darkModeHelperEnabled";
  const TRANSPARENT_CODE_KEY = "transparentCodeBackground";

  // Selects the forced code-block background: false = solid black (default),
  // true = transparent. Updated from storage at boot.
  let transparentCodeEnabled = false;

  if (!chrome?.storage?.sync) {
    return;
  }

  chrome.storage.sync.get(
    { [STORAGE_KEY]: true, [TRANSPARENT_CODE_KEY]: false },
    (result) => {
      if (result?.[STORAGE_KEY] === false) {
        return;
      }
      transparentCodeEnabled = result?.[TRANSPARENT_CODE_KEY] === true;
      boot();
    }
  );

  // Zendesk markup differs by account/workspace; these are safe high-signal containers.
  const COMMENT_CONTAINER_SELECTORS = [
    '[data-test-id*="omni-log-comment"]',
    '[data-test-id*="ticket-comment"]',
    '[data-test-id*="comment-item"]',
    '[data-test-id*="conversation-item"]',
    '.zd-comment',
    '.ticket-comment',
    '.comment-body'
  ];

  const PRESENTATIONAL_SELECTOR = [
    '[style]',
    '[bgcolor]',
    '[color]',
    '[face]',
    '[size]',
    'font',
    'style'
  ].join(',');

  const COMMENT_SELECTOR = COMMENT_CONTAINER_SELECTORS.join(',');
  const COLOR_OVERRIDE_SELECTOR = ['[style]', '[bgcolor]', '[color]', 'font'].join(',');

  function isComposerContent(node) {
    return Boolean(
      node.closest('[contenteditable="true"], [role="textbox"], form, [data-test-id*="composer"]')
    );
  }

  function unwrapFontTags(root) {
    const fontTags = root.querySelectorAll('font');
    for (const font of fontTags) {
      const parent = font.parentNode;
      if (!parent) continue;

      while (font.firstChild) {
        parent.insertBefore(font.firstChild, font);
      }
      parent.removeChild(font);
    }
  }

  function stripColorOverrides(root) {
    const nodes = root.matches(COLOR_OVERRIDE_SELECTOR)
      ? [root, ...root.querySelectorAll(COLOR_OVERRIDE_SELECTOR)]
      : root.querySelectorAll(COLOR_OVERRIDE_SELECTOR);

    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      if (isComposerContent(el)) continue;

      if (el.hasAttribute('bgcolor')) {
        el.removeAttribute('bgcolor');
      }

      if (el.hasAttribute('color')) {
        el.removeAttribute('color');
      }

      if (!el.hasAttribute('style')) continue;

      el.style.removeProperty('color');
      el.style.removeProperty('background');
      el.style.removeProperty('background-color');
      el.style.removeProperty('background-image');
      el.style.removeProperty('text-shadow');

      const remainingStyle = el.getAttribute('style');
      if (!remainingStyle || !remainingStyle.trim()) {
        el.removeAttribute('style');
      }
    }
  }

  // <pre>/<code> backgrounds frequently come from a CSS class or stylesheet
  // rule rather than an inline style, so removing attributes isn't enough.
  // Force a background inline (with !important) so the page's dark theme can't
  // leave white-on-white code illegible. Defaults to solid black; the
  // "transparent" setting overrides it to let the dark theme show through.
  function applyCodeBackground(root) {
    const background = transparentCodeEnabled ? 'transparent' : '#000';
    const nodes = root.matches('pre, code')
      ? [root, ...root.querySelectorAll('pre, code')]
      : root.querySelectorAll('pre, code');

    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      if (isComposerContent(el)) continue;

      el.style.setProperty('background', background, 'important');
      el.style.setProperty('background-color', background, 'important');
      el.style.removeProperty('background-image');
    }
  }

  function stripPresentationalAttrs(root) {
    const nodes = root.matches(PRESENTATIONAL_SELECTOR)
      ? [root, ...root.querySelectorAll(PRESENTATIONAL_SELECTOR)]
      : root.querySelectorAll(PRESENTATIONAL_SELECTOR);

    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      if (isComposerContent(el)) continue;

      if (el.tagName === 'STYLE') {
        el.remove();
        continue;
      }

      el.removeAttribute('style');
      el.removeAttribute('bgcolor');
      el.removeAttribute('color');
      el.removeAttribute('face');
      el.removeAttribute('size');
    }
  }

  function hasEmailStyleArtifacts(root) {
    if (!(root instanceof Element)) return false;
    if (root.querySelector('.gmail_quote, .gmail_attr')) return true;

    let artifactCount = 0;
    const nodes = root.querySelectorAll('[style], font, [bgcolor], [color]');
    for (const node of nodes) {
      if (isComposerContent(node)) continue;
      artifactCount += 1;
      if (artifactCount >= 3) return true;
    }

    return false;
  }

  function cleanCommentContainer(container) {
    if (!(container instanceof Element)) return;
    if (isComposerContent(container)) return;

    stripColorOverrides(container);
    applyCodeBackground(container);

    if (!hasEmailStyleArtifacts(container)) return;

    unwrapFontTags(container);
    stripPresentationalAttrs(container);
  }

  function cleanAllVisibleComments() {
    const containers = document.querySelectorAll(COMMENT_SELECTOR);
    for (const container of containers) {
      cleanCommentContainer(container);
    }
  }

  function cleanFromNode(node) {
    if (!(node instanceof Element)) return;

    if (node.matches(COMMENT_SELECTOR)) {
      cleanCommentContainer(node);
      return;
    }

    const nested = node.querySelectorAll(COMMENT_SELECTOR);
    for (const container of nested) {
      cleanCommentContainer(container);
    }
  }

  function boot() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          cleanFromNode(node);
        }
      }
    });

    const start = () => {
      cleanAllVisibleComments();
      observer.observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
})();
