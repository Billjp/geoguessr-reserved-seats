// The official page only signals its URL. The service worker performs the
// fixed reads and leader check; page messages cannot set counts or get secrets.
(() => {
  if (chrome.extension?.inIncognitoContext) return;
  const lobby = () => /^\/(?:ja\/)?party\/lobby\/[a-z0-9_-]+\/?$/i.test(location.pathname);
  let state;
  let running = false;
  let timer;
  let pendingStartUrl = null;
  let lastUrl = location.href;
  let initialCount = null;
  let releasingStart = false;
  const banner = document.createElement('div');
  banner.setAttribute('role', 'status');
  banner.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483647;max-width:420px;padding:12px 16px;background:#172538;color:#fff;border:1px solid #75d9b0;border-radius:10px;font:14px/1.5 system-ui;box-shadow:0 4px 20px #0008;pointer-events:none';

  function prepared(result) {
    if (result?.context?.gameState !== 'NoGame' || result.error || result.reservation?.state !== 'holding') return false;
    const seats = (result.seats ?? []).filter(seat => seat.partyCode === result.context.partyCode);
    return seats.length === result.configuredCount && seats.every(seat =>
      ['holding', 'handed_off'].includes(seat.state) && ['candidate', 'in_game'].includes(seat.selection));
  }
  function startButton() {
    return [...document.querySelectorAll('button')].find(button =>
      [...button.classList].some(name => name.startsWith('start-button_button__')) &&
      button.closest('[class*="footer_startButton__"]') &&
      button.querySelector('[class*="start-button_startLabel__"]'));
  }
  function render() {
    if (!lobby()) { banner.remove(); pendingStartUrl = null; return; }
    if (state?.enabled && state.error && !state.context) {
      pendingStartUrl = null;
      const text = '予約席の準備を停止しました。拡張で状態を確認してください。';
      if (banner.textContent !== text) banner.textContent = text;
      if (!banner.isConnected) document.documentElement.append(banner);
      return;
    }
    if (!state?.enabled || !state.context?.isLeader) {
      banner.remove();
      if (state && pendingStartUrl === location.href) {
        const button = startButton();
        pendingStartUrl = null;
        if (button && !button.disabled) { releasingStart = true; try { button.click(); } finally { releasingStart = false; } }
      }
      return;
    }
    if (state.context.gameState !== 'NoGame' && pendingStartUrl === location.href) {
      const button = startButton();
      pendingStartUrl = null;
      if (button && !button.disabled) { releasingStart = true; try { button.click(); } finally { releasingStart = false; } }
    }
    const count = state.configuredCount;
    const readyCount = (state.seats ?? []).filter(seat => seat.partyCode === state.context.partyCode &&
      ['holding', 'handed_off'].includes(seat.state) && ['candidate', 'in_game'].includes(seat.selection)).length;
    const stopped = state.error || state.reservation?.state === 'halted';
    const text = state.context.gameState !== 'NoGame' ? `予約席 ${readyCount}/${count} · 試合中`
      : stopped ? `予約席の確保を停止しました。拡張で状態を確認してください。${state.error ?? ''}`
      : prepared(state) ? `予約席 ${readyCount}/${count} · 開始できます`
      : state.reservation?.state === 'clearing' ? '予約席を停止しています'
      : `予約席を確保しています ${readyCount}/${count}${pendingStartUrl ? ' · 揃ったら開始します' : ''}`;
    if (banner.textContent !== text) banner.textContent = text;
    if (!banner.isConnected) document.documentElement.append(banner);
    if (stopped || state.context.gameState !== 'NoGame') pendingStartUrl = null;
    if (prepared(state) && pendingStartUrl === location.href) {
      const button = startButton();
      if (button && !button.disabled) { pendingStartUrl = null; button.click(); }
    }
  }
  async function update() {
    clearTimeout(timer);
    if (!lobby()) { state = null; render(); timer = setTimeout(update, 10000); return; }
    if (running) { timer = setTimeout(update, 2000); return; }
    running = true;
    const requestedUrl = location.href;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'partyObserved' });
      if (requestedUrl === location.href) {
        if (response?.ok) state = response.result;
        else pendingStartUrl = null;
      }
    } catch { if (requestedUrl === location.href) { state = null; pendingStartUrl = null; } }
    finally {
      running = false;
      render();
      timer = setTimeout(update, state?.enabled && !prepared(state) && state.context?.gameState === 'NoGame' ? 2000 : 10000);
    }
  }
  document.addEventListener('click', event => {
    if (releasingStart) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button !== startButton() || !lobby()) return;
    if (!state && initialCount !== 0) {
      event.preventDefault(); event.stopImmediatePropagation();
      pendingStartUrl = location.href;
      update();
      return;
    }
    if (state?.enabled && state.error && !state.context) { event.preventDefault(); event.stopImmediatePropagation(); render(); return; }
    if (!state?.enabled || !state.context?.isLeader || state.context.gameState !== 'NoGame' || prepared(state)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!state.error && state.reservation?.state !== 'halted') pendingStartUrl = location.href;
    render();
    update();
  }, true);
  // SPA navigation does not reload content scripts.
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; pendingStartUrl = null; state = null; update(); }
    else if (pendingStartUrl && prepared(state)) render();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'reservationSettingsChanged') {
      chrome.storage.local.get('reservedSeatCount').then(saved => { initialCount = saved.reservedSeatCount ?? 0; state = null; update(); });
    }
  });
  window.addEventListener('pagehide', () => { clearTimeout(timer); observer.disconnect(); });
  chrome.storage.local.get('reservedSeatCount').then(saved => { initialCount = saved.reservedSeatCount ?? 0; update(); }).catch(update);
})();
