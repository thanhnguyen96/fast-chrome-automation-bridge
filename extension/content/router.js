// Routes background messages to Bridge.actions. Classic script.
(function () {
  if (window.__fastBridgeRouter) return;
  window.__fastBridgeRouter = true;

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const Bridge = window.__fastBridge;
    if (!Bridge) {
      sendResponse({ ok: false, error: { message: 'Bridge core missing', code: 'NO_BRIDGE' } });
      return;
    }
    if (request.action === '__ping') {
      sendResponse({ ok: true, data: { version: Bridge.version } });
      return;
    }
    const fn = Bridge.actions && Bridge.actions[request.action];
    if (!fn) {
      sendResponse({ ok: false, error: { message: `Unknown action: ${request.action}`, code: 'UNKNOWN_ACTION' } });
      return;
    }
    // Load the selector dictionary before any action so sync find() can resolve @refs.
    Promise.resolve()
      .then(() => (Bridge.loadSelectors ? Bridge.loadSelectors() : null))
      .then(() => fn(request.payload || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({
        ok: false,
        error: { message: err.message || String(err), code: err.code || 'CONTENT_ERROR' }
      }));
    return true;
  });
})();
