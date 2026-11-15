-- Using the WebDAV drive from other machines: per-device IP allow list and the last address seen.
ALTER TABLE "device_tokens" ADD COLUMN "allowed_ips" TEXT;  -- "203.0.113.7, 198.51.100.0/24" (NULL = any)
ALTER TABLE "device_tokens" ADD COLUMN "last_ip" TEXT;
