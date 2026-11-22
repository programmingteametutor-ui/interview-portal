import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  // Read .env files plus the host's environment (all prefixes) at build time.
  const env = { ...loadEnv(mode, __dirname, ""), ...process.env };
  // Accept the names Vercel's Supabase integration creates as well as our own VITE_ names.
  // Only these two PUBLIC values are passed to the browser — never SUPABASE_JWT_SECRET / service-role keys.
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@shared": path.resolve(__dirname, "../shared") } },
    server: { fs: { allow: [".."] } },
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(supabaseAnonKey),
    },
  };
});
