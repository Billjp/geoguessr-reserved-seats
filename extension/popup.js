const status = document.querySelector('#status');
const outgoing = document.querySelector('#outgoing');
const incoming = document.querySelector('#incoming');
const consent = document.querySelector('#consent');
const importButton = document.querySelector('#import');
const seatCount = document.querySelector('#seat-count');
const reservationSummary = document.querySelector('#reservation-summary');
const seats = document.querySelector('#seats');
let busy = false;
let pollTimer;

function updateButtons() {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy || button.dataset.unavailable === 'true'; });
  importButton.disabled = busy || !consent.checked || !incoming.value.trim();
}

async function request(action, fields = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...fields });
  if (!response?.ok) throw new Error(response?.error ?? '拡張に接続できません。');
  return response.result;
}

function renderSeats(result) {
  seats.replaceChildren();
  clearTimeout(pollTimer);
  if (!Array.isArray(result?.seats)) return;
  const plan = result.reservation;
  const phases = { idle: '停止中', checking: '空き枠を確認中', creating: '確保中', holding: '確保済み', halted: '確保を停止', clearing: '停止中' };
  reservationSummary.textContent = result.error ?? (plan
    ? `予約 ${plan.target}席 · ${phases[plan.state] ?? '確認中'}${Number.isInteger(plan.availableToReserve) ? ` · このPartyで確保可能な合計：${plan.availableToReserve}席` : ''}`
    : '予約席数を保存し、主催者のPartyロビーを開いてください。');
  if (plan?.warning === 'PARTY_CAPACITY_EXCEEDED') reservationSummary.textContent += ' · 空き枠が足りません。数を減らすか、Partyの人数・モードを変更してください。';
  for (const seat of result.seats) {
    const card = document.createElement('div');
    card.className = 'seat';
    const title = document.createElement('strong');
    title.textContent = `${seat.nick} · ${seat.partyCode}`;
    const state = document.createElement('p');
    const labels = {
      ready: '接続中', holding: '接続中', connected: '接続中',
      handedOff: '引き継ぎ済み', 'handed-off': '引き継ぎ済み', handed_off: '引き継ぎ済み',
      stopped: '停止', halted: '接続停止', creating: '作成中', failed: '接続失敗',
    };
    state.textContent = labels[seat.state] ?? `状態：${seat.state}`;
    if (seat.selection === 'benched') {
      state.textContent += ' · ベンチ（選手枠に入っていません）';
    } else if (seat.selection === 'candidate') {
      state.textContent += ' · 開始前の選手候補';
    } else if (seat.selection === 'in_game') {
      state.textContent += ' · 進行中の試合の選手';
    }
    const warning = document.createElement('p');
    warning.className = 'note';
    const warnings = {
      SEAT_BENCHED: '主催者の選手枠に入っていません。試合開始前に人数・モードを確認してください。',
      PARTY_ALREADY_PLAYING: '試合開始後には予備席を作れません。次の試合の開始前に作成してください。',
      GUESTS_NOT_ALLOWED: 'このPartyではゲストの参加が許可されていません。',
      NOT_A_PARTY_CODE: 'Partyの参加コードを確認してください。',
      WEBSOCKET_STOPPED: '予備席の接続が切れました。自動再接続は行いません。',
      HANDOFF_EXPIRED: '引き継ぎデータの読み込み期限が切れました。再表示できません。',
    };
    warning.textContent = seat.warning ? warnings[seat.warning] ?? '予備席の処理を停止しました。Partyの状態と接続を確認してください。' : '';
    const row = document.createElement('div');
    row.className = 'row';
    const handoff = document.createElement('button');
    handoff.textContent = seat.state === 'handed_off' ? 'データを再表示' : '引き継ぐ';
    handoff.dataset.unavailable = String(seat.warning === 'HANDOFF_EXPIRED' || !['ready', 'holding', 'connected', 'handed_off'].includes(seat.state));
    handoff.addEventListener('click', () => run('hostHandoff', { seatId: seat.seatId }));
    const stop = document.createElement('button');
    stop.textContent = '停止・一覧から削除';
    stop.className = 'secondary';
    stop.addEventListener('click', () => run('hostStop', { seatId: seat.seatId }));
    row.append(handoff, stop);
    card.append(title, state, warning, row);
    seats.append(card);
  }
  if (result.seats.length === 0) seats.textContent = '予備席はまだありません。';
  if (['checking', 'creating', 'clearing'].includes(plan?.state) || result.seats.some(seat => seat.state === 'creating')) pollTimer = setTimeout(pollSeats, 2000);
}

