/**
 * TechScan — Service Worker (background.js)
 * Loads fingerprint DB, orchestrates detection, stores results per tab.
 */

importScripts('detector.js');

const detector = new Detector();
const tabResults = {};
const tabFitResults = {};
let domSelectors = [];
let cssSelectors = [];
let jsKeys = [];
let initPromise = null;

function ensureInit() {
  if (detector.ready) return Promise.resolve();
  if (!initPromise) {
    initPromise = detector.init().then(() => {
      extractSelectors();
      console.log(`[TechProfiler] Ready. ${jsKeys.length} JS keys, ${domSelectors.length} DOM selectors`);
    }).catch(err => {
      console.error('[TechProfiler] Init failed:', err);
      initPromise = null;
    });
  }
  return initPromise;
}

function extractSelectors() {
  const domSet = new Set();
  const cssSet = new Set();
  const jsSet = new Set();

  for (const tech of Object.values(detector.apps)) {
    if (tech.dom) {
      if (typeof tech.dom === 'string') {
        domSet.add(tech.dom);
      } else if (Array.isArray(tech.dom)) {
        tech.dom.forEach(s => domSet.add(s));
      } else {
        Object.keys(tech.dom).forEach(s => domSet.add(s));
      }
    }
    if (tech.css) {
      const cssPatterns = Array.isArray(tech.css) ? tech.css : [tech.css];
      cssPatterns.forEach(s => cssSet.add(s));
    }
    if (tech.js) {
      Object.keys(tech.js).forEach(k => jsSet.add(k));
    }
  }

  domSelectors = [...domSet];
  cssSelectors = [...cssSet];
  jsKeys = [...jsSet];
}

async function evaluateFitProfiles(tabId) {
  try {
    const data = await chrome.storage.local.get(['fitProfiles', 'claudeApiKey']);
    const profiles = (data.fitProfiles || []).filter(p => p.enabled);
    const apiKey = data.claudeApiKey;
    if (!profiles.length || !apiKey) return;

    const result = tabResults[tabId];
    if (!result) return;

    const techs = result.techs || {};
    const techList = Object.values(techs);
    if (techList.length === 0) return;

    const techSummary = techList.map(t => {
      const cats = (t.categories || []).map(c => c.name).join(', ');
      return `${t.name}${cats ? ' (' + cats + ')' : ''}`;
    }).join('\n');

    const profileBlock = profiles.map((p, i) =>
      `${i + 1}. [${p.id}] "${p.name}": ${p.prompt}`
    ).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: 'Evaluate whether detected technologies match fit profiles. Return ONLY a JSON array: [{"profileId":"...","match":true/false,"reason":"one sentence"}]',
        messages: [{ role: 'user', content: `Detected techs on ${result.url}:\n${techSummary}\n\nProfiles:\n${profileBlock}` }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[TechProfiler] Fit evaluation API error:', response.status);
      return;
    }

    const apiResult = await response.json();
    const text = apiResult.content?.[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const fitResults = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(fitResults)) return;

    const profileMap = {};
    for (const fr of fitResults) {
      if (fr.profileId) {
        profileMap[fr.profileId] = { match: !!fr.match, reason: fr.reason || '' };
      }
    }

    const fitData = { url: result.url, profiles: profileMap };
    tabFitResults[tabId] = fitData;
    await chrome.storage.local.set({ [`fitResults_${tabId}`]: fitData });

    updateBadgeForFit(tabId);

    try {
      await chrome.runtime.sendMessage({ type: 'FIT_RESULTS_READY', tabId });
    } catch (e) {
      // Popup may not be open
    }
  } catch (e) {
    console.error('[TechProfiler] Fit evaluation error:', e.message);
  }
}

function updateBadgeForFit(tabId) {
  const fitData = tabFitResults[tabId];
  if (!fitData || !fitData.profiles) return;

  const matchedNames = [];
  chrome.storage.local.get('fitProfiles', (data) => {
    const profiles = data.fitProfiles || [];
    const profileLookup = {};
    for (const p of profiles) profileLookup[p.id] = p.name;

    for (const [pid, result] of Object.entries(fitData.profiles)) {
      if (result.match) matchedNames.push(profileLookup[pid] || pid);
    }

    try {
      if (matchedNames.length > 0) {
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
        chrome.action.setTitle({ tabId, title: `Fit: ${matchedNames.join(', ')}` });
      } else {
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#4A90D9' });
        chrome.action.setTitle({ tabId, title: 'TechProfiler' });
      }
    } catch (e) {}
  });
}

