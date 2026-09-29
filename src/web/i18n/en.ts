// Message catalog. All user-facing strings live here (English now, Tamil-ready later).
export const en = {
  appName: 'Akshaya Home Care',
  serverWaking: 'Waking the server. This can take up to a minute after a quiet spell.',
  serverReady: 'Server is ready.',
  serverUnreachable: 'Cannot reach the server. Check your connection and try again.',
  scaffoldNotice: 'Phase 1 scaffold. Invoice features arrive in Phase 4.',
} as const;

export type MessageKey = keyof typeof en;
