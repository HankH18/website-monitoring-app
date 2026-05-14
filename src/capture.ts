import { chromium, Browser } from "playwright";
import fs from "fs";
import { loadConfig } from "./config";
import { CaptureResult } from "./types";
import { ensureCaptureDir, getScreenshotPath, getTextPath } from "./storage/files";
import { logger } from "./logger";

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export async function capturePage(url: string): Promise<CaptureResult> {
  const config = loadConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const captureDir = ensureCaptureDir(url, timestamp);
  const screenshotPath = getScreenshotPath(captureDir);
  const textPath = getTextPath(captureDir);

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
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
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
            "h1", "h2", "h3", "h4", "h5", "h6",
            "nav", "main", "header", "footer", "article", "section",
            "form", "table", "ul", "ol", "li", "a", "img", "button",
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

    logger.info(`Captured ${url} -> ${captureDir}`);

    return {
      screenshotPath,
      textContent,
      textPath,
      timestamp,
      url,
    };
  } catch (err: any) {
    logger.error(`Capture failed for ${url}: ${err.message}`);

    // Save error state screenshot if possible
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {}

    const errorText = `ERROR: ${err.message}`;
    fs.writeFileSync(textPath, errorText, "utf-8");

    return {
      screenshotPath,
      textContent: errorText,
      textPath,
      timestamp,
      url,
      error: err.message,
    };
  } finally {
    await context.close();
  }
}
