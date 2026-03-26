/**
 * TechScan — Popup UI
 */

const $loading = document.getElementById('loading');
const $error = document.getElementById('error');
const $errorMsg = document.getElementById('errorMsg');
const $empty = document.getElementById('empty');
const $results = document.getElementById('results');
const $siteInfo = document.getElementById('siteInfo');
const $techCount = document.getElementById('techCount');
const $rescanBtn = document.getElementById('rescanBtn');
const $settingsBtn = document.getElementById('settingsBtn');
const $settings = document.getElementById('settings');
const $apiKeyInput = document.getElementById('apiKeyInput');
const $profilesList = document.getElementById('profilesList');
const $profileForm = document.getElementById('profileForm');
const $profileNameInput = document.getElementById('profileNameInput');
const $profilePromptInput = document.getElementById('profilePromptInput');
const $profileSaveBtn = document.getElementById('profileSaveBtn');
const $profileCancelBtn = document.getElementById('profileCancelBtn');
const $addProfileBtn = document.getElementById('addProfileBtn');
const $profileApiHint = document.getElementById('profileApiHint');
const $fitResults = document.getElementById('fitResults');

let currentTabId = null;
let currentTabUrl = '';
let collapsedCategories = [];
let profiles = [];
let editingProfileId = null;

// --- Settings ---
$settingsBtn.addEventListener('click', () => {
  const opening = $settings.style.display === 'none';
  $settings.style.display = opening ? 'block' : 'none';
  if (opening) loadProfiles();
});

$apiKeyInput.addEventListener('change', () => {
  const key = $apiKeyInput.value.trim();
  chrome.storage.local.set({ claudeApiKey: key });
});

// Load saved API key and collapsed categories
chrome.storage.local.get(['claudeApiKey', 'collapsedCategories'], (data) => {
  if (data.claudeApiKey) {
    $apiKeyInput.value = data.claudeApiKey;
  }
  if (data.collapsedCategories) {
    collapsedCategories = data.collapsedCategories;
  }
});

function loadProfiles() {
  chrome.storage.local.get(['fitProfiles', 'claudeApiKey'], (data) => {
    profiles = data.fitProfiles || [];
    const hasApiKey = !!data.claudeApiKey;
    $profileApiHint.style.display = hasApiKey ? 'none' : 'block';
    renderProfilesList();
  });
}

function saveProfiles(updatedProfiles) {
  profiles = updatedProfiles;
  chrome.storage.local.set({ fitProfiles: profiles }, () => {
    renderProfilesList();
    if (currentTabId) {
      chrome.runtime.sendMessage({ type: 'EVALUATE_FIT_PROFILES', tabId: currentTabId });
    }
  });
}

