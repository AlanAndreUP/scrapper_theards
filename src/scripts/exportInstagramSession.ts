import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  const storageStatePath = resolve(process.env.PLAYWRIGHT_STORAGE_STATE_PATH ?? './data/instagram-storage-state.json');

  const raw = await readFile(storageStatePath, 'utf8');
  const parsed = JSON.parse(raw) as { cookies?: unknown[]; origins?: unknown[] };

  if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error('El archivo storageState no tiene formato válido de Playwright.');
  }

  const b64 = Buffer.from(raw, 'utf8').toString('base64');

  console.log('Copia esta variable en tu entorno cloud (secreto):');
  console.log('');
  console.log(`PLAYWRIGHT_STORAGE_STATE_B64=${b64}`);
  console.log('');
  console.log(`Origen: ${storageStatePath}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error exportando sesión de Instagram: ${message}`);
  process.exit(1);
});
