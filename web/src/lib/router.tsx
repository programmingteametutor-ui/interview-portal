import { useEffect, useState } from "react";

/** Minimal hash router: #/page?x=1 — works on any static host without rewrites. */
export function useRoute(): { page: string; params: URLSearchParams } {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, "");
    const [page, qs] = h.split("?");
    return { page: page || "dashboard", params: new URLSearchParams(qs || "") };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(page: string, params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  window.location.hash = `#/${page}${qs}`;
}
