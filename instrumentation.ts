// Runs once when the Next.js server starts.
// The Node-only code lives in a separate file and must be imported inside this exact check:
// Next also compiles this file for the Edge runtime (middleware), and only this form lets it
// drop the import there. Otherwise Edge tries to bundle node:crypto etc. and every page fails.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
