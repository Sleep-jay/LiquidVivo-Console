// Public client configuration only. Administration always requires server-side authorization.
export const config = Object.freeze({
  url: 'https://liquidvivo-d2g9srktc0d37a3a6-1521254198.ap-shanghai.app.tcloudbase.com/api',
  // Preserve existing browser sessions when changing only the transport hostname.
  authStorageKey: 'sb-drboqyxccvvsxcbusvrv-auth-token',
  publishableKey: 'sb_publishable_B1wNxFsun9jNIP8LB_BX-w_3e1eIPuT',
  syncIntervalSeconds: 3600,
});
