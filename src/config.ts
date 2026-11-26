import { existsSync } from 'node:fs';
/** All configuration comes from environment variables; see .env.example. */
export interface Config {
  port: number; host: string; token: string; ingestToken: string; webPassword: string; dbPath: string; dataDir: string; tz: string;
  quietHours: { start: number; end: number };           // local hours; nagging is held inside [start, end)
  nagMinutes: number[];                                  // gaps between nags: 0th = after first notice, last repeats
  canopy: { url: string; readToken: string; writeToken: string } | null;
  canopyGradeDropPct: number;
  google: { serviceAccountFile?: string; oauth?: { clientId: string; clientSecret: string; refreshToken: string } } ;
  chat: { pubsubSubscription?: string; notifySpace?: string; allowedUsers: string[]; readUserSpaces: boolean };
  ntfy: { url: string; topic: string } | null;
  gmail: { enabled: boolean; skipBulk: boolean };
  transcribeUrl: string | null;                          // OpenAI-compatible /v1/audio/transcriptions endpoint
  indexPaths: string[]; driveFolderIds: string[]; backup: { auto: boolean; hour: number; keep: number };
  code: { enabled: boolean; root: string; maxSessions: number; allowBypass: boolean; resumeOnBoot: boolean; claudeBin: string; tmuxBin: string; socket: string; configDir: string; globalConfig: string; claudeEnv: Record<string, string> };
  claude: { bin: string; model?: string; timeoutMs: number };
  autoApplyMinConfidence: number;                        // below this, updates/completions go to the approval queue
  ignoreSenders: RegExp[];
  github: { repo: string; token: string };               // where the Mac app releases live
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.ASSISTANT_DATA ?? './data';
  const [qs, qe] = (env.QUIET_HOURS ?? '22-7').split('-').map(Number);
  return {
    port: Number(env.PORT ?? 8090), host: env.HOST ?? '0.0.0.0', token: env.ASSISTANT_TOKEN ?? '', ingestToken: env.INGEST_TOKEN ?? '', webPassword: env.WEB_PASSWORD ?? '',
    dbPath: env.ASSISTANT_DB ?? `${dataDir}/assistant.db`, dataDir, tz: env.TZ_NAME ?? 'America/Anchorage',
    quietHours: { start: qs, end: qe },
    nagMinutes: list(env.NAG_MINUTES ?? '15,15,30,60').map(Number),
    canopy: env.CANOPY_URL ? { url: env.CANOPY_URL.replace(/\/$/, ''), readToken: env.CANOPY_READ_TOKEN ?? '', writeToken: env.CANOPY_WRITE_TOKEN ?? '' } : null,
    canopyGradeDropPct: Number(env.CANOPY_GRADE_DROP_PCT ?? 2),
    google: {
      serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE,
      oauth: env.GOOGLE_CLIENT_ID ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET ?? '', refreshToken: env.GOOGLE_REFRESH_TOKEN ?? '' } : undefined,
    },
    chat: { pubsubSubscription: env.CHAT_PUBSUB_SUBSCRIPTION, notifySpace: env.CHAT_NOTIFY_SPACE, allowedUsers: list(env.CHAT_ALLOWED_USERS), readUserSpaces: env.CHAT_READ_SPACES === '1' },
    ntfy: env.NTFY_URL ? { url: env.NTFY_URL.replace(/\/$/, ''), topic: env.NTFY_TOPIC ?? 'assistant' } : null,
    gmail: { enabled: env.GMAIL_ENABLED === '1', skipBulk: env.GMAIL_SKIP_BULK !== '0' },
    transcribeUrl: env.TRANSCRIBE_URL ?? null,
    indexPaths: list(env.INDEX_PATHS), driveFolderIds: list(env.DRIVE_FOLDER_IDS),
    code: { enabled: env.CODE_ENABLED !== '0', root: env.CODE_ROOT ?? (existsSync('/workspace') ? '/workspace' : `${dataDir}/workspace`), maxSessions: Math.min(30, Math.max(1, Math.trunc(Number(env.CODE_MAX_SESSIONS ?? 8)) || 8)), allowBypass: env.CODE_ALLOW_BYPASS !== '0', resumeOnBoot: env.CODE_RESUME_ON_BOOT !== '0',
      claudeBin: env.CODE_CLAUDE_BIN ?? env.CLAUDE_BIN ?? 'claude', tmuxBin: env.CODE_TMUX_BIN ?? 'tmux', socket: env.CODE_TMUX_SOCKET ?? 'assistant-code', configDir: env.CODE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? `${env.HOME ?? '/home/node'}/.claude`,
      claudeEnv: env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {},
      globalConfig: env.CODE_GLOBAL_CONFIG ?? (env.CLAUDE_CONFIG_DIR ? `${env.CLAUDE_CONFIG_DIR}/.claude.json` : `${env.HOME ?? '/home/node'}/.claude.json`) },
    backup: { auto: env.BACKUP_AUTO !== '0', hour: Math.min(23, Math.max(0, Math.trunc(Number(env.BACKUP_HOUR ?? 2)) || 0)), keep: Math.min(365, Math.max(1, Math.trunc(Number(env.BACKUP_KEEP ?? 14)) || 14)) },
    claude: { bin: env.CLAUDE_BIN ?? 'claude', model: env.CLAUDE_MODEL, timeoutMs: Number(env.CLAUDE_TIMEOUT_MS ?? 180000) },
    autoApplyMinConfidence: Number(env.AUTO_APPLY_MIN_CONFIDENCE ?? 0.6),
    github: { repo: env.GITHUB_REPO ?? 'douggreenak/personal-assistant', token: env.GITHUB_TOKEN ?? '' },
    ignoreSenders: list(env.IGNORE_SENDERS ?? 'no-?reply,mailer-daemon,notifications?@').map((s) => new RegExp(s, 'i')),
  };
}
