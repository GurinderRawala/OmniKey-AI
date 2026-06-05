import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';

interface DownloadCounts {
  macos: number;
  windows: number;
}

const DEFAULT_COUNTS: DownloadCounts = { macos: 0, windows: 0 };

const downloadCountsSchema = z.object({
  macos: z.number().nonnegative().optional(),
  windows: z.number().nonnegative().optional(),
});

function parseDownloadCounts(raw: string): DownloadCounts {
  const json: unknown = JSON.parse(raw);
  const parsed = downloadCountsSchema.safeParse(json);
  if (!parsed.success) {
    return { ...DEFAULT_COUNTS };
  }

  return {
    macos: parsed.data.macos ?? 0,
    windows: parsed.data.windows ?? 0,
  };
}

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
  return parseDownloadCounts(contents.toString('utf8'));
}

async function readCountsWithGeneration(
  bucketName: string,
  objectPath: string,
): Promise<{ counts: DownloadCounts; generation: string | number | null; exists: boolean }> {
  const file = storage.bucket(bucketName).file(objectPath);
  const [exists] = await file.exists();
  if (!exists) {
    return { counts: { ...DEFAULT_COUNTS }, generation: null, exists: false };
  }

  const [[metadata], [contents]] = await Promise.all([file.getMetadata(), file.download()]);
  const counts = parseDownloadCounts(contents.toString('utf8'));
  return {
    counts,
    generation: metadata.generation ?? null,
    exists: true,
  };
}

function isGcsPreconditionError(err: unknown): boolean {
  const maybe = err as { code?: number; message?: string };
  return (
    maybe?.code === 412 ||
    maybe?.message?.includes('conditionNotMet') === true ||
    maybe?.message?.includes('Precondition Failed') === true
  );
}

export async function incrementDownloadCount(platform: 'macos' | 'windows'): Promise<void> {
  const gcs = getGcsConfig();
  if (!gcs) return;

  const file = storage.bucket(gcs.bucketName).file(gcs.objectPath);
  const MAX_RETRIES = 6;

  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const { counts, generation, exists } = await readCountsWithGeneration(
        gcs.bucketName,
        gcs.objectPath,
      );

      counts[platform] += 1;

      try {
        await file.save(JSON.stringify(counts), {
          contentType: 'application/json',
          resumable: false,
          preconditionOpts: exists
            ? { ifGenerationMatch: Number(generation) }
            : { ifGenerationMatch: 0 },
        });

        logger.info(`Download count incremented for ${platform}.`, { counts, attempt });
        return;
      } catch (err) {
        if (isGcsPreconditionError(err) && attempt < MAX_RETRIES) {
          continue;
        }
        throw err;
      }
    }

    logger.warn(`Download count increment exhausted retries for ${platform}.`);
  } catch (err) {
    logger.error(`Failed to increment download count for ${platform}.`, { error: err });
  }
}
