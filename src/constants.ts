export const DEFAULT_SUBFOLDER = "reMarkable";

export const SYNC_INTERVALS: Record<string, number> = {
	"Manual only": 0,
	"Every 5 minutes": 5 * 60 * 1000,
	"Every 15 minutes": 15 * 60 * 1000,
	"Every 30 minutes": 30 * 60 * 1000,
	"Every 60 minutes": 60 * 60 * 1000,
};

export const AUTH_URL = "https://my.remarkable.com/device/desktop/connect";

// Filename of the human-readable sync log written into the sync subfolder.
// The leading underscore keeps it sorted to the top and signals it is special.
export const SYNC_LOG_FILENAME = "_reMarkable Sync Log.md";

// Cap the on-disk log so it can't grow without bound across many sync runs.
export const SYNC_LOG_MAX_BYTES = 250_000;
