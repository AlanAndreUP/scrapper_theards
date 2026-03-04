import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StateStoreError } from '../utils/errors';
import type { Logger } from '../utils/logger';

const STATE_FILE = 'state.json';
const MAX_PROCESSED_RECORDS = 1000;
const MAX_RUN_LOGS = 500;

export interface ProcessedRecord {
  bucketFolderKey: string;
  permalink: string;
  shortcode: string;
  processedAt: string;
  facebookPostId?: string;
}

export interface RunLogRecord {
  runAt: string;
  durationMs: number;
  status: 'skipped' | 'success' | 'error';
  permalink?: string;
  shortcode?: string;
  facebookPostId?: string;
  detail?: string;
}

interface PersistedState {
  lastProcessed: ProcessedRecord | null;
  processedByKey: Record<string, ProcessedRecord>;
  runLogs: RunLogRecord[];
}

export class StateStore {
  private readonly statePath: string;
  private state: PersistedState = createDefaultState();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly logger: Logger) {
    this.statePath = join(dataDir, STATE_FILE);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      const raw = await readFile(this.statePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return '';
        }
        throw error;
      });

      if (raw) {
        this.state = parsePersistedState(raw);
      } else {
        await this.persist();
      }

      this.initialized = true;
    } catch (error) {
      throw new StateStoreError('Failed to initialize state store', { cause: error });
    }
  }

  isProcessed(bucketFolderKey: string): boolean {
    this.ensureInitialized();

    const key = makeProcessedKey(bucketFolderKey);
    const last = this.state.lastProcessed;
    if (last?.bucketFolderKey === key) {
      return true;
    }

    return Boolean(this.state.processedByKey[key]);
  }

  async markProcessed(record: ProcessedRecord): Promise<void> {
    this.ensureInitialized();

    const key = makeProcessedKey(record.bucketFolderKey);
    const normalizedRecord: ProcessedRecord = {
      ...record,
      bucketFolderKey: key
    };

    this.state.lastProcessed = normalizedRecord;
    this.state.processedByKey[key] = normalizedRecord;

    const entries = Object.entries(this.state.processedByKey);
    if (entries.length > MAX_PROCESSED_RECORDS) {
      const sorted = entries.sort(([, a], [, b]) => a.processedAt.localeCompare(b.processedAt));
      const toRemove = sorted.slice(0, entries.length - MAX_PROCESSED_RECORDS);
      for (const [oldKey] of toRemove) {
        delete this.state.processedByKey[oldKey];
      }
    }

    await this.persistQueued();
  }

  async appendRunLog(entry: RunLogRecord): Promise<void> {
    this.ensureInitialized();

    this.state.runLogs.push(entry);
    if (this.state.runLogs.length > MAX_RUN_LOGS) {
      this.state.runLogs.splice(0, this.state.runLogs.length - MAX_RUN_LOGS);
    }

    await this.persistQueued();
  }

  getLastProcessed(): ProcessedRecord | null {
    this.ensureInitialized();
    return this.state.lastProcessed;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new StateStoreError('State store is not initialized. Call init() first.');
    }
  }

  private async persistQueued(): Promise<void> {
    const nextWrite = this.writeChain.then(async () => {
      await this.persist();
    });

    this.writeChain = nextWrite.catch((error) => {
      this.logger.error('State persist failed', { error: getErrorMessage(error) });
    });

    await nextWrite;
  }

  private async persist(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.statePath}.tmp`;

    await writeFile(tempPath, serialized, 'utf8');
    await rename(tempPath, this.statePath);
  }
}

function createDefaultState(): PersistedState {
  return {
    lastProcessed: null,
    processedByKey: {},
    runLogs: []
  };
}

function parsePersistedState(raw: string): PersistedState {
  const parsed = JSON.parse(raw) as {
    lastProcessed?: Partial<ProcessedRecord>;
    processedByKey?: Record<string, Partial<ProcessedRecord>>;
    runLogs?: RunLogRecord[];
  };

  const normalizedProcessedByKey: Record<string, ProcessedRecord> = {};

  for (const [key, value] of Object.entries(parsed.processedByKey ?? {})) {
    const bucketFolderKey = typeof value.bucketFolderKey === 'string' ? value.bucketFolderKey : key;
    if (typeof value.permalink !== 'string' || typeof value.shortcode !== 'string' || typeof value.processedAt !== 'string') {
      continue;
    }

    normalizedProcessedByKey[makeProcessedKey(bucketFolderKey)] = {
      bucketFolderKey: makeProcessedKey(bucketFolderKey),
      permalink: value.permalink,
      shortcode: value.shortcode,
      processedAt: value.processedAt,
      ...(typeof value.facebookPostId === 'string' ? { facebookPostId: value.facebookPostId } : {})
    };
  }

  let normalizedLastProcessed: ProcessedRecord | null = null;
  const rawLast = parsed.lastProcessed;
  if (
    rawLast &&
    typeof rawLast.permalink === 'string' &&
    typeof rawLast.shortcode === 'string' &&
    typeof rawLast.processedAt === 'string'
  ) {
    const key = makeProcessedKey(
      typeof rawLast.bucketFolderKey === 'string' ? rawLast.bucketFolderKey : `legacy/${rawLast.shortcode}`
    );

    normalizedLastProcessed = {
      bucketFolderKey: key,
      permalink: rawLast.permalink,
      shortcode: rawLast.shortcode,
      processedAt: rawLast.processedAt,
      ...(typeof rawLast.facebookPostId === 'string' ? { facebookPostId: rawLast.facebookPostId } : {})
    };
  }

  return {
    lastProcessed: normalizedLastProcessed,
    processedByKey: normalizedProcessedByKey,
    runLogs: parsed.runLogs ?? []
  };
}

function makeProcessedKey(bucketFolderKey: string): string {
  return bucketFolderKey.replace(/^\/+/, '').replace(/\/+$/, '');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
