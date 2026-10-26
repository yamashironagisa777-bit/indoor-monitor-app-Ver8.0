
const CACHE_NAME = 'indoor-monitor-v5-push-preferences';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icon.svg'
];

// インストール時に、画面表示に必要なファイルをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 古いキャッシュを削除して、新しいService Workerを有効化
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // GET以外、および外部サービスへの通信は横取りしない
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // HTML・JavaScript・設定ファイルは最新を優先
  const path = url.pathname;
  const isAppFile =
    path.endsWith('/') ||
    /\.(html|js|css|json|svg)$/.test(path);

  if (isAppFile) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response('オフラインです。接続後に再読み込みしてください。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
  }
});


// 通知設定はIndexedDBに保存し、アプリを閉じている間も参照できるようにする。
const PREF_DB = 'indoor-monitor-notification-settings';
const PREF_STORE = 'settings';
function openPreferenceDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREF_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PREF_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function savePreferences(preferences) {
  const db = await openPreferenceDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PREF_STORE, 'readwrite');
    tx.objectStore(PREF_STORE).put(preferences, 'notificationPreferences');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function getPreferences() {
  const db = await openPreferenceDb();
  const result = await new Promise((resolve, reject) => {
    const request = db.transaction(PREF_STORE, 'readonly').objectStore(PREF_STORE).get('notificationPreferences');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SET_NOTIFICATION_PREFERENCES') {
    event.waitUntil(savePreferences(event.data.preferences || {}));
  }
});

function notificationCategory(data, title, body) {
  const explicit = String(data.type || data.category || data.eventType || '').toLowerCase();
  if (/call|呼び出し/.test(explicit)) return 'call';
  if (/door|ドア/.test(explicit)) return 'door';
  if (/gas|smoke|ガス|煙/.test(explicit)) return 'gas';
  const text = `${title} ${body}`.toLowerCase();
  if (/呼び出し|call/.test(text)) return 'call';
  if (/ドア|door/.test(text)) return 'door';
  if (/ガス|煙|gas|smoke/.test(text)) return 'gas';
  return null;
}

// Push通知はアプリ画面を閉じていてもOS経由で表示される。OFFの種類はここでも遮断する。
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
    const title = data.title || '室内監視システム';
    const body = data.body || '監視イベントが発生しました。';
    const category = notificationCategory(data, title, body);
    if (category) {
      try {
        const prefs = await getPreferences();
        // 設定が未保存の初回は従来どおり表示。保存済みのfalseは必ず遮断。
        if (prefs && prefs[category] === false) return;
      } catch (error) { console.warn('通知設定を読み込めません:', error); }
    }
    const options = {
      body,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: data.tag || 'indoor-monitor-event',
      renotify: true,
      data: { url: data.url || './' }
    };
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