async function runDetection(tabId, signals) {
  await ensureInit();
  // Clear fit cache for fresh evaluation
  delete tabFitResults[tabId];
  chrome.storage.local.remove(`fitResults_${tabId}`);

  // Ensure content script is injected before querying DOM
  await injectContentScript(tabId);

  // Query DOM selectors from content script
  try {
    const domResults = await chrome.tabs.sendMessage(tabId, {
      type: 'QUERY_DOM',
      selectors: domSelectors,
      cssSelectors: cssSelectors
    });
    if (domResults) {
      signals.dom = { ...signals.dom, ...domResults.dom };
      signals.css = { ...signals.css, ...domResults.css };
    }
  } catch (e) {
    // Content script may not be ready
  }

  // Detect JS globals directly via executeScript (no postMessage relay needed)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (keys) => {
        const globals = {};
        for (const key of keys) {
          try {
            const parts = key.split('.');
            let obj = window;
            let found = true;
            for (const part of parts) {
              if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
                found = false;
                break;
              }
              obj = obj[part];
            }
            if (found && obj !== undefined) {
              if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
                globals[key] = String(obj);
              } else {
                globals[key] = '__exists__';
              }
            }
          } catch (e) {
            // Access denied or getter threw
          }
        }
        return globals;
      },
      args: [jsKeys]
    });
    if (results && results[0] && results[0].result) {
      signals.js = { ...signals.js, ...results[0].result };
    }
  } catch (e) {
    // Can't inject into chrome://, about:, etc.
  }

  // Run pattern matching
  const techs = detector.detect(signals);

  // Store results
  tabResults[tabId] = {
    url: signals.url || '',
    techs,
    timestamp: Date.now()
  };

  // Update badge
  const count = Object.keys(techs).length;
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4A90D9' });
  } catch (e) {}

  // Persist for service worker wake-up
  try {
    await chrome.storage.local.set({ [`tab_${tabId}`]: tabResults[tabId] });
  } catch (e) {}

  // Trigger LLM detection asynchronously (non-blocking)
  triggerLLMDetection(tabId, signals, techs);
}

