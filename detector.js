/**
 * TechScan — Pattern Matching Engine
 * Matches collected page signals against fingerprints_data.json
 */

class Detector {
  constructor() {
    this.apps = {};
    this.categories = {};
    this.ready = false;
  }

  async init() {
    const [fpRes, catRes] = await Promise.all([
      fetch(chrome.runtime.getURL('data/fingerprints_data.json')),
      fetch(chrome.runtime.getURL('data/categories.json'))
    ]);
    const fpData = await fpRes.json();
    this.apps = fpData.apps || {};
    this.categories = await catRes.json();
    this.ready = true;
    console.log(`[TechScan] Loaded ${Object.keys(this.apps).length} technologies`);
  }

  parsePattern(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    const parts = pattern.split('\\;');
    const regexStr = parts[0];
    let version = null;
    let confidence = 100;
    for (let i = 1; i < parts.length; i++) {
      const kv = parts[i];
      if (kv.startsWith('version:')) {
        version = kv.slice(8);
      } else if (kv.startsWith('confidence:')) {
        confidence = parseInt(kv.slice(11), 10) || 100;
      }
    }
    let regex;
    try {
      regex = new RegExp(regexStr, 'i');
    } catch {
      return null;
    }
    return { regex, version, confidence };
  }

  extractVersion(match, versionTemplate) {
    if (!versionTemplate || !match) return null;
    let version = versionTemplate;
    version = version.replace(/\\(\d)\?([^:]*):(.*)/, (_, group, ifTrue, ifFalse) => {
      const val = match[parseInt(group, 10)];
      return val ? ifTrue : ifFalse;
    });
    version = version.replace(/\\(\d)/g, (_, group) => {
      return match[parseInt(group, 10)] || '';
    });
    return version.trim() || null;
  }

  testPattern(pattern, value) {
    const parsed = this.parsePattern(pattern);
    if (!parsed) return { matched: false };
    const match = parsed.regex.exec(value);
    if (!match) return { matched: false };
    const version = this.extractVersion(match, parsed.version);
    return { matched: true, version, confidence: parsed.confidence };
  }

  detect(signals) {
    const detected = {};

    for (const [name, tech] of Object.entries(this.apps)) {
      try {
        const result = this._matchTech(name, tech, signals);
        if (result) {
          detected[name] = result;
        }
      } catch (e) {
        // Skip technologies with broken patterns
      }
    }

    this._resolveImplies(detected);
    return detected;
  }

