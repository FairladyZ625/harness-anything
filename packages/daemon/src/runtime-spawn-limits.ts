// Timeouts and byte budgets shared by the spawner and the process launcher. Kept in a leaf
// module so the launcher never has to import the spawner that drives it.
export const providerErrorLimit = 64 * 1024;
export const resumeAdmissionTimeoutMs = 30_000;
export const exitNotificationTimeoutMs = 30_000;