function renderProfilesList() {
  while ($profilesList.firstChild) $profilesList.removeChild($profilesList.firstChild);

  if (profiles.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'profiles-empty';
    hint.textContent = 'No profiles yet. Add one to get started.';
    $profilesList.appendChild(hint);
    return;
  }

  for (const profile of profiles) {
    const item = document.createElement('div');
    item.className = 'profile-item';

    const info = document.createElement('div');
    info.className = 'profile-item-info';

    const name = document.createElement('div');
    name.className = 'profile-item-name';
    name.textContent = profile.name;
    info.appendChild(name);

    const prompt = document.createElement('div');
    prompt.className = 'profile-item-prompt';
    prompt.textContent = profile.prompt.length > 60 ? profile.prompt.slice(0, 60) + '...' : profile.prompt;
    prompt.title = profile.prompt;
    info.appendChild(prompt);

    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'profile-item-actions';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = profile.enabled;
    toggle.title = profile.enabled ? 'Enabled' : 'Disabled';
    toggle.addEventListener('change', () => {
      profile.enabled = toggle.checked;
      saveProfiles([...profiles]);
    });
    actions.appendChild(toggle);

    const editBtn = document.createElement('button');
    editBtn.className = 'profile-icon-btn';
    editBtn.textContent = '\u270E';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => {
      editingProfileId = profile.id;
      $profileNameInput.value = profile.name;
      $profilePromptInput.value = profile.prompt;
      $profileForm.style.display = 'block';
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'profile-icon-btn profile-delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', () => {
      saveProfiles(profiles.filter(p => p.id !== profile.id));
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    $profilesList.appendChild(item);
  }
}

$addProfileBtn.addEventListener('click', () => {
  editingProfileId = null;
  $profileNameInput.value = '';
  $profilePromptInput.value = '';
  $profileForm.style.display = 'block';
});

$profileCancelBtn.addEventListener('click', () => {
  $profileForm.style.display = 'none';
});

$profileSaveBtn.addEventListener('click', () => {
  const name = $profileNameInput.value.trim();
  const prompt = $profilePromptInput.value.trim();
  if (!name || !prompt) return;

  if (editingProfileId) {
    const idx = profiles.findIndex(p => p.id === editingProfileId);
    if (idx >= 0) {
      profiles[idx].name = name;
      profiles[idx].prompt = prompt;
    }
    saveProfiles([...profiles]);
  } else {
    const newProfile = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      prompt,
      enabled: true
    };
    saveProfiles([...profiles, newProfile]);
  }
  $profileForm.style.display = 'none';
});

function renderFitResults(fitData) {
  while ($fitResults.firstChild) $fitResults.removeChild($fitResults.firstChild);

  if (!fitData || !fitData.profiles) {
    $fitResults.style.display = 'none';
    return;
  }

  const matched = [];
  for (const [pid, result] of Object.entries(fitData.profiles)) {
    if (result.match) {
      const profile = profiles.find(p => p.id === pid);
      matched.push({ name: profile ? profile.name : pid, reason: result.reason });
    }
  }

  if (matched.length === 0) {
    $fitResults.style.display = 'none';
    return;
  }

  $fitResults.style.display = 'block';
  for (const m of matched) {
    const item = document.createElement('div');
    item.className = 'fit-match-item';

    const check = document.createElement('span');
    check.className = 'fit-check';
    check.textContent = '\u2714';
    item.appendChild(check);

    const info = document.createElement('div');
    info.className = 'fit-match-info';

    const name = document.createElement('span');
    name.className = 'fit-match-name';
    name.textContent = m.name;
    info.appendChild(name);

    const reason = document.createElement('span');
    reason.className = 'fit-match-reason';
    reason.textContent = m.reason;
    info.appendChild(reason);

    item.appendChild(info);
    $fitResults.appendChild(item);
  }
}

function showFitLoading() {
  $fitResults.style.display = 'block';
  while ($fitResults.firstChild) $fitResults.removeChild($fitResults.firstChild);
  const loading = document.createElement('div');
  loading.className = 'fit-loading';
  loading.textContent = 'Evaluating fit profiles...';
  $fitResults.appendChild(loading);
}

function requestFitResults() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage(
    { type: 'POPUP_GET_FIT_RESULTS', tabId: currentTabId },
    (fitData) => {
      if (chrome.runtime.lastError) return;
      // Load profiles first to resolve names
      chrome.storage.local.get('fitProfiles', (data) => {
        profiles = data.fitProfiles || [];
        if (fitData) {
          renderFitResults(fitData);
        } else if (profiles.some(p => p.enabled)) {
          showFitLoading();
          // Trigger evaluation — no cached results available
          chrome.runtime.sendMessage({ type: 'EVALUATE_FIT_PROFILES', tabId: currentTabId });
        }
      });
    }
  );
}

async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showError('No active tab found.');
    return;
  }

  currentTabId = tab.id;
  currentTabUrl = tab.url || '';

  // Show site info with favicon
  const $favicon = document.getElementById('siteFavicon');
  const $hostname = document.getElementById('siteHostname');
  try {
    const url = new URL(currentTabUrl);
    $hostname.textContent = url.hostname;
    $favicon.src = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
  } catch {
    $hostname.textContent = currentTabUrl;
    $favicon.src = '';
  }

  // Check if we can scan this page
  if (currentTabUrl.startsWith('chrome://') || currentTabUrl.startsWith('chrome-extension://') ||
      currentTabUrl.startsWith('about:') || currentTabUrl.startsWith('edge://') ||
      !currentTabUrl.startsWith('http')) {
    showError('Cannot scan this page.');
    return;
  }

  // Request results from background
  chrome.runtime.sendMessage(
    { type: 'POPUP_GET_RESULTS', tabId: currentTabId },
    (result) => {
      if (chrome.runtime.lastError || !result) {
        // No results yet, try triggering a scan
        triggerRescan();
        return;
      }
      renderResults(result);
      requestFitResults();
    }
  );
}

function triggerRescan() {
  showLoading();
  chrome.runtime.sendMessage(
    { type: 'POPUP_RESCAN', tabId: currentTabId, url: currentTabUrl },
    (result) => {
      if (chrome.runtime.lastError || !result || result.error) {
        showError(result?.error || 'Cannot scan this page.');
        return;
      }
      renderResults(result);
    }
  );
}

function showLoading() {
  $loading.style.display = 'flex';
  $error.style.display = 'none';
  $empty.style.display = 'none';
  $results.style.display = 'none';
  $fitResults.style.display = 'none';
}

function showError(msg) {
  $loading.style.display = 'none';
  $error.style.display = 'block';
  $empty.style.display = 'none';
  $results.style.display = 'none';
  $fitResults.style.display = 'none';
  $errorMsg.textContent = msg;
  $techCount.textContent = '';
}

function showAiLoading(show) {
  let $aiLoading = document.getElementById('aiLoading');
  if (show) {
    if (!$aiLoading) {
      $aiLoading = document.createElement('div');
      $aiLoading.id = 'aiLoading';
      $aiLoading.className = 'ai-loading';
      $aiLoading.textContent = 'AI analysis...';
      $results.parentNode.insertBefore($aiLoading, $results.nextSibling);
    }
    $aiLoading.style.display = 'block';
  } else if ($aiLoading) {
    $aiLoading.style.display = 'none';
  }
}

