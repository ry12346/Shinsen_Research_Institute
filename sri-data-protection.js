/* 真戦シミュレーター: 端末データのバックアップと復元 (v1)
 * 認証トークンとクラウド同期メタデータはバックアップしない。
 */
(() => {
  'use strict';

  const FORMAT = 'shinsen-simulator-local-backup';
  const VERSION = 1;
  const MAX_FILE_SIZE = 20 * 1024 * 1024;
  const KEYS = Object.freeze([
    'nobunaga.groups.v4',
    'nobunaga.free_lineups.v1',
    'nobunaga.battle-simulator.lineup.v1',
    'nobunaga.land-simulation.ally.v1',
    'nobunaga.land-simulation.opponents.v1',
    'shinsen.equipment.v1'
  ]);
  const TITLES = {
    'nobunaga.groups.v4': '共存編成・所持状態',
    'nobunaga.free_lineups.v1': '自由編成',
    'nobunaga.battle-simulator.lineup.v1': '戦闘シミュレーション編成',
    'nobunaga.land-simulation.ally.v1': '土地模擬・自軍',
    'nobunaga.land-simulation.opponents.v1': '土地守備軍の端末データ',
    'shinsen.equipment.v1': '装備データ'
  };

  const parseJSON = (raw, key) => {
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new Error(`${TITLES[key]}のJSONが壊れています。`); }
    if (value === null || typeof value !== 'object') {
      throw new Error(`${TITLES[key]}の形式が不正です。`);
    }
    if (key === 'nobunaga.groups.v4' && (value.v !== 4 || !Array.isArray(value.groups))) {
      throw new Error('共存編成はv4形式のバックアップだけ復元できます。');
    }
    if (key === 'nobunaga.free_lineups.v1' && (value.v !== 1 || !Array.isArray(value.lineups))) {
      throw new Error('自由編成の形式が正しくありません。');
    }
    return value;
  };

  function flushLocal() {
    // Core Vue module uses this hook to flush its debounced local saves.
    window.dispatchEvent(new Event('sri:flush-local'));
  }

  function collect() {
    flushLocal();
    const items = {};
    for (const key of KEYS) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      parseJSON(value, key);
      items[key] = value;
    }
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      origin: location.origin,
      items
    };
  }

  function validateBackup(fileContent) {
    if (typeof fileContent !== 'string' || fileContent.length > MAX_FILE_SIZE) {
      throw new Error('バックアップファイルが大きすぎます。');
    }
    let doc;
    try { doc = JSON.parse(fileContent); }
    catch { throw new Error('JSONファイルとして読み込めません。'); }
    if (!doc || doc.format !== FORMAT || doc.version !== VERSION ||
        !doc.items || typeof doc.items !== 'object' || Array.isArray(doc.items)) {
      throw new Error('真戦シミュレーターの対応バックアップではありません。');
    }
    const entries = Object.entries(doc.items);
    if (!entries.length) throw new Error('復元できるデータが含まれていません。');
    const allowed = new Set(KEYS);
    for (const [key, raw] of entries) {
      if (!allowed.has(key) || typeof raw !== 'string' || raw.length > MAX_FILE_SIZE) {
        throw new Error('バックアップの内容に未対応の項目があります。');
      }
      parseJSON(raw, key);
    }
    return doc;
  }

  function summary(items) {
    return Object.keys(items).map(k => TITLES[k]).filter(Boolean).join('、') || 'なし';
  }

  function filename(prefix) {
    const date = new Date();
    const part = n => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${part(date.getMonth()+1)}${part(date.getDate())}_${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
    return `${prefix}_${stamp}.json`;
  }

  function downloadObject(documentData, prefix) {
    const body = JSON.stringify(documentData, null, 2);
    const url = URL.createObjectURL(new Blob([body], {type:'application/json;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename(prefix);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function restore(doc) {
    const existing = {};
    const keysToChange = Object.keys(doc.items);
    const metadata = [];
    for (let i = 0; i < localStorage.length; ++i) {
      const k = localStorage.key(i);
      if (k && k.startsWith('nobunaga.cloud_sync_meta.')) metadata.push(k);
    }
    const rollbackKeys = new Set([...keysToChange, ...metadata, 'nobunaga.cloud_sync_enabled']);
    for (const key of rollbackKeys) existing[key] = localStorage.getItem(key);
    try {
      // No automatic cloud push after restoring potentially older local data.
      localStorage.setItem('nobunaga.cloud_sync_enabled', 'false');
      for (const [key, raw] of Object.entries(doc.items)) localStorage.setItem(key, raw);
      // The previous cloud hashes belong to the pre-restore state.
      for (const key of metadata) localStorage.removeItem(key);
    } catch (error) {
      // localStorage has no transactions: restore the previous values on failure.
      try {
        for (const [key, oldValue] of Object.entries(existing)) {
          if (oldValue === null) localStorage.removeItem(key);
          else localStorage.setItem(key, oldValue);
        }
      } catch (rollbackError) {
        console.error('[sri-backup] rollback failure', rollbackError);
      }
      throw error;
    }
  }

  function mount() {
    if (document.getElementById('sri-data-protection')) return;
    const host = document.createElement('div');
    host.id = 'sri-data-protection';
    host.innerHTML = `
      <button type="button" class="sri-dp-trigger" id="sri-dp-trigger" aria-expanded="false" aria-controls="sri-dp-panel">
        <span class="sri-dp-dot" aria-hidden="true"></span><span id="sri-dp-trigger-label">保存状況を確認</span>
      </button>
      <section class="sri-dp-panel" id="sri-dp-panel" hidden aria-label="データ保護・保存状況">
        <header class="sri-dp-header"><strong>保存状況・データ保護</strong><button class="sri-dp-close" type="button" id="sri-dp-close" aria-label="閉じる">×</button></header>
        <div class="sri-dp-status"><span>この端末</span><strong id="sri-dp-local">確認中</strong></div>
        <div class="sri-dp-status"><span>クラウド</span><strong id="sri-dp-cloud">確認中</strong></div>
        <p class="sri-dp-note">「同期待機中」はクラウド保存完了を保証しません。同期の詳細は設定画面で確認できます。</p>
        <div class="sri-dp-line"></div>
        <strong class="sri-dp-section-title">この端末のバックアップ</strong>
        <p class="sri-dp-note">共存編成・所持状態・自由編成・装備・土地模擬などが対象です。Supabase上だけにある所持設定や他端末のデータは含みません。ログイン情報は出力しません。</p>
        <button type="button" class="sri-dp-primary" id="sri-dp-export">JSONをダウンロード</button>
        <label class="sri-dp-file-label" for="sri-dp-input">バックアップを選択（復元）</label>
        <input type="file" id="sri-dp-input" accept="application/json,.json" hidden>
        <div id="sri-dp-preview" class="sri-dp-preview" hidden>
          <p id="sri-dp-file-details"></p>
          <p class="sri-dp-note">復元する項目は上書きされ、含まれていない項目は残ります。復元時はクラウド同期を無効にします。</p>
          <button type="button" class="sri-dp-secondary" id="sri-dp-before-export">現在のデータを先にバックアップ</button>
          <button type="button" class="sri-dp-danger" id="sri-dp-restore" disabled>バックアップから復元</button>
        </div>
        <p class="sri-dp-message" id="sri-dp-message" role="status" aria-live="polite"></p>
      </section>`;
    document.body.appendChild(host);

    const $ = id => document.getElementById(id);
    const trigger = $('sri-dp-trigger');
    const panel = $('sri-dp-panel');
    const preview = $('sri-dp-preview');
    const input = $('sri-dp-input');
    const restoreButton = $('sri-dp-restore');
    const beforeExport = $('sri-dp-before-export');
    let selected = null;
    let latestCloud = window.__sriCloudState || null;
    let lastSaveError = false;
    let cachedLocalRaw = undefined;
    let cachedLocalDisplay = '保存データなし';

    function message(txt, error=false) {
      $('sri-dp-message').textContent = txt;
      $('sri-dp-message').classList.toggle('sri-dp-error', error);
    }
    function toggle(force) {
      const opened = typeof force === 'boolean' ? force : panel.hidden;
      panel.hidden = !opened;
      trigger.setAttribute('aria-expanded', String(opened));
      if (opened) refreshStatus();
    }
    function refreshStatus() {
      let raw;
      try { raw = localStorage.getItem('nobunaga.groups.v4'); }
      catch { $('sri-dp-local').textContent = '保存先を利用できません'; return; }
      if (raw !== cachedLocalRaw) {
        cachedLocalRaw = raw;
        if (!raw) cachedLocalDisplay = '保存データなし';
        else {
          try {
            const value = JSON.parse(raw);
            const count = Array.isArray(value.groups) ? value.groups.length : 0;
            cachedLocalDisplay = `端末保存あり（編成 ${count} 件）`;
          } catch { cachedLocalDisplay = '保存データを読み取れません'; }
        }
      }
      $('sri-dp-local').textContent = lastSaveError ? '保存エラー（確認が必要）' : cachedLocalDisplay;
      latestCloud = window.__sriCloudState || latestCloud;
      let cloud = '状態未取得';
      if (latestCloud) {
        if (!latestCloud.loggedIn) cloud = '未ログイン';
        else if (!latestCloud.enabled) cloud = '同期オフ';
        else {
          cloud = ({syncing:'同期中', conflict:'競合あり・要確認', offline:'接続できません', error:'保存エラー', idle:'同期待機中'})[latestCloud.status] || '状態未取得';
        }
      }
      $('sri-dp-cloud').textContent = cloud;
      const shortLocal = lastSaveError ? '端末保存エラー' : raw ? '端末保存あり' : '端末未保存';
      $('sri-dp-trigger-label').textContent = `${shortLocal} · ${cloud}`;
      host.classList.toggle('sri-dp-has-error', lastSaveError || ['error','offline','conflict'].includes(latestCloud?.status));
    }
    function exportCurrent(prefix='ShinsenSimulator_backup') {
      const data = collect();
      if (Object.keys(data.items).length === 0) {
        message('バックアップ対象の端末データがありません。', true);
        return false;
      }
      downloadObject(data, prefix);
      message(`バックアップを作成しました（${summary(data.items)}）。`);
      refreshStatus();
      return true;
    }

    trigger.addEventListener('click', () => toggle());
    $('sri-dp-close').addEventListener('click', () => toggle(false));
    $('sri-dp-export').addEventListener('click', () => {
      try { exportCurrent(); }
      catch (err) { message(`バックアップ失敗: ${err.message}`, true); }
    });
    input.addEventListener('change', async () => {
      selected = null;
      preview.hidden = true;
      restoreButton.disabled = true;
      try {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_FILE_SIZE) throw new Error('ファイルが20MBを超えています。');
        const doc = validateBackup(await file.text());
        selected = doc;
        $('sri-dp-file-details').textContent = `対象: ${summary(doc.items)}。作成日時: ${doc.exportedAt || '不明'}`;
        preview.hidden = false;
        message('復元前に「現在のデータを先にバックアップ」を実行してください。');
      } catch (err) { message(`読み込み不可: ${err.message}`, true); }
    });
    beforeExport.addEventListener('click', () => {
      try {
        if (exportCurrent('ShinsenSimulator_before_restore')) {
          restoreButton.disabled = false;
          message('復元前バックアップを作成しました。復元するとこの端末の対象データが上書きされます。');
        }
      } catch (err) { message(`復元前バックアップ失敗: ${err.message}`, true); }
    });
    restoreButton.addEventListener('click', () => {
      if (!selected || restoreButton.disabled) return;
      if ((window.__sriCloudState || latestCloud)?.status === 'syncing') {
        message('クラウド同期が実行中です。同期が終了してから復元してください。', true);
        return;
      }
      if (!window.confirm('この端末の対象データをバックアップで上書きします。クラウド同期はオフになります。続行しますか？')) return;
      try {
        // Prevent the running Vue app (including pagehide handlers) from
        // overwriting freshly restored storage with stale in-memory data.
        window.__sriRestoringBackup = true;
        window.dispatchEvent(new Event('sri:before-local-restore'));
        restore(selected);
        message('復元しました。再読み込みします。クラウド同期はオフのまま確認してください。');
        location.reload();
      } catch (err) {
        window.__sriRestoringBackup = false;
        message(`復元に失敗しました: ${err.message}。再読み込みして保存機能を再開してください。`, true);
      }
    });
    window.addEventListener('sri:cloud-state', ev => { latestCloud = ev.detail; refreshStatus(); });
    window.addEventListener('sri:local-save', ev => { lastSaveError = !ev.detail?.ok; refreshStatus(); });
    window.addEventListener('storage', ev => {
      if (ev.key === 'nobunaga.groups.v4' || ev.key === 'nobunaga.cloud_sync_enabled') refreshStatus();
    });
    refreshStatus();
    setInterval(() => { if (!document.hidden) refreshStatus(); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
