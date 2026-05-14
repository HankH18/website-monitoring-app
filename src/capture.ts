import { chromium, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { CaptureResult, FormAuthConfig, SelectorCapture } from "./types";
import { ensureCaptureDir, getScreenshotPath, getTextPath } from "./storage/files";
import { logger } from "./logger";
import { withRetry } from "./util/retry";

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browser) {
    try {
      await _browser.close();
    } catch {
      // Already disconnected or closing — we will replace below.
    }
    _browser = null;
  }
  _browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export function getBrowserStatus(): "ok" | "not_started" | "disconnected" {
  if (!_browser) return "not_started";
  return _browser.isConnected() ? "ok" : "disconnected";
}

function isTransientGotoError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; name?: string };
  const msg = (e.message || "").toLowerCase();
  if (!msg) return false;

  // Permanent: invalid URL / DNS NXDOMAIN
  if (
    msg.includes("err_name_not_resolved") ||
    msg.includes("name_not_resolved") ||
    msg.includes("invalid url") ||
    msg.includes("nxdomain")
  ) {
    return false;
  }

  // Permanent: 4xx responses surfaced as error
  if (/\b4\d{2}\b/.test(msg)) return false;

  // Transient: timeouts, network resets, connection errors, 5xx
  if (
    e.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("err_connection") ||
    msg.includes("err_network") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("net::") ||
    /\b5\d{2}\b/.test(msg)
  ) {
    return true;
  }

  return false;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export async function capturePage(
  url: string,
  selectors: string[] = [],
  auth?: FormAuthConfig,
): Promise<CaptureResult> {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const captureDir = ensureCaptureDir(url, timestamp);
  const screenshotPath = getScreenshotPath(captureDir);
  const textPath = getTextPath(captureDir);

  // Fall back to looking up auth from config.yaml (auth lives in config, not DB).
  const effectiveAuth = auth ?? config.urls.find((u) => u.url === url)?.auth ?? undefined;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: {
      width: config.playwright.viewport_width,
      height: config.playwright.viewport_height,
    },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    if (effectiveAuth && effectiveAuth.type === "form") {
      const authErr = await performFormLogin(page, effectiveAuth);
      if (authErr) {
        const errorText = `ERROR: auth failed: ${authErr}`;
        try {
          await page.screenshot({ path: screenshotPath, fullPage: false });
        } catch {
          // Best-effort screenshot after auth failure; ignore if page is unusable.
        }
        fs.writeFileSync(textPath, errorText, "utf-8");
        logger.error(`Capture auth failed for ${url}: ${authErr}`);
        return {
          screenshotPath,
          textContent: errorText,
          textPath,
          timestamp,
          url,
          error: `auth failed: ${authErr}`,
        };
      }
    }

    await withRetry(
      async () => {
        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        if (response && response.status() >= 500) {
          throw new Error(`HTTP ${response.status()} from ${url}`);
        }
      },
      {
        attempts: 3,
        backoffMs: [1000, 3000, 9000],
        retryable: isTransientGotoError,
        onRetry: (err, attempt, delayMs) => {
          const msg = (err as { message?: string })?.message ?? String(err);
          logger.warn(
            `Capture transient error for ${url} (attempt ${attempt}): ${msg} — retrying in ${delayMs}ms`,
          );
        },
      },
    );
    await page.waitForTimeout(config.playwright.wait_after_load_ms);

    // Take screenshot
    await page.screenshot({
      path: screenshotPath,
      fullPage: config.playwright.full_page_screenshot,
    });

    // Extract visible text content and structural outline
    const textContent = await page.evaluate(() => {
      function extractContent(node: Node): string {
        // Skip script, style, noscript, and hidden elements
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tag = el.tagName.toLowerCase();

          if (["script", "style", "noscript", "svg", "iframe"].includes(tag)) return "";

          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return "";

          // Strip Shopify-specific dynamic attributes
          const stripped = el.cloneNode(false) as HTMLElement;
          stripped.removeAttribute("data-section-id");
          stripped.removeAttribute("data-shopify");
          stripped.removeAttribute("id");
          stripped.removeAttribute("class");

          // Build structural tag for headings, nav, main, article, etc.
          const structuralTags = [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "nav",
            "main",
            "header",
            "footer",
            "article",
            "section",
            "form",
            "table",
            "ul",
            "ol",
            "li",
            "a",
            "img",
            "button",
          ];

          let prefix = "";
          let suffix = "";
          if (structuralTags.includes(tag)) {
            if (tag === "img") {
              const alt = el.getAttribute("alt") || "";
              const src = el.getAttribute("src") || "";
              return `[IMG: alt="${alt}" src="${src.split("?")[0]}"]\n`;
            }
            if (tag === "a") {
              const href = el.getAttribute("href") || "";
              prefix = `[LINK: ${href}] `;
            } else if (tag.match(/^h[1-6]$/)) {
              prefix = `\n${tag.toUpperCase()}: `;
              suffix = "\n";
            } else if (["nav", "main", "header", "footer", "article", "section"].includes(tag)) {
              prefix = `\n--- ${tag.toUpperCase()} ---\n`;
              suffix = `\n--- /${tag.toUpperCase()} ---\n`;
            }
          }

          let content = "";
          for (const child of Array.from(node.childNodes)) {
            content += extractContent(child);
          }
          return prefix + content + suffix;
        }

        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent || "").trim();
          if (!text) return "";
          // Filter out session tokens, timestamps, and dynamic IDs
          if (text.match(/^[a-f0-9-]{20,}$/i)) return "";
          return text + " ";
        }

        return "";
      }

      return extractContent(document.body)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    });

    fs.writeFileSync(textPath, textContent, "utf-8");

    const selectorCaptures = await captureSelectors(page, captureDir, selectors);

    logger.info(`Captured ${url} -> ${captureDir}`);

    return {
      screenshotPath,
      textContent,
      textPath,
      timestamp,
      url,
      selectors: selectorCaptures,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Capture failed for ${url}: ${msg}`);

    // Save error state screenshot if possible
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {
      // Best-effort error-state screenshot; the page may already be closed.
    }

    const errorText = `ERROR: ${msg}`;
    fs.writeFileSync(textPath, errorText, "utf-8");

    return {
      screenshotPath,
      textContent: errorText,
      textPath,
      timestamp,
      url,
      error: msg,
    };
  } finally {
    await context.close();
  }
}

async function performFormLogin(page: Page, auth: FormAuthConfig): Promise<string | null> {
  const username = process.env[auth.username_env];
  const password = process.env[auth.password_env];
  if (!username || !password) {
    return `missing env vars ${auth.username_env}/${auth.password_env}`;
  }
  try {
    await page.goto(auth.login_url, { waitUntil: "networkidle", timeout: 30000 });
    await page.locator(auth.username_selector).fill(username, { timeout: 10000 });
    await page.locator(auth.password_selector).fill(password, { timeout: 10000 });
    await page.locator(auth.submit_selector).click({ timeout: 10000 });
    await page.locator(auth.success_check).waitFor({ state: "visible", timeout: 15000 });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function captureSelectors(
  page: Page,
  captureDir: string,
  selectors: string[],
): Promise<SelectorCapture[]> {
  const results: SelectorCapture[] = [];
  for (let i = 0; i < selectors.length; i++) {
    const sel = selectors[i];
    const textPath = path.join(captureDir, `selector_${i}.txt`);
    const shotPath = path.join(captureDir, `selector_${i}.png`);
    let text = "";
    let matched = false;
    try {
      const locator = page.locator(sel).first();
      const count = await page.locator(sel).count();
      if (count > 0) {
        matched = true;
        try {
          text = (await locator.innerText({ timeout: 5000 })).trim();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Selector "${sel}" innerText failed: ${msg}`);
        }
        try {
          await locator.screenshot({ path: shotPath, timeout: 5000 });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Selector "${sel}" screenshot failed: ${msg}`);
        }
      } else {
        logger.warn(`Selector "${sel}" matched zero elements`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Selector "${sel}" evaluation failed: ${msg}`);
    }
    fs.writeFileSync(textPath, text, "utf-8");
    results.push({ selector: sel, text, textPath, screenshotPath: shotPath, matched });
  }
  return results;
}
