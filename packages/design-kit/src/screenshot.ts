// Screenshots of a page at phone and desktop width, light and dark, for the design-critic
// agent. playwright-core is optional: a project that wants screenshots installs it (and a
// browser); without it this says so and the critic reviews the markup and styles instead.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Shot {
  path: string;
  width: number;
  scheme: "light" | "dark";
  /** The page is wider than the viewport: it scrolls sideways at this width. */
  overflowsX: boolean;
}

export class NoBrowser extends Error {}

type Page = {
  goto(url: string, o: object): Promise<unknown>;
  screenshot(o: object): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
};
type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };
type Playwright = { chromium: { launch(o: object): Promise<Browser> } };

async function loadPlaywright(): Promise<Playwright> {
  const name = "playwright-core"; // a variable, so the typecheck doesn't need the package
  try {
    return (await import(name)) as Playwright;
  } catch {
    throw new NoBrowser("playwright-core is not installed. Add it as a dev dependency and install a browser (`playwright-core install chromium`) to get screenshots.");
  }
}

export async function screenshot(
  url: string,
  opts: { out: string; widths?: number[]; schemes?: ("light" | "dark")[]; executablePath?: string },
): Promise<Shot[]> {
  const { chromium } = await loadPlaywright();
  let browser: Browser;
  try {
    browser = await chromium.launch({ executablePath: opts.executablePath });
  } catch (e) {
    throw new NoBrowser(`playwright-core could not start Chromium (${(e as Error).message.split("\n")[0]}). Run \`playwright-core install chromium\`, or pass --executable.`);
  }
  mkdirSync(opts.out, { recursive: true });
  const shots: Shot[] = [];
  try {
    for (const scheme of opts.schemes ?? ["light", "dark"]) {
      for (const width of opts.widths ?? [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
        await page.goto(url, { waitUntil: "networkidle" });
        const path = join(opts.out, `page-${width}-${scheme}.png`);
        await page.screenshot({ path, fullPage: true });
        const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        shots.push({ path, width, scheme, overflowsX });
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return shots;
}
