(() => {
  function apply(theme) {
    document.documentElement.dataset.theme = ['light', 'dark'].includes(theme) ? theme : 'system';
  }
  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getSettings' });
      if (response?.ok) apply(response.settings.theme);
    } catch (_) { /* The OS preference remains usable while the backend starts. */ }
  }
  void refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refresh();
  });
})();
