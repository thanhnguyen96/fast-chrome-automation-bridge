// Google Flow site module. Registers flow.* workflows. Does not run them on load.
(function () {
  const Bridge = window.__fastBridge;
  if (!Bridge) return;
  if (Bridge._sites && Bridge._sites.google_flow) return;
  Bridge._sites = Bridge._sites || {};
  Bridge._sites.google_flow = true;

  // Flow ignores synthetic clicks.
  Bridge.config.trustedClick = true;

  // Same map as selectors/flow.google.com.json; file values win over these defaults.
  const SEL = {
    'flow.newProject': [
      { role: 'button', text: ['New project', 'Dự án mới'] },
      { css: 'button.new-project-button' }
    ],
    'flow.prompt': [
      { role: 'textbox', aria: ['Bạn muốn tạo nội dung gì', 'What do you want to create'] },
      { css: '[contenteditable="true"]' }
    ],
    'flow.submit': { css: 'button', aria: ['Bắt đầu tạo', 'Start generation', 'Create'] },
    // Approve chip in agent chat is a plain <span>, not role=button.
    'flow.approve': { textExact: ['Approve', 'Phê duyệt', 'Chấp thuận'] },
    'flow.tile': 'flow-video-tile',
    // Finished tiles render a thumbnail img (video element only on hover/play).
    'flow.videoTile': 'flow-video-tile video[src], flow-video-tile img.thumbnail',
    'flow.pendingTile': 'flow-pending-tile',
    'flow.progress': '[role="progressbar"], flow-pending-tile .loading-percentage',
    'flow.menuDownload': { role: 'menuitem', text: ['Download', 'Tải xuống'] },
    'flow.quality720': { role: 'menuitem', text: '720p' }
  };

  Bridge.sel.defaults(SEL);

  function isGenerating() {
    return Bridge.findAll('@flow.progress').length > 0;
  }

  function progress() {
    return Array.from(document.querySelectorAll('flow-pending-tile .loading-percentage'))
      .map((el) => (el.textContent || '').trim());
  }

  function counts() {
    return {
      tiles: Bridge.findAll('@flow.tile').length,
      pending: Bridge.findAll('@flow.pendingTile').length,
      videos: Bridge.findAll('@flow.videoTile').length,
      progress: progress(),
      generating: isGenerating(),
      url: location.href
    };
  }

  async function newProject() {
    const res = await Bridge.el.click('@flow.newProject');
    return { clicked: true, detail: res };
  }

  async function submitPrompt(args) {
    const prompt = args.prompt != null ? args.prompt : (args.promptText != null ? args.promptText : args.text);
    if (!prompt) throw new Error('prompt required');
    // Baselines so approveCredits / waitComplete ignore chips and videos from earlier runs.
    Bridge.state.flowApproveBaseline = Bridge.findAll('@flow.approve');
    Bridge.state.flowVideoBaseline = Bridge.findAll('@flow.videoTile').length;
    await Bridge.el.type('@flow.prompt', prompt);
    await Bridge.el.click('@flow.submit');
    return { submitted: true, prompt };
  }

  async function approveCredits(args) {
    const timeout = args && args.timeoutMs != null ? args.timeoutMs : 10000;
    // submitPrompt snapshotted the chips that already existed. Without that, baseline is now.
    const baseline = Bridge.state.flowApproveBaseline || Bridge.findAll('@flow.approve');
    try {
      const chip = await Bridge.el.waitNew('@flow.approve', null, { timeout, baseline });
      await Bridge.el.click(chip);
      return { approved: true };
    } catch (_) {
      return { approved: false };
    }
  }

  async function waitComplete(args) {
    const expectedCount = args && args.expectedCount != null ? args.expectedCount : 1;
    const timeoutMs = args && args.timeoutMs != null ? args.timeoutMs : 600000;
    const baseline = Bridge.state.flowVideoBaseline || 0;
    const target = args && args.expectedTotal != null ? args.expectedTotal : baseline + expectedCount;
    const start = Date.now();
    return Bridge.poll(() => {
      const videos = Bridge.findAll('@flow.videoTile').length;
      const pending = Bridge.findAll('@flow.pendingTile').length;
      if (videos >= target && pending === 0 && !isGenerating()) {
        return {
          completed: true,
          videos,
          tiles: Bridge.findAll('@flow.tile').length,
          elapsedSeconds: Math.round((Date.now() - start) / 1000)
        };
      }
      return null;
    }, { timeoutMs, intervalMs: 1000 });
  }

  // Download finished tiles: right-click > Tải xuống > quality (default 720p = original, no upscale credits).
  async function downloadAll(args) {
    const quality = (args && args.quality) || '720p';
    const baseline = (args && args.newOnly) ? (Bridge.state.flowVideoBaseline || 0) : 0;
    let tiles = Bridge.findAll('@flow.tile')
      .filter((tile) => !tile.querySelector('flow-pending-tile'));
    // Newest tiles render first in the grid.
    if (args && args.newOnly) tiles = tiles.slice(0, Math.max(0, tiles.length - baseline));
    // index: download only that tile (0 = newest, first in grid).
    if (args && args.index != null) tiles = tiles.slice(args.index, args.index + 1);
    if (!tiles.length) throw new Error('No finished video tiles found');
    for (const tile of tiles) {
      await Bridge.el.rightClick(tile);
      await Bridge.el.clickMenu([
        '@flow.menuDownload',
        { role: 'menuitem', text: quality }
      ], { timeout: 5000 });
    }
    return { downloadTriggered: true, count: tiles.length, quality };
  }

  function status() {
    return counts();
  }

  const entries = [
    ['flow.newProject', newProject, 'Open a new Flow project'],
    ['flow.submitPrompt', submitPrompt, 'Type a prompt and start generation'],
    ['flow.approveCredits', approveCredits, 'Approve the credits dialog if it is showing'],
    ['flow.waitComplete', waitComplete, 'Wait until expected videos finish'],
    ['flow.downloadAll', downloadAll, 'Select tiles and choose Download'],
    ['flow.status', status, 'Read-only tile / generation status']
  ];

  for (const [name, fn, description] of entries) {
    Bridge.registerWorkflow(name, fn, { description });
  }
})();