  _matchTech(name, tech, signals) {
    let matched = false;
    let version = null;
    let confidence = 0;

    // --- meta tags ---
    if (tech.meta && signals.meta) {
      for (const [metaName, patterns] of Object.entries(tech.meta)) {
        const metaValue = signals.meta[metaName.toLowerCase()];
        if (metaValue === undefined) continue;
        const patternList = Array.isArray(patterns) ? patterns : [patterns];
        for (const pattern of patternList) {
          if (!pattern) {
            matched = true;
            confidence = Math.max(confidence, 100);
            continue;
          }
          const res = this.testPattern(pattern, metaValue);
          if (res.matched) {
            matched = true;
            if (res.version) version = res.version;
            confidence = Math.max(confidence, res.confidence || 100);
          }
        }
      }
    }

    // --- scriptSrc ---
    if (tech.scriptSrc && signals.scriptSrc) {
      const patterns = Array.isArray(tech.scriptSrc) ? tech.scriptSrc : [tech.scriptSrc];
      for (const pattern of patterns) {
        for (const src of signals.scriptSrc) {
          const res = this.testPattern(pattern, src);
          if (res.matched) {
            matched = true;
            if (res.version) version = res.version;
            confidence = Math.max(confidence, res.confidence || 100);
          }
        }
      }
    }

    // --- scripts (inline script content) ---
    if (tech.scripts && signals.scripts) {
      const patterns = Array.isArray(tech.scripts) ? tech.scripts : [tech.scripts];
      for (const pattern of patterns) {
        for (const scriptContent of signals.scripts) {
          const res = this.testPattern(pattern, scriptContent);
          if (res.matched) {
            matched = true;
            if (res.version) version = res.version;
            confidence = Math.max(confidence, res.confidence || 100);
          }
        }
      }
    }

    // --- html ---
    if (tech.html && signals.html) {
      const patterns = Array.isArray(tech.html) ? tech.html : [tech.html];
      for (const pattern of patterns) {
        const res = this.testPattern(pattern, signals.html);
        if (res.matched) {
          matched = true;
          if (res.version) version = res.version;
          confidence = Math.max(confidence, res.confidence || 100);
        }
      }
    }

    // --- cookies ---
    if (tech.cookies && signals.cookies) {
      for (const [cookieName, pattern] of Object.entries(tech.cookies)) {
        let cookieNameRegex;
        try {
          cookieNameRegex = new RegExp('^' + cookieName.replace(/\*/g, '.*') + '$', 'i');
        } catch {
          continue;
        }
        for (const [cname, value] of Object.entries(signals.cookies)) {
          if (!cookieNameRegex.test(cname)) continue;
          if (!pattern) {
            matched = true;
            confidence = Math.max(confidence, 100);
          } else {
            const res = this.testPattern(pattern, value);
            if (res.matched) {
              matched = true;
              if (res.version) version = res.version;
              confidence = Math.max(confidence, res.confidence || 100);
            }
          }
        }
      }
    }

    // --- dom ---
    if (tech.dom && signals.dom) {
      const domRules = typeof tech.dom === 'string' ? [tech.dom] :
                        Array.isArray(tech.dom) ? tech.dom : null;

      if (domRules) {
        for (const selector of domRules) {
          if (signals.dom[selector]) {
            matched = true;
            confidence = Math.max(confidence, 100);
          }
        }
      } else {
        for (const [selector, rules] of Object.entries(tech.dom)) {
          const domData = signals.dom[selector];
          if (!domData) continue;
          if (rules.exists !== undefined) {
            matched = true;
            confidence = Math.max(confidence, 100);
          }
          if (rules.text) {
            const res = this.testPattern(rules.text, domData.text || '');
            if (res.matched) {
              matched = true;
              if (res.version) version = res.version;
              confidence = Math.max(confidence, res.confidence || 100);
            }
          }
          if (rules.properties && domData.properties) {
            for (const [prop, pat] of Object.entries(rules.properties)) {
              const propVal = domData.properties[prop];
              if (propVal === undefined) continue;
              if (!pat) {
                matched = true;
                confidence = Math.max(confidence, 100);
              } else {
                const res = this.testPattern(pat, String(propVal));
                if (res.matched) {
                  matched = true;
                  if (res.version) version = res.version;
                  confidence = Math.max(confidence, res.confidence || 100);
                }
              }
            }
          }
          if (rules.attributes && domData.attributes) {
            for (const [attr, pat] of Object.entries(rules.attributes)) {
              const attrVal = domData.attributes[attr];
              if (attrVal === undefined) continue;
              if (!pat) {
                matched = true;
                confidence = Math.max(confidence, 100);
              } else {
                const res = this.testPattern(pat, String(attrVal));
                if (res.matched) {
                  matched = true;
                  if (res.version) version = res.version;
                  confidence = Math.max(confidence, res.confidence || 100);
                }
              }
            }
          }
        }
      }
    }

    // --- js globals ---
    if (tech.js && signals.js) {
      for (const [jsKey, pattern] of Object.entries(tech.js)) {
        const jsVal = signals.js[jsKey];
        if (jsVal === undefined) continue;
        if (!pattern) {
          matched = true;
          confidence = Math.max(confidence, 100);
        } else {
          const res = this.testPattern(pattern, String(jsVal));
          if (res.matched) {
            matched = true;
            if (res.version) version = res.version;
            confidence = Math.max(confidence, res.confidence || 100);
          }
        }
      }
    }

    // --- css (selectors) ---
    if (tech.css && signals.css) {
      const patterns = Array.isArray(tech.css) ? tech.css : [tech.css];
      for (const selector of patterns) {
        if (signals.css[selector]) {
          matched = true;
          confidence = Math.max(confidence, 100);
        }
      }
    }

    if (!matched) return null;

    const cats = (tech.cats || []).map(id => ({
      id,
      name: this.categories[String(id)] || 'Other'
    }));

    return {
      name,
      version,
      confidence,
      categories: cats,
      website: tech.website || null,
      description: tech.description || null,
      icon: tech.icon || null
    };
  }

  _resolveImplies(detected) {
    const toAdd = {};
    let changed = true;
    const maxIterations = 10;
    let iteration = 0;

    while (changed && iteration++ < maxIterations) {
      changed = false;
      const currentDetected = { ...detected, ...toAdd };
      for (const [name, result] of Object.entries(currentDetected)) {
        const tech = this.apps[name];
        if (!tech || !tech.implies) continue;
        const implies = Array.isArray(tech.implies) ? tech.implies : [tech.implies];
        for (const implied of implies) {
          const parts = implied.split('\\;');
          const impliedName = parts[0];
          if (detected[impliedName] || toAdd[impliedName]) continue;
          const impliedTech = this.apps[impliedName];
          if (!impliedTech) continue;
          let impliedConfidence = 100;
          for (let i = 1; i < parts.length; i++) {
            if (parts[i].startsWith('confidence:')) {
              impliedConfidence = parseInt(parts[i].slice(11), 10) || 100;
            }
          }
          const cats = (impliedTech.cats || []).map(id => ({
            id,
            name: this.categories[String(id)] || 'Other'
          }));
          toAdd[impliedName] = {
            name: impliedName,
            version: null,
            confidence: impliedConfidence,
            categories: cats,
            website: impliedTech.website || null,
            description: impliedTech.description || null,
            icon: impliedTech.icon || null,
            implied: true
          };
          changed = true;
        }
      }
    }

    Object.assign(detected, toAdd);
  }
}
