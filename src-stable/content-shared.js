/**
 * content-shared.js
 * Portility — shared utilities for content scripts.
 * Loaded before platform-specific scripts (content.js, content-chatgpt.js).
 *
 * Exposes window.PortilityShared with platform-agnostic helpers:
 *   - isElementVisible
 *   - extractElementText
 *   - stripMarkdown
 *   - copyToClipboard
 *   - formatConversation
 */

(function () {
  'use strict';

  /**
   * Return true if an element is visible in the DOM (not hidden/collapsed).
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // ─── Markdown stripping ───────────────────────────────────────────────────
  /**
   * Strip common markdown formatting so output pastes as clean plain text.
   * @param {string} text
   * @returns {string}
   */
  function stripMarkdown(text) {
    return text
      // Fenced code blocks — keep content, remove fences
      .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
      // Inline code
      .replace(/`([^`]+)`/g, '$1')
      // Headers
      .replace(/^#{1,6}\s+/gm, '')
      // Bold / italic
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
      // Strikethrough
      .replace(/~~(.*?)~~/g, '$1')
      // Blockquotes
      .replace(/^>\s+/gm, '')
      // Unordered list markers (only if not already prefixed with "- " by walk())
      .replace(/^[\s]*[-*+]\s+/gm, '- ')
      // Ordered list markers
      .replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ')
      // Horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Images in markdown (distinct from uploaded images — handled separately)
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Collapse excess blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ─── Text extraction ──────────────────────────────────────────────────────
  /**
   * Extract plain text from an element with explicit list item handling.
   * Using innerText alone can silently drop list content in some rendering
   * scenarios; this walks the DOM to guarantee list items are captured.
   * @param {Element} el
   * @returns {string}
   */
  function extractElementText(el) {
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();

      // Skip non-content elements: UI controls, scripts, decorative elements
      if (['button', 'script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';

      // Skip aria-hidden elements (decorative / screen-reader duplicates)
      if (node.getAttribute('aria-hidden') === 'true') return '';

      const style = window.getComputedStyle(node);

      // Skip hidden elements
      if (style.display === 'none' || style.visibility === 'hidden') return '';

      // List items: prefix with "- " and add newline
      if (tag === 'li') {
        const children = Array.from(node.childNodes).map(walk).join('').trim();
        return children ? '- ' + children + '\n' : '';
      }

      // Block-level elements: add newline after
      const isBlock = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                       'blockquote', 'pre', 'ul', 'ol', 'br', 'hr',
                       'section', 'article', 'header', 'footer'].includes(tag);

      const inner = Array.from(node.childNodes).map(walk).join('');

      if (tag === 'br') return '\n';
      if (isBlock) return inner.trimEnd() + '\n';
      return inner;
    }

    const raw = walk(el);
    return stripMarkdown(raw);
  }

  // ─── Conversation formatting ──────────────────────────────────────────────
  /**
   * Format extracted messages into the final clipboard string.
   * @param {{ role: string, text: string }[]} messages
   * @returns {string}
   */
  function formatConversation(messages) {
    var HEADER = (typeof PORT_MY_CHAT_PROMPTS !== 'undefined' && PORT_MY_CHAT_PROMPTS.header)
      ? PORT_MY_CHAT_PROMPTS.header
      : 'The following is a previous conversation from another AI assistant. Treat it as shared context. In your first response, briefly confirm what you understand the conversation to be about, then propose the most logical next step and ask the user if they\'d like to proceed with that or go in a different direction.\n\n---\n\n';
    const body = messages
      .map(function(item) { return item.role + ': ' + item.text; })
      .join('\n\n');
    return HEADER + body;
  }

  // ─── Clipboard helpers ────────────────────────────────────────────────────
  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (e) {
        // Fall through to execCommand fallback
      }
    }
    // execCommand fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!success) throw new Error('execCommand copy failed');
  }

  // ─── Export ───────────────────────────────────────────────────────────────
  window.PortilityShared = {
    isElementVisible: isElementVisible,
    extractElementText: extractElementText,
    stripMarkdown: stripMarkdown,
    copyToClipboard: copyToClipboard,
    formatConversation: formatConversation,
  };
})();
