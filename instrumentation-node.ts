// Node.js-only startup work (imported from instrumentation.ts). Starts the WebDAV drive server
// used to mount TG Drive as a Windows drive letter (see drive-agent/README.md), and the hourly
// clean-up of the trash (items older than 30 days) and of abandoned storage moves.
import { startDavServer } from "./lib/dav/server";
import { purgeExpiredTrash } from "./lib/trash";
import { purgeAbandonedCopies } from "./lib/transfer";

if (process.env.DAV_DISABLED !== "1") startDavServer(Number(process.env.DAV_PORT || 3021));

const g = globalThis as unknown as { tgdJanitor?: NodeJS.Timeout };
if (!g.tgdJanitor) {
  const run = async () => {
    try {
      const trashed = await purgeExpiredTrash();
      const copies = await purgeAbandonedCopies();
      if (trashed || copies) console.log(`[janitor] removed ${trashed} expired trash item(s), ${copies} abandoned copy(ies)`);
    } catch (e) {
      console.warn("[janitor] failed:", e);
    }
  };
  setTimeout(run, 60_000);
  g.tgdJanitor = setInterval(run, 60 * 60_000);
  g.tgdJanitor.unref?.();
}
