import type { Backup } from './types';

declare global {
  interface Window {
    SUDOKU_CONFIG?: { googleClientId?: string };
    google?: { accounts: { oauth2: { initTokenClient: (config: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void }) => { requestAccessToken: (options?: { prompt?: string }) => void } } } };
  }
}

const scope = 'https://www.googleapis.com/auth/drive.file';

function clientId(): string | undefined {
  return window.SUDOKU_CONFIG?.googleClientId;
}

async function loadIdentityServices(): Promise<void> {
  if (window.google?.accounts.oauth2) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google 認可ライブラリを読み込めませんでした。'));
    document.head.append(script);
  });
}

export function googleDriveReady(): boolean {
  return Boolean(clientId());
}

async function accessToken(): Promise<string> {
  const id = clientId();
  if (!id) throw new Error('Google Drive は設定されていません。public/config.js に OAuth クライアント ID を設定してください。');
  await loadIdentityServices();
  return new Promise((resolve, reject) => {
    const client = window.google?.accounts.oauth2.initTokenClient({
      client_id: id,
      scope,
      callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error(response.error ?? 'Google 認可を完了できませんでした。')),
    });
    client?.requestAccessToken({ prompt: 'consent' });
  });
}

export async function saveToDrive(backup: Backup): Promise<void> {
  const token = await accessToken();
  const boundary = `sudoku-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: `sudoku-backup-${new Date().toISOString().slice(0, 10)}.json`, mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(backup)}\r\n--${boundary}--`;
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  if (!response.ok) throw new Error('Google Drive への保存に失敗しました。');
}