async function refreshSeats() {
  const result = await request('hostStatus');
  renderSeats(result);
  return result;
}

async function pollSeats() {
  if (busy) { pollTimer = setTimeout(pollSeats, 2000); return; }
  try {
    const result = await refreshSeats();
    if (!['checking', 'creating', 'clearing'].includes(result.reservation?.state)) status.textContent = result.error ?? (result.reservation?.state === 'holding' ? '予約席を確保しました。' : '予約席の状態を確認しました。');
    updateButtons();
  } catch { status.textContent = '自動更新できませんでした。「状態を更新」で確認してください。'; }
}

async function run(action, fields = {}) {
  if (busy) return;
  busy = true;
  status.textContent = action === 'saveReservations' ? '予約席数を保存しています…' : '確認しています…';
  if (action === 'hostHandoff' || action === 'export') outgoing.value = '';
  updateButtons();
  try {
    const result = await request(action, fields);
    if (action === 'export' || action === 'hostHandoff') {
      outgoing.value = result.capsule;
      const expiry = new Date(result.summary.expiresAt).toLocaleTimeString('ja-JP');
      status.textContent = `ゲスト「${result.summary.guest.nick}」の引き継ぎデータを表示しました。読み込み期限は${expiry}です。`;
      if (action === 'hostHandoff') {
        try { await refreshSeats(); } catch { status.textContent += ' 一覧は「状態を更新」で確認してください。'; }
      }
    } else if (action === 'import') {
      incoming.value = '';
      consent.checked = false;
      status.textContent = result.message;
    } else if (action === 'hostStatus') {
      renderSeats(result);
      status.textContent = result.error ?? '予約席の状態を確認しました。';
    } else if (action === 'saveReservations') {
      renderSeats(result);
      status.textContent = result.error ?? result.message ?? (result.configuredCount === 0 ? '予約席を停止しました。' : '設定を保存しました。主催者のロビーで自動的に予約席を確保します。');
    } else if (action === 'hostStop') {
      const current = await refreshSeats();
      status.textContent = '裏の接続を停止し、一覧から削除しました。Partyの名簿には残る場合があります。';
    } else {
      status.textContent = result.ready
        ? `ゲスト「${result.guest.nick}」を確認しました。ID: ${result.guest.id}`
        : result.message;
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '確認に失敗しました。';
  } finally {
    busy = false;
    updateButtons();
  }
}

document.querySelector('#inspect').addEventListener('click', () => run('inspect'));
document.querySelector('#export').addEventListener('click', () => run('export'));
document.querySelector('#refresh').addEventListener('click', () => run('hostStatus'));
document.querySelector('#save').addEventListener('click', () => run('saveReservations', { count: seatCount.value.trim() ? Number(seatCount.value) : null }));
importButton.addEventListener('click', () => run('import', { capsule: incoming.value }));
consent.addEventListener('change', updateButtons);
incoming.addEventListener('input', updateButtons);

// Read only the current tab URL. Failure here does not obstruct receiver use.
request('reservationSettings').then(settings => { seatCount.value = settings.configuredCount; }).catch(() => {});
request('hostStatus').then(result => {
  renderSeats(result);
  updateButtons();
  status.textContent = result.error ?? (result.configuredCount ? '予約席の状態を確認しました。' : '予約席数を保存すると、自動で確保します。');
}).catch(error => { status.textContent = error.message; });