async function triggerLLMDetection(tabId, signals, localTechs) {
  try {
    const data = await chrome.storage.local.get('claudeApiKey');
    const apiKey = data.claudeApiKey;
    if (!apiKey) return;

    // Mark as pending
    if (tabResults[tabId]) {
      tabResults[tabId].llmPending = true;
    }

    const alreadyDetected = Object.keys(localTechs);
    const scriptUrls = (signals.scriptSrc || []).slice(0, 50).join('\n');
    const inlineSnippets = (signals.scripts || []).slice(0, 20).map(s => s.slice(0, 200)).join('\n');
    const metaTags = JSON.stringify(signals.meta || {});
    const pageUrl = signals.url || '';

    // Build optional signal sections
    const extraSections = [];

    const linkHints = (signals.linkHints || []).slice(0, 30);
    if (linkHints.length > 0) {
      extraSections.push(`Link hints (preconnect/prefetch):\n${linkHints.join('\n')}`);
    }

    const iframes = (signals.iframes || []).slice(0, 20);
    if (iframes.length > 0) {
      extraSections.push(`Iframe sources:\n${iframes.join('\n')}`);
    }

    const imgPixels = (signals.imgPixels || []).slice(0, 20);
    if (imgPixels.length > 0) {
      extraSections.push(`Tracking pixels / external image URLs:\n${imgPixels.join('\n')}`);
    }

    const stylesheetUrls = (signals.stylesheetUrls || []).slice(0, 20);
    if (stylesheetUrls.length > 0) {
      extraSections.push(`Stylesheet URLs:\n${stylesheetUrls.join('\n')}`);
    }

    const cookieNames = Object.keys(signals.cookies || {}).slice(0, 30);
    if (cookieNames.length > 0) {
      extraSections.push(`Cookies:\n${cookieNames.join(', ')}`);
    }

    const extraBlock = extraSections.length > 0 ? '\n\n' + extraSections.join('\n\n') : '';

    const userPrompt = `Analyze these signals from ${pageUrl} and identify technologies NOT already detected.

Script URLs:
${scriptUrls}

Inline script snippets:
${inlineSnippets}

Meta tags:
${metaTags}${extraBlock}

Already detected (do NOT include these):
${alreadyDetected.join(', ')}

Respond with a JSON array: [{"name": "Tech Name", "category": "Category", "confidence": 0.95, "description": "One sentence."}]
Categories: Analytics, Advertising, CDN, CMS, CSS framework, JavaScript framework, JavaScript library, Marketing, Hosting, Payment, Security, Tag manager, Widget, Font, Other
Only include confidence >= 0.7.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: 'You are a web technology detection expert. Given script URLs, inline script snippets, meta tags, link hints (preconnect/prefetch), iframe sources, tracking pixels, stylesheet URLs, and cookie names from a webpage, identify web technologies, frameworks, libraries, analytics tools, SaaS products, data processors, and advertising platforms. Only report technologies you are confident about. Respond ONLY with a JSON array.',
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[TechProfiler] LLM API error:', response.status);
      return;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '';

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const aiTechs = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(aiTechs)) return;

    // Filter and merge
    const existingNames = new Set(alreadyDetected.map(n => n.toLowerCase()));
    let added = 0;

    for (const t of aiTechs) {
      if (!t.name || !t.category || typeof t.confidence !== 'number') continue;
      if (t.confidence < 0.7) continue;
      if (existingNames.has(t.name.toLowerCase())) continue;

      const key = t.name;
      if (tabResults[tabId] && !tabResults[tabId].techs[key]) {
        tabResults[tabId].techs[key] = {
          name: t.name,
          categories: [{ id: 0, name: t.category }],
          description: t.description || '',
          aiDetected: true,
          confidence: t.confidence
        };
        existingNames.add(t.name.toLowerCase());
        added++;
      }
    }

    if (tabResults[tabId]) {
      tabResults[tabId].llmPending = false;
    }

    if (added > 0 && tabResults[tabId]) {
      // Update badge
      const count = Object.keys(tabResults[tabId].techs).length;
      try {
        await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
      } catch (e) {}

      // Persist
      try {
        await chrome.storage.local.set({ [`tab_${tabId}`]: tabResults[tabId] });
      } catch (e) {}

      // Notify popup
      try {
        await chrome.runtime.sendMessage({ type: 'LLM_RESULTS_READY', tabId });
      } catch (e) {
        // Popup may not be open
      }
    }

    // Evaluate fit profiles after LLM techs are merged
    evaluateFitProfiles(tabId);
  } catch (e) {
    console.error('[TechProfiler] LLM detection error:', e.message);
    if (tabResults[tabId]) {
      tabResults[tabId].llmPending = false;
    }
    // Still evaluate fit profiles against pattern-matched techs
    evaluateFitProfiles(tabId);
  }
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {
    // May already be injected or page doesn't allow injection
  }
}

// Single unified message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from content scripts (have sender.tab)
  if (sender.tab) {
    const tabId = sender.tab.id;

    if (msg.type === 'PAGE_SIGNALS') {
      const signals = msg.data;
      signals.url = msg.url;
      runDetection(tabId, signals)
        .then(() => sendResponse({ status: 'done' }))
        .catch(err => {
          console.error('[TechProfiler] Detection error:', err);
          sendResponse({ status: 'error' });
        });
      return true;
    }

    if (msg.type === 'GET_RESULTS') {
      sendResponse(tabResults[tabId] || null);
      return true;
    }

    return;
  }

  // Messages from popup (no sender.tab)
  if (msg.type === 'POPUP_GET_RESULTS') {
    const tabId = msg.tabId;
    if (tabResults[tabId]) {
      sendResponse(tabResults[tabId]);
    } else {
      chrome.storage.local.get(`tab_${tabId}`, (data) => {
        const result = data[`tab_${tabId}`] || null;
        if (result) tabResults[tabId] = result;
        sendResponse(result);
      });
    }
    return true;
  }

  if (msg.type === 'POPUP_GET_FIT_RESULTS') {
    const tabId = msg.tabId;
    if (tabFitResults[tabId]) {
      sendResponse(tabFitResults[tabId]);
    } else {
      chrome.storage.local.get(`fitResults_${tabId}`, (data) => {
        const result = data[`fitResults_${tabId}`] || null;
        if (result) tabFitResults[tabId] = result;
        sendResponse(result);
      });
    }
    return true;
  }

  if (msg.type === 'EVALUATE_FIT_PROFILES') {
    const tabId = msg.tabId;
    delete tabFitResults[tabId];
    chrome.storage.local.remove(`fitResults_${tabId}`);
    evaluateFitProfiles(tabId).then(() => sendResponse({ status: 'done' }));
    return true;
  }

  if (msg.type === 'POPUP_RESCAN') {
    const tabId = msg.tabId;
    injectContentScript(tabId).then(() => {
      chrome.tabs.sendMessage(tabId, { type: 'COLLECT_SIGNALS' }, (signals) => {
        if (chrome.runtime.lastError || !signals) {
          sendResponse({ error: 'Cannot scan this page' });
          return;
        }
        signals.url = msg.url || '';
        runDetection(tabId, signals)
          .then(() => sendResponse(tabResults[tabId]))
          .catch(err => {
            console.error('[TechProfiler] Rescan error:', err);
            sendResponse({ error: 'Detection failed' });
          });
      });
    });
    return true;
  }
});

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabResults[tabId];
  delete tabFitResults[tabId];
  chrome.storage.local.remove([`tab_${tabId}`, `fitResults_${tabId}`]);
});

// Pre-initialize
ensureInit();
