/**
 * TechScan — Content Script (ISOLATED world)
 * Collects page signals and sends them to the service worker.
 */

(function () {
  if (window.__techscan_content_ran) return;
  window.__techscan_content_ran = true;

  function collectSignals() {
    const signals = {
      meta: {},
      scriptSrc: [],
      scripts: [],
      cookies: {},
      dom: {},
      css: {},
      html: '',
      js: {}
    };

    // --- Meta tags ---
    try {
      document.querySelectorAll('meta[name], meta[property]').forEach(tag => {
        const name = (tag.getAttribute('name') || tag.getAttribute('property') || '').toLowerCase();
        const content = tag.getAttribute('content') || '';
        if (name) signals.meta[name] = content;
      });
    } catch (e) {}

    // --- Script sources ---
    try {
      document.querySelectorAll('script[src]').forEach(tag => {
        const src = tag.getAttribute('src');
        if (src) signals.scriptSrc.push(src);
      });
    } catch (e) {}

    // --- Inline scripts (max 50 scripts, 2000 chars each) ---
    try {
      let count = 0;
      document.querySelectorAll('script:not([src])').forEach(tag => {
        if (count >= 50) return;
        const text = tag.textContent || '';
        if (text.length > 0) {
          signals.scripts.push(text.slice(0, 2000));
          count++;
        }
      });
    } catch (e) {}

    // --- Cookies ---
    try {
      const cookieStr = document.cookie || '';
      cookieStr.split(';').forEach(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (name) signals.cookies[name.trim()] = rest.join('=').trim();
      });
    } catch (e) {}

    // --- HTML snippets for pattern matching ---
    try {
      signals.html = document.head ? document.head.innerHTML.slice(0, 50000) : '';
      if (document.body) {
        signals.html += document.body.innerHTML.slice(0, 20000);
      }
    } catch (e) {}

    // --- Link preconnect/prefetch/dns-prefetch hints ---
    try {
      signals.linkHints = [];
      document.querySelectorAll('link[rel="preconnect"], link[rel="prefetch"], link[rel="dns-prefetch"], link[rel="preload"]').forEach(tag => {
        const href = tag.getAttribute('href');
        if (href) signals.linkHints.push(href);
      });
    } catch (e) {}

    // --- Iframe sources ---
    try {
      signals.iframes = [];
      document.querySelectorAll('iframe[src]').forEach(tag => {
        const src = tag.getAttribute('src');
        if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
          signals.iframes.push(src);
        }
      });
    } catch (e) {}

    // --- Image/pixel URLs (only external) ---
    try {
      signals.imgPixels = [];
      document.querySelectorAll('img[src]').forEach(tag => {
        const src = tag.getAttribute('src') || '';
        if ((src.startsWith('http://') || src.startsWith('https://')) && src.length < 500) {
          signals.imgPixels.push(src);
        }
      });
      signals.imgPixels = signals.imgPixels.slice(0, 30);
    } catch (e) {}

    // --- Stylesheet URLs ---
    try {
      signals.stylesheetUrls = [];
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach(tag => {
        const href = tag.getAttribute('href');
        if (href) signals.stylesheetUrls.push(href);
      });
    } catch (e) {}

    return signals;
  }

  function queryDomSelectors(selectors) {
    const results = {};
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const entry = {
            exists: true,
            text: (el.textContent || '').slice(0, 500)
          };
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          entry.attributes = attrs;
          results[selector] = entry;
        }
      } catch (e) {
        // Invalid selector
      }
    }
    return results;
  }

  function queryCssSelectors(selectors) {
    const results = {};
    for (const selector of selectors) {
      try {
        if (document.querySelector(selector)) {
          results[selector] = true;
        }
      } catch (e) {}
    }
    return results;
  }

  // Listen for requests from background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'QUERY_DOM') {
      const domResults = queryDomSelectors(msg.selectors || []);
      const cssResults = queryCssSelectors(msg.cssSelectors || []);
      sendResponse({ dom: domResults, css: cssResults });
      return true;
    }
    if (msg.type === 'COLLECT_SIGNALS') {
      const signals = collectSignals();
      sendResponse(signals);
      return true;
    }
  });

  // Collect and send signals on page load
  const signals = collectSignals();
  chrome.runtime.sendMessage({
    type: 'PAGE_SIGNALS',
    data: signals,
    url: window.location.href
  });
})();
