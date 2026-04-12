import { Storage } from '@google-cloud/storage';
import { logger } from '../logger';
import { config } from '../config';

interface DownloadCounts {
  macos: number;
  windows: number;
}

const DEFAULT_COUNTS: DownloadCounts = { macos: 0, windows: 0 };

// Initialised once at module load — uses Application Default Credentials when
// running on Cloud Run (or any GCP environment), and falls back to ADC from
// the local environment during development.
const storage = new Storage();

function getGcsConfig(): { bucketName: string; objectPath: string } | null {
  const bucketName = config.gcsBucketName;
  const objectPath = config.gcsDownloadCountObject;
  if (!bucketName || !objectPath) return null;
  return { bucketName, objectPath };
}

export async function getDownloadCounts(): Promise<DownloadCounts> {
  const gcs = getGcsConfig();
  if (!gcs) return { ...DEFAULT_COUNTS };
  return readCounts(gcs.bucketName, gcs.objectPath);
}

async function readCounts(bucketName: string, objectPath: string): Promise<DownloadCounts> {
  const file = storage.bucket(bucketName).file(objectPath);

  const [exists] = await file.exists();
  if (!exists) {
    return { ...DEFAULT_COUNTS };
  }

  const [contents] = await file.download();
  const parsed = JSON.parse(contents.toString('utf8')) as Partial<DownloadCounts>;

  return {
    macos: typeof parsed.macos === 'number' ? parsed.macos : 0,
    windows: typeof parsed.windows === 'number' ? parsed.windows : 0,
  };
}

async function writeCounts(
  bucketName: string,
  objectPath: string,
  counts: DownloadCounts,
): Promise<void> {
  const file = storage.bucket(bucketName).file(objectPath);
  await file.save(JSON.stringify(counts), {
    contentType: 'application/json',
    resumable: false,
  });
}

export async function incrementDownloadCount(platform: 'macos' | 'windows'): Promise<void> {
  const gcs = getGcsConfig();
  if (!gcs) return;

  try {
    const counts = await readCounts(gcs.bucketName, gcs.objectPath);
    counts[platform] += 1;
    await writeCounts(gcs.bucketName, gcs.objectPath, counts);
    logger.info(`Download count incremented for ${platform}.`, { counts });
  } catch (err) {
    logger.error(`Failed to increment download count for ${platform}.`, { error: err });
  }
}
