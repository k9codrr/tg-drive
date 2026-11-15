// Vercel serverless functions accept request/response bodies up to ~4.5 MB,
// so files are split into 4 MB chunks. Each chunk = one Telegram message.
export const CHUNK_SIZE = 4 * 1024 * 1024;
