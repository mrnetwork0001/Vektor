import { toast } from "react-toastify";

/** Toast always; OS notification too when the user granted permission. */
export function notify(title: string, body: string, level: "info" | "warn" | "crit" = "info") {
  const fn = level === "crit" ? toast.error : level === "warn" ? toast.warn : toast.info;
  fn(`${title} — ${body}`);
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(`Vektor · ${title}`, { body });
    }
  } catch { /* unsupported */ }
}

export async function requestAlerts(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  const p = await Notification.requestPermission();
  return p === "granted";
}

export const alertsEnabled = () => typeof Notification !== "undefined" && Notification.permission === "granted";
