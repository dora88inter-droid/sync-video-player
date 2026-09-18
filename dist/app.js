(() => {
  'use strict';

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const role = parts[0] === 'admin' || parts[0] === 'watch' ? parts[0] : 'home';
  const roomId = parts[1] || 'test001';
  const query = new URLSearchParams(location.search);
  const debugMode = query.get('debug') === '1';
  const roomKey = `sync-video-room:${roomId}`;
  const presencePrefix = `sync-video-presence:${roomId}:`;
  const clientId = sessionStorage.getItem('sync-video-client') || `viewer-${crypto.randomUUID().slice(0, 8)}`;
  sessionStorage.setItem('sync-video-client', clientId);
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(roomKey) : null;
  const config = window.SYNC_CONFIG || {};

  let player = null;
  let currentState = readState();
  let transportMode = 'local';
  let supabaseClient = null;
  let realtimeChannel = null;
  let clockOffset = 0;
  let currentMediaKey = '';
  let playerLoadPromise = null;
  let ready = false;
  let actualTime = 0;
  let duration = 0;
  let scheduledTimer = null;
  let driftTimer = null;
  let uiTimer = null;
  let heartbeatTimer = null;

  function syncedNow() { return Date.now() + clockOffset; }

  function defaultState() {
    return { version: 0, provider: null, videoId: null, status: 'paused', position: 0, anchorTime: syncedNow(), executeAt: null, updatedAt: syncedNow() };
  }
  function readState() {
    try { return JSON.parse(localStorage.getItem(roomKey)) || defaultState(); }
    catch { return defaultState(); }
  }
  function expectedPosition(state = currentState, now = syncedNow()) {
    if (!state || state.status !== 'playing') return Math.max(0, state?.position || 0);
    const start = state.executeAt || state.anchorTime;
    if (now < start) return Math.max(0, state.position || 0);
    return Math.max(0, (state.position || 0) + (now - start) / 1000);
  }
  function mapRemoteState(row) {
    if (!row) return null;
    return {
      version: Number(row.version || 0), provider: row.provider || null,
      videoId: row.video_id || null, hash: row.video_hash || '',
      status: row.status || 'paused', position: Number(row.position || 0),
      anchorTime: row.anchor_time ? Date.parse(row.anchor_time) : syncedNow(),
      executeAt: row.execute_at ? Date.parse(row.execute_at) : null,
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : syncedNow()
    };
  }
  async function publish(next) {
    if (transportMode === 'supabase') {
      const code = localStorage.getItem(`sync-admin-code:${roomId}`) || '';
      if (!code) { showNotice('管理コードを入力してください。', true); return null; }
      const payload = {
        provider: next.provider, videoId: next.videoId, hash: next.hash || '',
        status: next.status, position: next.position,
        anchorTime: next.anchorTime, executeAt: next.executeAt
      };
      const { data, error } = await supabaseClient.rpc('control_room', {
        p_room_id: roomId, p_admin_code: code, p_state: payload
      });
      if (error) { showNotice(error.message.includes('invalid admin code') ? '管理コードが違います。' : '同期サーバーへの保存に失敗しました。', true); return null; }
      const state = mapRemoteState(data);
      accept(state); return state;
    }
    const state = { ...next, version: (currentState?.version || 0) + 1, updatedAt: syncedNow() };
    currentState = state;
    localStorage.setItem(roomKey, JSON.stringify(state));
    channel?.postMessage({ kind: 'state', state });
    applyState(state);
    return state;
  }
  function accept(state) {
    if (!state || state.version < (currentState?.version || 0)) return;
    currentState = state;
    applyState(state);
  }
  channel?.addEventListener('message', event => transportMode === 'local' && event.data?.kind === 'state' && accept(event.data.state));
  window.addEventListener('storage', event => transportMode === 'local' && event.key === roomKey && event.newValue && accept(JSON.parse(event.newValue)));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (transportMode === 'supabase') refreshRemoteState();
    else accept(readState());
  });

  async function refreshRemoteState() {
    if (!supabaseClient) return;
    await syncClock();
    const { data } = await supabaseClient.from('rooms').select('*').eq('id', roomId).maybeSingle();
    if (data) accept(mapRemoteState(data));
  }

  function setConnection(text, remote = false) {
    const el = document.getElementById('connectionStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('remote', remote);
  }
  async function syncClock() {
    const sent = Date.now();
    const { data, error } = await supabaseClient.rpc('server_time_ms');
    const received = Date.now();
    if (!error && data) clockOffset = Number(data) - (sent + received) / 2;
  }
  async function initTransport() {
    if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase?.createClient) {
      setConnection('ローカル同期'); return;
    }
    try {
      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
      await syncClock();
      const { data, error } = await supabaseClient.from('rooms').select('*').eq('id', roomId).maybeSingle();
      if (error) throw error;
      transportMode = 'supabase';
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      document.body.classList.add('remote-mode');
      if (data) { currentState = mapRemoteState(data); applyState(currentState); }
      realtimeChannel = supabaseClient.channel(`room:${roomId}`, { config: { presence: { key: clientId, enabled: true } } });
      realtimeChannel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, event => accept(mapRemoteState(event.new)))
        .on('presence', { event: 'sync' }, updateCounts)
        .subscribe(status => {
          if (status === 'SUBSCRIBED') { setConnection('端末間同期', true); writePresence(); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('再接続中…');
        });
    } catch (error) {
      console.error(error);
      setConnection('接続エラー');
      showNotice('同期サーバーへ接続できません。', true);
    }
  }

  function detectVideo(value) {
    let url;
    try { url = new URL(value.trim()); } catch { return null; }
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ? { provider: 'youtube', videoId: id } : null;
    }
    if (['youtube.com', 'm.youtube.com'].includes(host)) {
      const id = url.searchParams.get('v') || (url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : null);
      return id ? { provider: 'youtube', videoId: id } : null;
    }
    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = url.pathname.split('/').filter(Boolean).find(part => /^\d+$/.test(part));
      return id ? { provider: 'vimeo', videoId: id, hash: url.searchParams.get('h') || '' } : null;
    }
    return null;
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '00:00';
    const value = Math.max(0, Math.floor(seconds));
    const m = Math.floor(value / 60);
    const s = value % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function toast(message) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = message; document.body.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  class VimeoAdapter {
    constructor(el, state) {
      const options = { id: Number(state.videoId), responsive: true, controls: true, playsinline: true };
      if (state.hash) options.h = state.hash;
      this.instance = new Vimeo.Player(el, options);
    }
    async ready() { await this.instance.ready(); duration = await this.instance.getDuration(); }
    play() { return this.instance.play(); }
    pause() { return this.instance.pause(); }
    seek(value) { return this.instance.setCurrentTime(Math.max(0, value)); }
    time() { return this.instance.getCurrentTime(); }
    destroy() { return this.instance.destroy(); }
  }
  class YouTubeAdapter {
    constructor(el, state) {
      this.readyPromise = new Promise((resolve, reject) => {
        const start = () => {
          this.instance = new YT.Player(el, {
            videoId: state.videoId,
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
            events: { onReady: resolve, onError: event => reject(new Error(`YouTube error: ${event.data}`)) }
          });
        };
        if (window.YT?.Player) start();
        else {
          const previous = window.onYouTubeIframeAPIReady;
          window.onYouTubeIframeAPIReady = () => { previous?.(); start(); };
        }
      });
    }
    async ready() { await this.readyPromise; duration = this.instance.getDuration() || 0; }
    async play() { this.instance.playVideo(); }
    async pause() { this.instance.pauseVideo(); }
    async seek(value) { this.instance.seekTo(Math.max(0, value), true); }
    async time() { return this.instance.getCurrentTime() || 0; }
    destroy() { this.instance?.destroy(); }
  }

  async function ensurePlayer(state) {
    if (!state.provider || !state.videoId) return false;
    const key = `${state.provider}:${state.videoId}:${state.hash || ''}`;
    if (key === currentMediaKey && player) return ready || (playerLoadPromise ? playerLoadPromise : false);
    clearTimeout(scheduledTimer); ready = false; currentMediaKey = key;
    try { await player?.destroy?.(); } catch {}
    const host = document.getElementById('player');
    if (!host) return false;
    host.innerHTML = '';
    const node = document.createElement('div'); node.id = `video-${Date.now()}`; host.append(node);
    player = state.provider === 'vimeo' ? new VimeoAdapter(node, state) : new YouTubeAdapter(node, state);
    playerLoadPromise = (async () => {
      try {
        await player.ready(); ready = true; updateUi(); return true;
      } catch (error) {
        host.innerHTML = `<div class="player-empty"><div><span class="empty-icon">!</span>動画を読み込めませんでした。<br>埋め込み許可とURLを確認してください。</div></div>`;
        showNotice(error.message || '動画の読み込みに失敗しました', true); return false;
      } finally {
        playerLoadPromise = null;
      }
    })();
    return playerLoadPromise;
  }
  async function applyState(state) {
    updateUi();
    if (!state.provider || !document.getElementById('player')) return;
    if (!(await ensurePlayer(state))) return;
    clearTimeout(scheduledTimer);
    const target = expectedPosition(state);
    try {
      if (state.status === 'paused') {
        await player.pause(); await player.seek(target);
      } else if (state.executeAt && syncedNow() < state.executeAt) {
        await player.pause(); await player.seek(state.position);
        scheduledTimer = setTimeout(() => applyState(currentState), Math.max(0, state.executeAt - syncedNow()));
      } else {
        await player.seek(target);
        await player.play();
      }
      actualTime = await player.time();
      showNotice(state.status === 'playing' ? '再生中' : '待機中');
    } catch {
      showNotice('再生がブロックされました。プレイヤーの再生ボタンを一度押してください。', true);
    }
  }
  async function syncDrift() {
    if (!player || !ready || currentState.status !== 'playing' || (currentState.executeAt && syncedNow() < currentState.executeAt)) return;
    try {
      actualTime = await player.time();
      const expected = expectedPosition();
      if (Math.abs(expected - actualTime) >= 1) await player.seek(expected);
      updateUi();
    } catch {}
  }

  function renderHome() {
    document.getElementById('app').innerHTML = `<section class="landing"><div class="landing-card"><div class="eyebrow">SYNC WATCH / MVP</div><h1>同じ瞬間を、<br>同じ映像で。</h1><p>管理画面と視聴画面を開き、YouTube・Vimeoの同期操作を確認できます。</p><div class="landing-actions"><a class="btn primary" href="/admin/test001/">管理画面を開く</a><a class="btn" href="/watch/test001/">視聴画面を開く</a></div><p class="footnote">同期サーバー設定後は、別のPCやスマートフォンから同じRoomへ参加できます。</p></div></section>`;
  }
  function renderAdmin() {
    document.getElementById('app').innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><span class="mark">▶</span><div>同期動画視聴テスト<div class="room">管理画面・Room ${roomId}</div></div></div><span class="status" id="connectionStatus">接続中…</span></header><div class="grid"><section class="panel"><div class="player-wrap" id="player"><div class="player-empty"><div><span class="empty-icon">▷</span>右側で動画URLを設定してください</div></div></div><div class="controls"><div class="control-row"><button class="btn primary" id="playBtn">▶ 再生</button><button class="btn" id="pauseBtn">⏸ 一時停止</button><button class="btn" id="resetBtn">|◀ 先頭へ</button><button class="btn" id="backBtn">−10秒</button><button class="btn" id="forwardBtn">＋10秒</button></div><div class="seek-line"><span id="currentLabel">00:00</span><input id="seek" type="range" min="0" max="100" value="0" aria-label="再生位置"><span id="durationLabel">00:00</span></div><div class="notice" id="notice">動画を設定すると操作できます。</div></div></section><aside class="side"><section class="card"><h2>管理コード</h2><div class="input-row"><input class="text-input" id="adminCode" type="password" autocomplete="off" placeholder="管理コード" aria-label="管理コード"></div><p class="hint">同期サーバー接続時の操作確認に使用します。</p></section><section class="card"><h2>動画設定</h2><div class="input-row"><input class="text-input" id="videoUrl" inputmode="url" placeholder="YouTube / Vimeo のURL" aria-label="動画URL"><button class="btn violet" id="loadBtn">動画をセット</button></div><p class="hint">埋め込みが許可された公開動画を使用してください。</p></section><section class="card"><h2>参加状況</h2><div class="stats"><div class="metric"><strong id="connectedCount">0</strong><span>接続中</span></div><div class="metric"><strong id="readyCount">0</strong><span>準備完了</span></div></div></section><section class="card"><h2>ルーム状態</h2><dl class="state-list"><div class="state-row"><dt>動画</dt><dd id="mediaState">未設定</dd></div><div class="state-row"><dt>状態</dt><dd id="playState">PAUSED</dd></div><div class="state-row"><dt>基準位置</dt><dd id="positionState">00:00.000</dd></div><div class="state-row"><dt>バージョン</dt><dd id="versionState">0</dd></div></dl></section></aside></div></div>`;
    bindAdmin(); applyState(currentState);
  }
  function renderViewer() {
    document.getElementById('app').innerHTML = `<div class="viewer"><header class="topbar"><div class="brand"><span class="mark">▶</span><div>動画視聴ページ<div class="room">Room ${roomId}</div></div></div><span class="status" id="connectionStatus">接続中…</span></header><section class="panel ready-gate" id="gate"><div><div class="ready-badge">● 視聴前の準備</div><h1>イベント開始まで<br>しばらくお待ちください</h1><p id="gateText">動画が設定されたら、視聴準備をしてください。</p><button class="btn primary" id="readyBtn">🔊 視聴準備をする</button></div></section><section class="panel player-panel" hidden id="playerPanel"><div class="player-wrap" id="player"></div><div class="controls"><div class="notice" id="notice">管理者の操作を待っています。</div><div class="debug" id="debug" ${debugMode ? '' : 'hidden'}></div></div></section></div>`;
    bindViewer(); if (currentState.provider) ensurePlayer(currentState); startPresence(); updateUi();
  }

  function bindAdmin() {
    const byId = id => document.getElementById(id);
    byId('adminCode').value = localStorage.getItem(`sync-admin-code:${roomId}`) || '';
    byId('adminCode').onchange = event => localStorage.setItem(`sync-admin-code:${roomId}`, event.target.value);
    byId('loadBtn').onclick = async () => {
      const detected = detectVideo(byId('videoUrl').value);
      if (!detected) return showNotice('対応するYouTubeまたはVimeoのURLを入力してください。', true);
      const result = await publish({ ...defaultState(), ...detected, version: currentState.version });
      if (result) toast('動画をルームに設定しました');
    };
    byId('playBtn').onclick = async () => {
      if (!currentState.provider) return showNotice('先に動画を設定してください。', true);
      let position = expectedPosition();
      try { if (player && ready) position = await player.time(); } catch {}
      publish({ ...currentState, status: 'playing', position, anchorTime: syncedNow() + 900, executeAt: syncedNow() + 900 });
    };
    byId('pauseBtn').onclick = async () => {
      let position = expectedPosition();
      try { if (player && ready) position = await player.time(); } catch {}
      publish({ ...currentState, status: 'paused', position, anchorTime: syncedNow(), executeAt: null });
    };
    byId('resetBtn').onclick = () => publish({ ...currentState, status: 'paused', position: 0, anchorTime: syncedNow(), executeAt: null });
    byId('backBtn').onclick = () => seekBy(-10);
    byId('forwardBtn').onclick = () => seekBy(10);
    byId('seek').onchange = event => seekTo(Number(event.target.value));
  }
  function seekTo(position) {
    const status = currentState.status;
    publish({ ...currentState, status, position: Math.max(0, Math.min(duration || Infinity, position)), anchorTime: syncedNow(), executeAt: null });
  }
  function seekBy(delta) { seekTo(expectedPosition() + delta); }
  function bindViewer() {
    document.getElementById('readyBtn').onclick = async () => {
      if (!currentState.provider) return toast('まだ動画が設定されていません');
      const gate = document.getElementById('gate');
      const panel = document.getElementById('playerPanel');
      gate.hidden = true;
      panel.hidden = false;
      ready = true;
      writePresence('ready');
      if (!(await ensurePlayer(currentState))) {
        ready = false;
        writePresence('connected');
        return;
      }
      try {
        await player.play(); await new Promise(resolve => setTimeout(resolve, 180));
        if (currentState.status !== 'playing') await player.pause();
      } catch {}
      await applyState(currentState);
    };
  }

  function showNotice(message, error = false) {
    const el = document.getElementById('notice'); if (!el) return;
    el.textContent = message; el.classList.toggle('error', error);
  }
  function updateUi() {
    const expected = expectedPosition();
    const currentLabel = document.getElementById('currentLabel');
    if (currentLabel) currentLabel.textContent = formatTime(expected);
    const durationLabel = document.getElementById('durationLabel');
    if (durationLabel) durationLabel.textContent = formatTime(duration);
    const seek = document.getElementById('seek');
    if (seek) { seek.max = String(duration || Math.max(100, expected + 30)); seek.value = String(Math.min(Number(seek.max), expected)); }
    const mediaState = document.getElementById('mediaState');
    if (mediaState) mediaState.textContent = currentState.provider ? `${currentState.provider === 'youtube' ? 'YouTube' : 'Vimeo'} ${currentState.videoId}` : '未設定';
    const playState = document.getElementById('playState'); if (playState) playState.textContent = currentState.status.toUpperCase();
    const positionState = document.getElementById('positionState'); if (positionState) positionState.textContent = `${formatTime(expected)}.${String(Math.floor((expected % 1) * 1000)).padStart(3, '0')}`;
    const versionState = document.getElementById('versionState'); if (versionState) versionState.textContent = currentState.version;
    const debug = document.getElementById('debug');
    if (debug && debugMode) debug.textContent = `Expected : ${expected.toFixed(3)}\nActual   : ${actualTime.toFixed(3)}\nDrift    : ${(actualTime - expected).toFixed(3)}\nVersion  : ${currentState.version}\nClient   : ${clientId}`;
    if (role === 'watch') {
      const gateText = document.getElementById('gateText');
      if (gateText) gateText.textContent = currentState.provider ? '動画の準備ができました。ボタンを押してください。' : '動画が設定されたら、視聴準備をしてください。';
    }
  }
  function writePresence(state = ready ? 'ready' : 'connected') {
    if (transportMode === 'supabase' && realtimeChannel) {
      realtimeChannel.track({ role, readiness: state, at: syncedNow() });
      return;
    }
    localStorage.setItem(`${presencePrefix}${clientId}`, JSON.stringify({ state, at: syncedNow() }));
  }
  function startPresence() {
    writePresence(); heartbeatTimer = setInterval(() => writePresence(), 2500);
    window.addEventListener('beforeunload', () => localStorage.removeItem(`${presencePrefix}${clientId}`));
  }
  function updateCounts() {
    if (role !== 'admin') return;
    let connected = 0, prepared = 0;
    if (transportMode === 'supabase' && realtimeChannel) {
      const presences = Object.values(realtimeChannel.presenceState()).flat();
      for (const item of presences) {
        if (item.role === 'watch') { connected++; if (item.readiness === 'ready') prepared++; }
      }
    } else {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i); if (!key?.startsWith(presencePrefix)) continue;
        try {
          const item = JSON.parse(localStorage.getItem(key));
          if (syncedNow() - item.at < 7000) { connected++; if (item.state === 'ready') prepared++; }
          else localStorage.removeItem(key);
        } catch {}
      }
    }
    document.getElementById('connectedCount').textContent = connected;
    document.getElementById('readyCount').textContent = prepared;
  }

  if (role === 'admin') renderAdmin(); else if (role === 'watch') renderViewer(); else renderHome();
  initTransport();
  uiTimer = setInterval(() => { updateUi(); updateCounts(); }, 500);
  driftTimer = setInterval(syncDrift, 3000);
  setInterval(() => { if (transportMode === 'supabase') refreshRemoteState(); }, 15000);
})();
