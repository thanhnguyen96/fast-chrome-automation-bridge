// Locator engine + DOM actions. Classic script (isolated world). Idempotent.
(function () {
  const VERSION = '2.5.0';
  if (window.__fastBridge && window.__fastBridge.version === VERSION) return;

  const ROLE_CSS = {
    button: 'button,[role="button"],input[type="button"],input[type="submit"]',
    link: 'a[href],[role="link"]',
    textbox: 'input:not([type="hidden"]),textarea,[contenteditable="true"],[role="textbox"]',
    menuitem: '[role="menuitem"]',
    tab: '[role="tab"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    option: '[role="option"],option'
  };

  function fail(message, code) {
    const err = new Error(message);
    err.code = code || 'CONTENT_ERROR';
    return err;
  }

  function isRef(value) {
    return typeof value === 'string' && value.charAt(0) === '@';
  }

  function isXPathString(value) {
    return typeof value === 'string' && (value.charAt(0) === '/' || value.charAt(0) === '(' || value.slice(0, 2) === './');
  }

  // Locator may be a string, an object, or an array of fallback locators.
  function normLoc(loc) {
    if (loc == null) return {};
    if (Array.isArray(loc)) return loc;
    if (typeof loc === 'string') {
      if (isRef(loc)) return { ref: loc };
      if (isXPathString(loc)) return { xpath: loc };
      return { css: loc };
    }
    return loc;
  }

  // NFC + collapsed whitespace (incl. nbsp) so Vietnamese text matches regardless of source encoding.
  function norm(value) {
    return String(value == null ? '' : value).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function matchPattern(value, pattern) {
    if (pattern == null) return true;
    if (Array.isArray(pattern)) return pattern.some((p) => matchPattern(value, p));
    const hay = norm(value);
    if (typeof pattern === 'object' && pattern.regex) {
      return new RegExp(pattern.regex, pattern.flags == null ? 'i' : pattern.flags).test(hay);
    }
    return hay.includes(norm(pattern));
  }

  function matchExact(value, pattern) {
    const hay = norm(value);
    const list = Array.isArray(pattern) ? pattern : [pattern];
    return list.some((p) => {
      if (p && typeof p === 'object' && p.regex) {
        return new RegExp(p.regex, p.flags == null ? 'i' : p.flags).test(hay);
      }
      return hay === norm(p);
    });
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    return el.getAttribute('aria-disabled') !== 'true';
  }

  function roleSelector(role) {
    if (ROLE_CSS[role]) return ROLE_CSS[role];
    const safe = window.CSS && CSS.escape ? CSS.escape(role) : role.replace(/"/g, '');
    return `[role="${safe}"]`;
  }

  function queryAll(root, css, deep) {
    let out;
    try {
      out = Array.from(root.querySelectorAll(css));
    } catch (err) {
      throw fail(`Bad CSS ${css}: ${err.message}`, 'BAD_LOCATOR');
    }
    if (!deep) return out;
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) out = out.concat(queryAll(host.shadowRoot, css, true));
    }
    return out;
  }

  function queryXPath(root, expr) {
    let snapshot;
    try {
      snapshot = document.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (err) {
      throw fail(`Bad XPath ${expr}: ${err.message}`, 'BAD_LOCATOR');
    }
    const out = [];
    for (let i = 0; i < snapshot.snapshotLength; i++) {
      const node = snapshot.snapshotItem(i);
      if (node && node.nodeType === 1) out.push(node);
    }
    return out;
  }

  function passes(el, loc) {
    if (loc.role) {
      const attr = (el.getAttribute('role') || '').toLowerCase();
      const implicit = ROLE_CSS[loc.role] ? el.matches(ROLE_CSS[loc.role]) : false;
      if (attr !== loc.role.toLowerCase() && !implicit) return false;
    }
    if (loc.text != null && !matchPattern(el.innerText || el.textContent, loc.text)) return false;
    if (loc.textExact != null && !matchExact(el.innerText || el.textContent, loc.textExact)) return false;
    if (loc.aria != null && !matchPattern(el.getAttribute('aria-label'), loc.aria)) return false;
    if (loc.placeholder != null && !matchPattern(el.getAttribute('placeholder'), loc.placeholder)) return false;
    if (loc.visible !== false && !isVisible(el)) return false;
    return true;
  }

  function innermost(list) {
    return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }

  // ---- selector dictionary -------------------------------------------------

  const dict = Object.create(null);   // name -> locator | locator[]
  const defaults = Object.create(null);
  let dictLoaded = false;

  const config = { trustedClick: false };

  function dictGet(name) {
    if (Object.prototype.hasOwnProperty.call(dict, name)) return dict[name];
    if (Object.prototype.hasOwnProperty.call(defaults, name)) return defaults[name];
    return undefined;
  }

  function pageDomain() {
    return location.protocol === 'file:' ? '_file' : (location.hostname || '_file');
  }

  function applyDict(data) {
    for (const key of Object.keys(dict)) delete dict[key];
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (key === '_meta') continue;
        dict[key] = data[key];
      }
    }
    dictLoaded = true;
  }

  function askSelectors(domain) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'selectors_get', domain }, (res) => {
          if (chrome.runtime.lastError || !res || res.ok !== true) resolve({});
          else resolve(res.data || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  async function loadSelectors(force) {
    if (dictLoaded && !force) return dict;
    const data = await askSelectors(pageDomain());
    applyDict(data);
    const meta = data && data._meta;
    if (meta && meta.trustedClick === true) config.trustedClick = true;
    return dict;
  }

  async function ensureDict() {
    if (!dictLoaded) await loadSelectors(false);
  }

  // Merge caller overrides into one resolved locator object.
  function withOverrides(base, overrides) {
    const out = Object.assign({}, base);
    if (!overrides) return out;
    for (const key of ['nth', 'within', 'visible', 'text', 'textExact', 'aria', 'placeholder', 'role', 'css', 'xpath']) {
      if (overrides[key] !== undefined) out[key] = overrides[key];
    }
    return out;
  }

  // Turn a locator (string/object/array, possibly @ref) into a flat list of plain locators.
  function expand(loc, overrides, stack) {
    const n = normLoc(loc);
    if (Array.isArray(n)) {
      const out = [];
      for (const item of n) out.push(...expand(item, overrides, stack));
      return out;
    }
    // {ref: <locator object|array>, ...overrides}: inline locator, not a dictionary name.
    if (n.ref != null && typeof n.ref !== 'string') {
      const rest = {};
      for (const key of Object.keys(n)) if (key !== 'ref') rest[key] = n[key];
      return expand(n.ref, Object.assign(rest, overrides || {}), stack);
    }
    if (n.ref != null) {
      const name = String(n.ref).replace(/^@/, '');
      if (!dictLoaded) throw fail(`Selectors not loaded (ref @${name})`, 'SELECTORS_NOT_LOADED');
      const value = dictGet(name);
      if (value === undefined) throw fail(`Unknown selector @${name}`, 'UNKNOWN_SELECTOR');
      if (stack.indexOf(name) !== -1) throw fail(`Selector cycle @${name}`, 'BAD_LOCATOR');
      const merged = {};
      for (const key of Object.keys(n)) if (key !== 'ref') merged[key] = n[key];
      if (overrides) Object.assign(merged, overrides);
      return expand(value, merged, stack.concat(name));
    }
    let out = n;
    if (overrides) out = withOverrides(n, overrides);
    if (out.within != null) {
      const parents = expand(out.within, null, stack);
      return parents.map((parent) => Object.assign({}, out, { within: parent }));
    }
    return [out];
  }

  // ---- matching ------------------------------------------------------------

  function collect(loc, deep) {
    let scope = document;
    if (loc.within) {
      const parent = find(loc.within);
      if (!parent) return [];
      scope = parent;
    }
    let list;
    if (loc.xpath) list = queryXPath(scope, loc.xpath);
    else {
      const css = loc.css || (loc.role ? roleSelector(loc.role) : '*');
      list = queryAll(scope, css, deep);
    }
    list = list.filter((el) => passes(el, loc));
    if (loc.text != null || loc.textExact != null) list = innermost(list);
    return list;
  }

  function search(loc) {
    const light = collect(loc, false);
    if (light.length) return light;
    return collect(loc, true);
  }

  function pickNth(list, nth) {
    const i = nth || 0;
    return list[i < 0 ? list.length + i : i] || null;
  }

  // First fallback alternative that matches anything wins.
  function searchExpanded(loc) {
    const alts = expand(loc, null, []);
    for (let i = 0; i < alts.length; i++) {
      const list = search(alts[i]);
      if (list.length) return { list, alt: alts[i], index: i };
    }
    return { list: [], alt: alts[0] || null, index: -1 };
  }

  // Legacy callers (dom.query) pass a single plain locator and read .nth on it.
  function plainLoc(loc) {
    const n = normLoc(loc);
    return Array.isArray(n) ? (n[0] || {}) : n;
  }

  function find(loc) {
    const alts = expand(loc, null, []);
    for (const alt of alts) {
      const list = search(alt);
      if (list.length) return pickNth(list, alt.nth);
    }
    return null;
  }

  function findAll(loc) {
    return searchExpanded(loc).list;
  }

  function describe(el, index) {
    const rect = el.getBoundingClientRect();
    const classes = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    return {
      index,
      tag: el.tagName.toLowerCase(),
      text: String(el.innerText || el.textContent || '').trim().slice(0, 120),
      aria: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      href: el.getAttribute('href'),
      id: el.id || null,
      classes,
      visible: isVisible(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    };
  }

  function pointOpts(el, extra) {
    const rect = el.getBoundingClientRect();
    return Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }, extra || {});
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function poll(fn, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 30000;
    const intervalMs = (opts && opts.intervalMs) || 250;
    const start = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - start >= timeoutMs) throw fail('poll timed out', 'TIMEOUT');
      await sleep(intervalMs);
    }
  }

  function matchesState(el, state) {
    if (state === 'hidden') return !el || !isVisible(el);
    if (state === 'attached') return !!el;
    return !!(el && isVisible(el));
  }

  function waitFor(loc, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 15000;
    const state = (opts && opts.state) || 'visible';
    const n = normLoc(loc);
    return new Promise((resolve, reject) => {
      let settled = false;
      const obs = new MutationObserver(tick);
      const timer = setInterval(tick, 250);
      const killer = setTimeout(() => finish(fail(`Timeout waiting for ${JSON.stringify(n)}`, 'TIMEOUT')), timeoutMs);

      function finish(err, el) {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        clearInterval(timer);
        obs.disconnect();
        if (err) reject(err);
        else resolve(el || null);
      }

      function tick() {
        let el = null;
        try {
          el = find(n);
        } catch (err) {
          finish(err);
          return;
        }
        if (matchesState(el, state)) finish(null, el);
      }

      if (document.documentElement) {
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      }
      tick();
    });
  }

  async function click(target) {
    const el = target instanceof Element ? target : find(target);
    if (!el) throw fail(`click: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const opts = pointOpts(el);
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') el.click();
    return { clicked: true, tag: el.tagName.toLowerCase() };
  }

  // Real (isTrusted) input via background CDP, for pages that ignore synthetic events.
  function trusted(msg) {
    return chrome.runtime.sendMessage({ type: 'trusted_input', ...msg }).then((res) => {
      if (!res || !res.ok) throw fail((res && res.error && res.error.message) || 'trusted input failed', 'TRUSTED_INPUT_FAILED');
      return res.data;
    });
  }

  async function trustedClick(target, opts) {
    const el = target instanceof Element ? target : find(target);
    if (!el) throw fail(`trustedClick: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return trusted({
      kind: 'click',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      button: opts && opts.button
    });
  }

  async function rightClick(target) {
    const el = target instanceof Element ? target : find(target);
    if (!el) throw fail(`rightClick: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const opts = pointOpts(el, { button: 2, buttons: 2 });
    el.dispatchEvent(new MouseEvent('contextmenu', opts));
    return { contextMenuTriggered: true };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  async function type(target, value, opts) {
    const el = target instanceof Element ? target : find(target);
    if (!el) throw fail(`type: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    const clear = !opts || opts.clear !== false;
    const text = value == null ? '' : String(value);
    el.focus();
    if (el.isContentEditable) {
      if (clear) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) {
        el.innerText = clear ? text : (el.innerText || '') + text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else {
      setNativeValue(el, clear ? text : (el.value || '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (opts && opts.submit) press(el, 'Enter');
    return { typed: true, length: text.length };
  }

  function press(target, key) {
    const el = target instanceof Element ? target : (target ? find(target) : document.activeElement);
    if (!el) throw fail(`press: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    if (!key) throw fail('press: key required', 'BAD_REQUEST');
    if (typeof el.focus === 'function') el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true }));
    }
    return { pressed: key };
  }

  function scroll(target, opts) {
    const o = opts || {};
    const el = target instanceof Element
      ? target
      : (target ? find(target) : (document.scrollingElement || document.documentElement));
    if (!el) throw fail(`scroll: not found ${JSON.stringify(target)}`, 'NOT_FOUND');
    if (o.to === 'top') el.scrollTo({ top: 0, left: 0 });
    else if (o.to === 'bottom') el.scrollTo({ top: el.scrollHeight, left: 0 });
    else el.scrollBy({ left: o.x || 0, top: o.y || 0 });
    return { scrolled: true };
  }

  // ---- element API ---------------------------------------------------------

  function refLabel(ref) {
    try { return JSON.stringify(ref); } catch (_) { return String(ref); }
  }

  // MutationObserver + interval. fn returns a truthy value to resolve, or null to keep waiting.
  function waitUntil(fn, opts) {
    const o = opts || {};
    const timeout = o.timeout != null ? o.timeout : 15000;
    const interval = o.interval != null ? o.interval : 250;
    const label = o.label || '';
    const start = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const obs = new MutationObserver(tick);
      const timer = setInterval(tick, interval);
      const killer = setTimeout(() => {
        finish(fail(`Timeout waiting for ${label} after ${Date.now() - start}ms`, 'TIMEOUT'));
      }, timeout);

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        clearInterval(timer);
        obs.disconnect();
        if (err) reject(err);
        else resolve(value);
      }

      function tick() {
        let value;
        try {
          value = fn();
        } catch (err) {
          finish(err);
          return;
        }
        if (value) finish(null, value);
      }

      if (document.documentElement) {
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      }
      tick();
    });
  }

  function wantsTrusted(opts) {
    const mode = !opts || opts.trusted == null ? 'auto' : opts.trusted;
    if (mode === true) return true;
    if (mode === false) return false;
    return config.trustedClick === true;
  }

  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || '');
  }

  function textMatches(el, pattern) {
    if (pattern && typeof pattern === 'object' && pattern.regex) {
      return new RegExp(pattern.regex, pattern.flags == null ? 'i' : pattern.flags).test(textOf(el));
    }
    return matchPattern(textOf(el), pattern);
  }

  const elApi = {
    async find(ref) {
      await ensureDict();
      return find(ref);
    },
    async findAll(ref) {
      await ensureDict();
      return findAll(ref);
    },
    async exists(ref) {
      await ensureDict();
      return find(ref) != null;
    },
    async count(ref) {
      await ensureDict();
      return findAll(ref).length;
    },
    async waitAppear(ref, opts) {
      await ensureDict();
      if (ref instanceof Element) return ref;
      return waitUntil(() => find(ref), Object.assign({ label: refLabel(ref) }, opts));
    },
    async waitDisappear(ref, opts) {
      await ensureDict();
      await waitUntil(() => (find(ref) ? null : true), Object.assign({ label: refLabel(ref) + ' to disappear' }, opts));
      return true;
    },
    async waitEnabled(ref, opts) {
      await ensureDict();
      return waitUntil(() => {
        const el = find(ref);
        return el && isVisible(el) && isEnabled(el) ? el : null;
      }, Object.assign({ label: refLabel(ref) + ' to be enabled' }, opts));
    },
    async waitText(ref, pattern, opts) {
      await ensureDict();
      return waitUntil(() => {
        const el = find(ref);
        return el && textMatches(el, pattern) ? el : null;
      }, Object.assign({ label: refLabel(ref) + ' text' }, opts));
    },
    async waitCount(ref, n, opts) {
      await ensureDict();
      const op = (opts && opts.op) || '==';
      const got = await waitUntil(() => {
        const count = findAll(ref).length;
        const ok = op === '>=' ? count >= n : op === '<=' ? count <= n : count === n;
        return ok ? count : null;
      }, Object.assign({ label: refLabel(ref) + ' count ' + op + ' ' + n }, opts));
      return got;
    },
    // Snapshot current matches, optionally run action(), then wait for an element not in the snapshot.
    // opts.baseline (array of elements) replaces the snapshot, for baselines taken by an earlier call.
    async waitNew(ref, action, opts) {
      await ensureDict();
      const seen = new Set((opts && opts.baseline) || findAll(ref));
      if (typeof action === 'function') await action();
      return waitUntil(() => findAll(ref).find((el) => !seen.has(el)) || null, Object.assign({ label: 'new ' + refLabel(ref) }, opts));
    },
    async click(ref, opts) {
      await ensureDict();
      const o = opts || {};
      // An element handed in directly (waitNew result, clickMenu step) is used as-is.
      const el = ref instanceof Element ? ref : await waitUntil(() => {
        const found = find(ref);
        return found && isVisible(found) && isEnabled(found) ? found : null;
      }, { timeout: o.waitTimeout != null ? o.waitTimeout : 5000, interval: o.interval, label: refLabel(ref) + ' to be enabled' });
      const res = wantsTrusted(o)
        ? await trustedClick(el, { button: o.button })
        : await click(el);
      if (o.delay) await sleep(o.delay);
      return res;
    },
    async rightClick(ref, opts) {
      await ensureDict();
      const o = Object.assign({}, opts, { button: 'right' });
      if (wantsTrusted(o)) return elApi.click(ref, o);
      const el = ref instanceof Element ? ref : await waitUntil(() => find(ref), { timeout: o.waitTimeout != null ? o.waitTimeout : 5000, interval: o.interval, label: refLabel(ref) });
      const res = await rightClick(el);
      if (o.delay) await sleep(o.delay);
      return res;
    },
    async type(ref, text, opts) {
      await ensureDict();
      const o = opts || {};
      const el = ref instanceof Element ? ref : find(ref);
      if (!el) throw fail(`type: not found ${refLabel(ref)}`, 'NOT_FOUND');
      if (wantsTrusted(o)) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof el.focus === 'function') el.focus();
        if (o.clear !== false) {
          await type(el, '', { clear: true });
          await trusted({ kind: 'key', key: 'Delete' });
        }
        const res = await trusted({ kind: 'text', text: text == null ? '' : String(text) });
        if (o.submit) await trusted({ kind: 'key', key: 'Enter' });
        return res;
      }
      return type(el, text, { clear: o.clear !== false, submit: !!o.submit });
    },
    async press(key, opts) {
      await ensureDict();
      const o = opts || {};
      if (wantsTrusted(o)) {
        if (o.ref != null) {
          const el = find(o.ref);
          if (el && typeof el.focus === 'function') el.focus();
        }
        return trusted({ kind: 'key', key });
      }
      return press(o.ref || null, key);
    },
    async hover(ref) {
      await ensureDict();
      const el = find(ref);
      if (!el) throw fail(`hover: not found ${refLabel(ref)}`, 'NOT_FOUND');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return trusted({
        kind: 'move',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      });
    },
    async text(ref) {
      await ensureDict();
      const el = find(ref);
      if (!el) throw fail(`text: not found ${refLabel(ref)}`, 'NOT_FOUND');
      return textOf(el).trim();
    },
    async attr(ref, name) {
      await ensureDict();
      const el = find(ref);
      if (!el) throw fail(`attr: not found ${refLabel(ref)}`, 'NOT_FOUND');
      return el.getAttribute(name);
    },
    // Each path item: wait until it appears, then click. delay (default 300) between clicks.
    async clickMenu(path, opts) {
      await ensureDict();
      const o = opts || {};
      const delay = o.delay != null ? o.delay : 300;
      const clicked = [];
      for (const item of path || []) {
        const el = await elApi.waitAppear(item, { timeout: o.timeout, interval: o.interval });
        await elApi.click(el instanceof Element ? el : item, { trusted: o.trusted, button: o.button, delay });
        clicked.push(el instanceof Element ? describe(el, clicked.length) : item);
      }
      return { clicked: clicked.length };
    }
  };

  // Content actions serialize elements; payload.locator is an alias of payload.ref.
  function refOf(payload) {
    return payload.ref != null ? payload.ref : payload.locator;
  }

  function described(el) {
    return el instanceof Element ? describe(el, 0) : el;
  }

  const elActions = {
    async 'el.click'(payload) {
      return elApi.click(refOf(payload), payload);
    },
    async 'el.rightClick'(payload) {
      return elApi.rightClick(refOf(payload), payload);
    },
    async 'el.type'(payload) {
      return elApi.type(refOf(payload), payload.value != null ? payload.value : payload.text, payload);
    },
    async 'el.press'(payload) {
      return elApi.press(payload.key, payload);
    },
    async 'el.hover'(payload) {
      return elApi.hover(refOf(payload));
    },
    async 'el.waitAppear'(payload) {
      return { element: described(await elApi.waitAppear(refOf(payload), payload)) };
    },
    async 'el.waitDisappear'(payload) {
      return { gone: await elApi.waitDisappear(refOf(payload), payload) };
    },
    async 'el.waitEnabled'(payload) {
      return { element: described(await elApi.waitEnabled(refOf(payload), payload)) };
    },
    async 'el.waitText'(payload) {
      return { element: described(await elApi.waitText(refOf(payload), payload.text != null ? payload.text : payload.pattern, payload)) };
    },
    async 'el.waitCount'(payload) {
      return { count: await elApi.waitCount(refOf(payload), payload.n != null ? payload.n : payload.count, payload) };
    },
    async 'el.text'(payload) {
      return { text: await elApi.text(refOf(payload)) };
    },
    async 'el.attr'(payload) {
      return { value: await elApi.attr(refOf(payload), payload.name) };
    },
    async 'el.count'(payload) {
      return { count: await elApi.count(refOf(payload)) };
    },
    // Test-only: content cannot hand an element back, so the action adds the node itself.
    async 'el.waitNew'(payload) {
      await ensureDict();
      const el = await elApi.waitNew(refOf(payload), () => {
        if (!payload.spawn) return;
        const node = document.createElement(payload.spawn.tag || 'span');
        if (payload.spawn.id) node.id = payload.spawn.id;
        if (payload.spawn.className) node.className = payload.spawn.className;
        node.textContent = payload.spawn.text || '';
        (payload.spawn.parent ? document.querySelector(payload.spawn.parent) : document.body).appendChild(node);
      }, payload);
      return { element: described(el) };
    },
    async 'el.clickMenu'(payload) {
      return elApi.clickMenu(payload.path, payload);
    },
    // Reload the dictionary from the server (after sel.add / sel.remove wrote the file).
    async 'sel.sync'() {
      await loadSelectors(true);
      return { names: Object.keys(dict) };
    },
    // Match each named selector (or every name when omitted). Reports which fallback matched.
    // payload.entries overlays the dict for this call only, so sel.add can test before saving.
    async 'sel.test'(payload) {
      await ensureDict();
      const overlay = payload.entries && typeof payload.entries === 'object' ? payload.entries : null;
      const shadowed = {};
      if (overlay) {
        for (const key of Object.keys(overlay)) {
          if (key === '_meta') continue;
          shadowed[key] = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
          dict[key] = overlay[key];
        }
      }
      const names = payload.names && payload.names.length
        ? payload.names
        : Object.keys(dict).concat(Object.keys(defaults).filter((k) => !Object.prototype.hasOwnProperty.call(dict, k)));
      const results = [];
      for (const name of names) {
        if (dictGet(name) === undefined) {
          results.push({ name, error: 'UNKNOWN_SELECTOR' });
          continue;
        }
        const found = searchExpanded('@' + name);
        const row = {
          name,
          count: found.list.length,
          firstAlt: found.index,
          sample: found.list[0] ? describe(found.list[0], 0) : null
        };
        if (found.list.length === 0 || found.list.length > 20) {
          row.warning = found.list.length === 0 ? 'count 0' : 'count ' + found.list.length + ' > 20';
        }
        results.push(row);
      }
      if (overlay) {
        for (const key of Object.keys(shadowed)) {
          if (shadowed[key] === undefined) delete dict[key];
          else dict[key] = shadowed[key];
        }
      }
      return results;
    }
  };

  const workflows = new Map();

  function registerWorkflow(name, fn, meta) {
    workflows.set(name, { fn, description: (meta && meta.description) || '' });
  }

  const actions = {
    'dom.query'(payload) {
      const loc = plainLoc(payload.locator == null ? '*' : payload.locator);
      if (payload.locator == null) loc.visible = false;
      const limit = payload.limit == null ? 50 : payload.limit;
      const start = loc.nth || 0;
      return findAll(loc).slice(start, start + limit).map((el, i) => describe(el, start + i));
    },
    'dom.read'(payload) {
      const prop = payload.prop || payload.property || 'innerText';
      const loc = payload.locator;
      if (prop === 'title' || loc === 'title') return { value: document.title };
      if (prop === 'url' || loc === 'url') return { value: location.href };
      const el = find(loc == null ? 'body' : loc);
      if (!el) return { value: null, notFound: true };
      let value;
      if (prop === 'innerText') value = el.innerText;
      else if (prop in el) value = el[prop];
      else value = el.getAttribute(prop);
      if (value == null) value = el.textContent;
      return { value };
    },
    'dom.exists'(payload) {
      const count = findAll(payload.locator).length;
      return { exists: count > 0, count };
    },
    async 'dom.waitFor'(payload) {
      const state = payload.state || 'visible';
      const el = await waitFor(payload.locator, { timeoutMs: payload.timeoutMs || 15000, state });
      return { state, matched: true, element: el ? describe(el, 0) : null };
    },
    'dom.click'(payload) {
      return click(payload.locator);
    },
    // Scroll element into view and return its center in CSS viewport pixels (for trusted input).
    'dom.locate'(payload) {
      const el = find(payload.locator);
      if (!el) throw fail(`locate: not found ${JSON.stringify(payload.locator)}`, 'NOT_FOUND');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (payload.focus && typeof el.focus === 'function') el.focus();
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        tag: el.tagName.toLowerCase()
      };
    },
    'dom.rightClick'(payload) {
      return rightClick(payload.locator);
    },
    'dom.type'(payload) {
      return type(payload.locator, payload.value, { clear: payload.clear !== false, submit: !!payload.submit });
    },
    'dom.press'(payload) {
      return press(payload.locator, payload.key);
    },
    'dom.scroll'(payload) {
      return scroll(payload.locator, payload);
    },
    async 'workflow.run'(payload) {
      await ensureDict();
      const entry = workflows.get(payload.name);
      if (!entry) throw fail(`Workflow '${payload.name}' not registered`, 'UNKNOWN_WORKFLOW');
      return entry.fn(payload.args || {}, api);
    },
    'workflow.list'() {
      return Array.from(workflows.keys());
    }
  };

  Object.assign(actions, elActions);

  const selApi = {
    // Memory only; not persisted. File values (dict) win over these.
    define(map) {
      if (!map) return;
      for (const key of Object.keys(map)) {
        if (key === '_meta') continue;
        dict[key] = map[key];
      }
    },
    // Merged under file values: a file entry always wins.
    defaults(map) {
      if (!map) return;
      for (const key of Object.keys(map)) {
        if (key === '_meta') continue;
        defaults[key] = map[key];
      }
    },
    get: dictGet,
    names() {
      const set = {};
      for (const key of Object.keys(defaults)) set[key] = defaults[key];
      for (const key of Object.keys(dict)) set[key] = dict[key];
      return set;
    }
  };

  const state = {};

  const api = {
    version: VERSION,
    find,
    findAll,
    waitFor,
    describe,
    click,
    trustedClick,
    trustedKey: (key) => trusted({ kind: 'key', key }),
    trustedText: (text) => trusted({ kind: 'text', text }),
    rightClick,
    type,
    press,
    scroll,
    sleep,
    poll,
    registerWorkflow,
    loadSelectors,
    config,
    state,
    sel: selApi,
    el: elApi,
    actions
  };

  window.__fastBridge = api;
})();
