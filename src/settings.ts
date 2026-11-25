import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Settings editable from the web UI. Values are saved to <data>/settings.json and override environment variables
 * at startup, so changing one means "save, then restart" (the UI offers a restart button).
 */
export interface SettingDef {
  key: string; label: string; group: string; type: 'text' | 'number' | 'bool' | 'secret' | 'list' | 'textarea';
  help?: string; placeholder?: string; default?: string;
}
export const SETTINGS: SettingDef[] = [
  { key: 'TZ_NAME', label: 'Time zone', group: 'General', type: 'text', help: 'IANA time zone name.' },
  { key: 'QUIET_HOURS', label: 'Quiet hours', group: 'General', type: 'text', placeholder: '22-7', help: 'Nags are held between these local hours (start-end). Urgent reminders still go through.' },
  { key: 'NAG_MINUTES', label: 'Nag gaps (minutes)', group: 'General', type: 'list', placeholder: '15,15,30,60', help: 'Minutes between repeated nags; the last value repeats until you acknowledge.' },
  { key: 'AUTO_APPLY_MIN_CONFIDENCE', label: 'Auto-apply confidence', group: 'General', type: 'number', placeholder: '0.6', help: 'Updates and completions below this confidence ask for approval first (0–1).' },
  { key: 'IGNORE_SENDERS', label: 'Ignore senders', group: 'General', type: 'list', help: 'Comma-separated regexes of automated senders that are skipped without a model call.' },

  { key: 'CLAUDE_MODEL', label: 'Claude model', group: 'Brain', type: 'text', help: 'Model used to understand messages. Leave blank for the Claude Code default.' },
  { key: 'CLAUDE_TIMEOUT_MS', label: 'Model timeout (ms)', group: 'Brain', type: 'number', placeholder: '180000' },

  { key: 'TICKETING_URL', label: 'Ticketing URL', group: 'Ticketing', type: 'text', help: 'Where the ticket tracker lives (inside Docker: http://ticketing:8080).' },
  { key: 'TICKETING_TOKEN', label: 'Ticketing token', group: 'Ticketing', type: 'secret' },
  { key: 'TICKETING_WEBHOOK_SECRET', label: 'Webhook secret', group: 'Ticketing', type: 'secret', help: 'Mirrors stage changes made in the Ticketing UI back here.' },

  { key: 'CANOPY_URL', label: 'Canopy URL', group: 'Canopy', type: 'text' },
  { key: 'CANOPY_READ_TOKEN', label: 'Read-only token', group: 'Canopy', type: 'secret' },
  { key: 'CANOPY_WRITE_TOKEN', label: 'Read/write token', group: 'Canopy', type: 'secret' },
  { key: 'CANOPY_GRADE_DROP_PCT', label: 'Grade-drop alert (%)', group: 'Canopy', type: 'number', placeholder: '2' },

  { key: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID', group: 'Google', type: 'text' },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', group: 'Google', type: 'secret' },
  { key: 'GOOGLE_REFRESH_TOKEN', label: 'OAuth refresh token', group: 'Google', type: 'secret', help: 'Create with `npm run google-auth` (see docs/google-setup.md).' },
  { key: 'GMAIL_ENABLED', label: 'Read Gmail', group: 'Google', type: 'bool' },
  { key: 'GMAIL_SKIP_BULK', label: 'Skip bulk mail', group: 'Google', type: 'bool', default: '1', help: 'Ignore newsletters and promotions.' },
  { key: 'GOOGLE_SERVICE_ACCOUNT_FILE', label: 'Service account file', group: 'Google', type: 'text', help: 'Upload one on the Settings page, or enter a path inside the container.' },
  { key: 'CHAT_PUBSUB_SUBSCRIPTION', label: 'Chat Pub/Sub subscription', group: 'Google', type: 'text' },
  { key: 'CHAT_NOTIFY_SPACE', label: 'Chat notify space', group: 'Google', type: 'text' },
  { key: 'CHAT_ALLOWED_USERS', label: 'Chat allowed users', group: 'Google', type: 'list', help: 'ONLY these Chat users may command the assistant.' },
  { key: 'CHAT_READ_SPACES', label: 'Read my Chat spaces', group: 'Google', type: 'bool' },
  { key: 'DRIVE_FOLDER_IDS', label: 'Drive folder IDs', group: 'Google', type: 'list', help: 'Folders indexed so questions can cite them.' },

  { key: 'NTFY_URL', label: 'ntfy server URL', group: 'Notifications', type: 'text' },
  { key: 'NTFY_TOPIC', label: 'ntfy topic', group: 'Notifications', type: 'text', placeholder: 'assistant' },

  { key: 'INDEX_PATHS', label: 'Index paths', group: 'Files & voice', type: 'list', help: 'Folders inside the container to index for questions.' },
  { key: 'TRANSCRIBE_URL', label: 'Transcription URL', group: 'Files & voice', type: 'text', help: 'OpenAI-compatible /v1/audio/transcriptions endpoint.' },

  { key: 'GITHUB_REPO', label: 'GitHub repository', group: 'Mac app', type: 'text', placeholder: 'douggreenak/personal-assistant', help: 'Where Mac app releases are published (owner/name).' },
  { key: 'GITHUB_TOKEN', label: 'GitHub token', group: 'Mac app', type: 'secret', help: 'Only needed if the repository is private (read access to releases).' },

  { key: 'BACKUP_AUTO', label: 'Nightly backup', group: 'Backup', type: 'bool', default: '1', help: 'Saves a full backup (including keys) into the data folder, backups/ — once a day.' },
  { key: 'BACKUP_HOUR', label: 'Backup hour', group: 'Backup', type: 'number', placeholder: '2', help: 'Local hour (0–23). If the assistant was off then, it backs up as soon as it starts.' },
  { key: 'BACKUP_KEEP', label: 'Nightly backups to keep', group: 'Backup', type: 'number', placeholder: '14', help: 'Older nightly files are deleted.' },

  { key: 'INGEST_TOKEN', label: 'Ingest token', group: 'Access', type: 'secret', help: 'Send-input-only token for the Mac agent and phone app.' },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const file = (dataDir: string) => `${dataDir}/settings.json`;
export function readOverrides(dataDir: string): Record<string, string> {
  try { return existsSync(file(dataDir)) ? JSON.parse(readFileSync(file(dataDir), 'utf8')) as Record<string, string> : {}; } catch { return {}; }
}
export function writeOverrides(dataDir: string, o: Record<string, string>): void {
  mkdirSync(dirname(file(dataDir)), { recursive: true });
  writeFileSync(file(dataDir), JSON.stringify(o, null, 2), { mode: 0o600 }); chmodSync(file(dataDir), 0o600);
}

export interface SettingView extends SettingDef { value: string; isSet: boolean; overridden: boolean }
/** Secrets are never sent to the browser — only whether they are set. */
export function viewSettings(dataDir: string, env: NodeJS.ProcessEnv = process.env): SettingView[] {
  const o = readOverrides(dataDir);
  return SETTINGS.map((d) => {
    const raw = d.key in o ? o[d.key] : env[d.key] ?? '';
    return { ...d, value: d.type === 'secret' ? '' : raw || d.default || '', isSet: raw !== '', overridden: d.key in o };
  });
}
/** null/undefined leaves a setting alone; '' (or __clear__) removes the override and falls back to the environment. */
export function saveSettings(dataDir: string, changes: Record<string, unknown>): string[] {
  const o = readOverrides(dataDir); const changed: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    const def = BY_KEY.get(k); if (!def || v == null) continue;
    const s = String(v).trim().slice(0, 2000);
    if (def.type === 'secret' && s === '') continue;                       // blank secret = keep as is; send __clear__ to remove
    if (s === '__clear__' || s === '') { delete o[k]; changed.push(k); continue; }       // back to the .env / default value
    if (def.type === 'number' && s !== '' && Number.isNaN(Number(s))) throw new Error(`${def.label} must be a number.`);
    if (k === 'QUIET_HOURS' && s !== '' && !/^\d{1,2}-\d{1,2}$/.test(s)) throw new Error('Quiet hours look like 22-7.');
    if (k === 'TZ_NAME' && s !== '') { try { new Intl.DateTimeFormat('en-US', { timeZone: s }); } catch { throw new Error(`Unknown time zone "${s}".`); } }
    if (/_URL$/.test(k) && s !== '' && !/^https?:\/\//.test(s)) throw new Error(`${def.label} must start with http:// or https://.`);
    o[k] = s; changed.push(k);
  }
  writeOverrides(dataDir, o);
  return changed;
}
