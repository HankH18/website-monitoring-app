export interface UrlConfig {
  url: string;
  label: string;
  notifications?: {
    slack?: boolean;
    email?: boolean;
  };
}

export interface AppConfig {
  schedule: string;
  delay_between_checks_ms: number;
  thresholds: {
    pixel_diff_percent: number;
    text_change_lines: number;
  };
  ack_timeout_minutes: number;
  ack_check_interval_minutes: number;
  notifications: {
    slack: boolean;
    email: boolean;
  };
  slack: {
    channel: string;
  };
  email: {
    provider: "smtp" | "resend";
    to: string;
    from: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
    };
  };
  dashboard: {
    port: number;
  };
  playwright: {
    viewport_width: number;
    viewport_height: number;
    wait_after_load_ms: number;
    full_page_screenshot: boolean;
  };
  urls: UrlConfig[];
}

export interface CaptureResult {
  screenshotPath: string;
  textContent: string;
  textPath: string;
  timestamp: string;
  url: string;
  error?: string;
  selectors?: SelectorCapture[];
}

export interface ComparisonResult {
  pixelDiffPercent: number;
  textDiffCount: number;
  textDiff: string;
  belowThreshold: boolean;
}

export interface AiAssessment {
  significant: boolean;
  confidence: number;
  summary: string;
  details: string[];
  category: "layout_break" | "content_change" | "error_state" | "missing_element" | "other";
}

export type UrlStatus = "ok" | "change_detected" | "error" | "pending";

export interface MonitoredUrl {
  id: number;
  url: string;
  label: string;
  url_hash: string;
  status: UrlStatus;
  last_checked: string | null;
  last_change: string | null;
  reference_capture_id: number | null;
  created_at: string;
  muted_until?: string | null;
  last_status_check?: string | null;
  last_status_code?: number | null;
  last_response_time_ms?: number | null;
  ssl_not_after?: string | null;
  consecutive_failures?: number;
  selectors_json?: string | null;
  selectors?: string[];
}

export interface SelectorCapture {
  selector: string;
  text: string;
  textPath: string;
  screenshotPath: string;
  matched: boolean;
}

export interface Capture {
  id: number;
  url_id: number;
  screenshot_path: string;
  text_path: string;
  text_content: string;
  timestamp: string;
  is_reference: boolean;
}

export interface ChangeEvent {
  id: number;
  url_id: number;
  capture_id: number;
  reference_capture_id: number;
  pixel_diff_percent: number;
  text_diff_count: number;
  ai_significant: boolean | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  ai_details: string | null;
  ai_category: string | null;
  notified: boolean;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_via: string | null;
  reminder_sent: boolean;
  slack_ts: string | null;
  slack_channel: string | null;
  timestamp: string;
}