function renderResults(result) {
  $loading.style.display = 'none';
  $error.style.display = 'none';

  const techs = result.techs || {};
  const techList = Object.values(techs);

  if (techList.length === 0) {
    $empty.style.display = 'block';
    $results.style.display = 'none';
    $techCount.textContent = 'No technologies detected';
    return;
  }

  $empty.style.display = 'none';
  $results.style.display = 'block';
  $techCount.textContent = `${techList.length} technolog${techList.length === 1 ? 'y' : 'ies'} detected`;

  // Check if LLM detection is still pending — show AI loading if key is set and no AI results yet
  const hasAiResults = techList.some(t => t.aiDetected);
  if (!hasAiResults && result.llmPending) {
    showAiLoading(true);
  } else {
    showAiLoading(false);
  }

  // Group by category
  const grouped = {};
  for (const tech of techList) {
    const cats = tech.categories && tech.categories.length > 0
      ? tech.categories
      : [{ id: 0, name: 'Other' }];
    for (const cat of cats) {
      if (!grouped[cat.name]) grouped[cat.name] = [];
      // Avoid duplicates if tech has multiple cats
      if (!grouped[cat.name].find(t => t.name === tech.name)) {
        grouped[cat.name].push(tech);
      }
    }
  }

  // Sort categories, put "Other" last
  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  // Clear results container safely
  while ($results.firstChild) {
    $results.removeChild($results.firstChild);
  }

  for (const catName of sortedCategories) {
    const techs = grouped[catName].sort((a, b) => a.name.localeCompare(b.name));
    const group = document.createElement('div');
    group.className = 'category-group';

    if (collapsedCategories.includes(catName)) {
      group.classList.add('collapsed');
    }

    const header = document.createElement('div');
    header.className = 'category-header';
    header.appendChild(document.createTextNode(catName));
    const countBadge = document.createElement('span');
    countBadge.className = 'cat-count';
    countBadge.textContent = `(${techs.length})`;
    header.appendChild(countBadge);
    header.addEventListener('click', () => {
      const idx = collapsedCategories.indexOf(catName);
      if (idx >= 0) {
        collapsedCategories.splice(idx, 1);
      } else {
        collapsedCategories.push(catName);
      }
      group.classList.toggle('collapsed');
      chrome.storage.local.set({ collapsedCategories });
    });
    group.appendChild(header);

    for (const tech of techs) {
      const item = document.createElement('div');
      item.className = 'tech-item';

      // Icon — favicon from website, fallback to first letter
      const icon = document.createElement('div');
      icon.className = 'tech-icon';
      if (tech.website) {
        try {
          const domain = new URL(tech.website).hostname;
          const img = document.createElement('img');
          img.className = 'tech-icon-img';
          img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
          img.alt = '';
          img.onerror = () => {
            icon.removeChild(img);
            icon.textContent = tech.name.charAt(0).toUpperCase();
          };
          icon.appendChild(img);
        } catch {
          icon.textContent = tech.name.charAt(0).toUpperCase();
        }
      } else {
        icon.textContent = tech.name.charAt(0).toUpperCase();
      }
      item.appendChild(icon);

      // Info
      const info = document.createElement('div');
      info.className = 'tech-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'tech-name';

      if (tech.website) {
        const link = document.createElement('a');
        link.href = tech.website;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = tech.name;
        nameRow.appendChild(link);
      } else {
        nameRow.appendChild(document.createTextNode(tech.name));
      }

      if (tech.version) {
        const ver = document.createElement('span');
        ver.className = 'tech-version';
        ver.textContent = tech.version;
        nameRow.appendChild(ver);
      }

      if (tech.implied) {
        const badge = document.createElement('span');
        badge.className = 'implied-badge';
        badge.textContent = 'implied';
        nameRow.appendChild(badge);
      }

      if (tech.aiDetected) {
        const badge = document.createElement('span');
        badge.className = 'ai-badge';
        badge.textContent = 'AI';
        badge.title = 'Detected by AI analysis';
        nameRow.appendChild(badge);
      }

      info.appendChild(nameRow);

      if (tech.description) {
        const desc = document.createElement('div');
        desc.className = 'tech-desc';
        desc.textContent = tech.description;
        desc.title = tech.description;
        info.appendChild(desc);
      }

      item.appendChild(info);
      group.appendChild(item);
    }

    $results.appendChild(group);
  }
}

// Listen for results from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LLM_RESULTS_READY' && msg.tabId === currentTabId) {
    chrome.runtime.sendMessage(
      { type: 'POPUP_GET_RESULTS', tabId: currentTabId },
      (result) => {
        if (chrome.runtime.lastError) return;
        if (result) renderResults(result);
      }
    );
  }
  if (msg.type === 'FIT_RESULTS_READY' && msg.tabId === currentTabId) {
    requestFitResults();
  }
});

// Rescan button
$rescanBtn.addEventListener('click', () => {
  triggerRescan();
});

// Initialize
init();
