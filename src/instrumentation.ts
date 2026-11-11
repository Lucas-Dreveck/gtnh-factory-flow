export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // First start on an empty store: print the one-time admin invite.
  try {
    const { ensureBootstrapInvite } = await import("@/lib/server/local/auth");
    ensureBootstrapInvite();
  } catch (error) {
    console.error("GTNH bootstrap invite failed.", error);
  }
  try {
    const { startBackupSchedule } = await import("@/lib/server/local/backup");
    startBackupSchedule();
  } catch (error) {
    console.error("GTNH backup schedule failed to start.", error);
  }

  if (process.env.GTNH_PREWARM_ON_STARTUP !== "1") {
    return;
  }

  const { prewarmLatestDatasetVersions } = await import("@/lib/server/dataset-query");
  try {
    await prewarmLatestDatasetVersions();
    console.info("GTNH dataset cache prewarmed.");
  } catch (error) {
    console.error("GTNH dataset cache prewarm failed.", error);
  }
}
