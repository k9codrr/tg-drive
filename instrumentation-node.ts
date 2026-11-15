// Node.js-only startup work (imported from instrumentation.ts). Starts the WebDAV drive server
// used to mount TG Drive as a Windows drive letter (see drive-agent/README.md).
import { startDavServer } from "./lib/dav/server";

if (process.env.DAV_DISABLED !== "1") startDavServer(Number(process.env.DAV_PORT || 3021));
