// The proxy's loopback HTTP API. The proxy serves these paths; server.ts and the
// Python hooks call them, so a rename here must reach every caller.
export const ROUTE = {
  poll: '/poll',
  permissionPoll: '/permission-poll',
  health: '/health',
  rateLimit: '/rate-limit',
  capacity: '/capacity',
  turnFailed: '/turn-failed',
  topics: '/topics',
  topicCreate: '/topic/create',
  squareTag: '/square/tag',
  squareReply: '/square/reply',
  remind: '/remind',
  reminders: '/reminders',
  reminderCancel: '/reminder/cancel',
  send: '/send',
  react: '/react',
  edit: '/edit',
  download: '/download',
  permissionRequest: '/permission-request',
} as const
