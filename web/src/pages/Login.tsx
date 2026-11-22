import { useEffect, useState } from "react";
import { supabase, errorText, readAuthRedirectError, cleanAuthParams } from "../lib/supabase";
import { Button, Input, Field } from "../components/ui";

const NOT_REGISTERED = /not registered|signups not allowed|not found|403/i;
const notRegisteredMsg = "This email is not registered for the portal. Ask an admin to add you.";

/** Login: Google sign-in, or email one-time code (replaces sendPortalOtp / verifyPortalOtp). */
export function Login({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(notice ?? null);

  // Coming back from Google with an error (e.g. the "before user created" hook rejected the email).
  useEffect(() => {
    const err = readAuthRedirectError();
    if (err) { setMsg(NOT_REGISTERED.test(err) ? notRegisteredMsg : err); cleanAuthParams(); }
  }, []);

  const google = async () => {
    setGoogleBusy(true); setMsg(null);
    // Unregistered Google accounts are rejected by the same hook (migration 5) as email logins,
    // and registered ones are linked to app_users by email on first login.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) { setGoogleBusy(false); setMsg(errorText(error)); }
    // on success the browser navigates to Google
  };

  const send = async () => {
    setBusy(true); setMsg(null);
    // First login creates the auth user; the "before user created" hook (migration 5) rejects
    // emails that are not registered in app_users, and RLS denies everything to unregistered users.
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) setMsg(NOT_REGISTERED.test(error.message) ? notRegisteredMsg : errorText(error));
    else { setStep("code"); setMsg("We emailed you a 6-digit code."); }
  };
  const verify = async () => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setMsg(errorText(error));
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold text-slate-900">Interview & Incentive Portal</h1>
        <p className="mb-5 mt-1 text-sm text-slate-500">Sign in with your registered email.</p>

        <button
          type="button"
          onClick={google}
          disabled={googleBusy}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <GoogleIcon />
          {googleBusy ? "Redirecting…" : "Continue with Google"}
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />or use an email code<span className="h-px flex-1 bg-slate-200" />
        </div>

        {step === "email" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" /></Field>
            <Button variant="primary" className="w-full" busy={busy}>Send code</Button>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <Field label={`Code sent to ${email}`}><Input inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="w-full tracking-widest" /></Field>
            <Button variant="primary" className="w-full" busy={busy}>Verify & sign in</Button>
            <button type="button" className="w-full text-xs text-slate-500 hover:text-slate-700" onClick={() => setStep("email")}>Use a different email</button>
          </form>
        )}
        {msg && <p className="mt-4 text-sm text-slate-600">{msg}</p>}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
