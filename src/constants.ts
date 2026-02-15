export const DEFAULT_SUBFOLDER = "reMarkable";

export const SYNC_INTERVALS: Record<string, number> = {
	"Manual only": 0,
	"Every 5 minutes": 5 * 60 * 1000,
	"Every 15 minutes": 15 * 60 * 1000,
	"Every 30 minutes": 30 * 60 * 1000,
	"Every 60 minutes": 60 * 60 * 1000,
};

export const AUTH_URL = "https://my.remarkable.com/device/desktop/connect";
