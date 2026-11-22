export const inr = (n: number | null | undefined) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** Working date in IST. Calls before 06:00 IST belong to the previous working day. */
export function todayWorkDate(cutoverHour = 6): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000);
  if (ist.getHours() < cutoverHour) ist.setDate(ist.getDate() - 1);
  return isoDate(ist);
}
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function prettyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
export function monthKey(iso: string): string { return iso.slice(0, 7); }
export function monthLabel(ym: string): string {
  const d = new Date(ym.slice(0, 7) + "-01T00:00:00");
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}
export function monthRange(ym: string): [string, string] {
  const d = new Date(ym + "-01T00:00:00");
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return [ym + "-01", isoDate(end)];
}
export { formatMinutes as formatMinutesSafe } from "@shared/parser";
export const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows.map((r) => r.map((v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
