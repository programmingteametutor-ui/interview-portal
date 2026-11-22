import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { SessionProvider, useSession } from "./lib/session";
import { useRoute } from "./lib/router";
import { ToastProvider, Loading } from "./components/ui";
import { Layout } from "./components/Layout";
import { configMissing } from "./lib/supabase";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Intake } from "./pages/Intake";
import { Schedule } from "./pages/Schedule";
import { Approvals } from "./pages/Approvals";
import { Incentives } from "./pages/Incentives";
import { Monthly } from "./pages/Monthly";
import { Identity } from "./pages/Identity";
import { Reports } from "./pages/Reports";
import { Admin } from "./pages/Admin";
import { Audit } from "./pages/Audit";
import { Recovery } from "./pages/Recovery";
import { Health } from "./pages/Health";
import { Interviews } from "./pages/Interviews";
import { Promotions } from "./pages/Promotions";

const PAGES: Record<string, ComponentType> = {
  dashboard: Dashboard, intake: Intake, schedule: Schedule, approvals: Approvals, interviews: Interviews, promotions: Promotions, incentives: Incentives,
  monthly: Monthly, recovery: Recovery, identity: Identity, reports: Reports, health: Health, admin: Admin, audit: Audit,
};

function App() {
  if (configMissing) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-2">
          <p className="font-medium text-slate-800">The portal is not configured.</p>
          <p className="text-sm text-slate-500">
            This build has no <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>. Set them in the hosting
            provider's environment variables (e.g. Vercel → Settings → Environment Variables) and redeploy.
          </p>
        </div>
      </div>
    );
  }
  return <ConfiguredApp />;
}

function ConfiguredApp() {
  const s = useSession();
  const { page } = useRoute();
  if (s.loading) return <Loading />;
  if (!s.session) return <Login />;
  if (!s.ctx?.linked || !s.role) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-slate-700">Your email <b>{s.session.user.email}</b> is signed in but has no active portal role.</p>
          <p className="text-sm text-slate-500">Ask a Super Admin to add you under Administration → Users &amp; Roles.</p>
          <button className="text-sm text-indigo-600" onClick={s.signOut}>Sign out</button>
        </div>
      </div>
    );
  }
  const target = s.canSee(page) ? page : "dashboard";
  const Page = PAGES[target] ?? Dashboard;
  return <Layout page={target}><Page key={`${target}|${s.teamId}|${s.role}`} /></Layout>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <SessionProvider><App /></SessionProvider>
    </ToastProvider>
  </StrictMode>,
);
