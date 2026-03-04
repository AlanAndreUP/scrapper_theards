import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

dotenv.config();

async function main(): Promise<void> {
  const storageStatePath = resolve(process.env.PLAYWRIGHT_STORAGE_STATE_PATH ?? './data/instagram-storage-state.json');
  const loginUrl = 'https://www.instagram.com/accounts/login/';

  await mkdir(dirname(storageStatePath), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'es-ES'
  });

  const page = await context.newPage();

  try {
    console.log('Abriendo Instagram login...');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    console.log('Inicia sesión manualmente (incluye 2FA si aplica).');
    console.log('Cuando termines y veas tu sesión activa, vuelve aquí y presiona Enter.');

    const readline = createInterface({ input, output });
    await readline.question('Presiona Enter para guardar la sesión de Instagram... ');
    readline.close();

    const cookies = await context.cookies('https://www.instagram.com');
    const hasSessionCookie = cookies.some((cookie) => cookie.name === 'sessionid');

    if (!hasSessionCookie) {
      console.warn('No se detectó cookie sessionid. Es posible que el login no haya terminado correctamente.');
    }

    await context.storageState({ path: storageStatePath });

    console.log(`Sesión guardada en: ${storageStatePath}`);
    console.log('Ahora activa IG_USE_AUTH_SESSION=true y ejecuta npm run dev.');
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error en login de Instagram: ${message}`);
  process.exit(1);
});
