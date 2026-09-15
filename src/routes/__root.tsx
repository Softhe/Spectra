import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import appCss from "../styles.css?url";

const APP_NAME = "Spectra";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Compare two copies of the same song and see which one actually kept the high frequencies.",
      },
      { name: "theme-color", content: "#08090b" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
      { rel: "preload", href: "/fonts/plex-sans-var.woff2", as: "font", type: "font/woff2", crossOrigin: "anonymous" },
    ],
  }),
  component: () => {
    // Offline shell: registered in production only, so dev HMR never fights
    // a stale cache. Skipped where unsupported (older Safari, insecure ctx).
    useEffect(() => {
      if (!import.meta.env.PROD) return;
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }, []);
    return (
      <html lang="en" className="antialiased" suppressHydrationWarning>
        <head>
          <HeadContent />
        </head>
        <body>
          <PreviewHostBridge />
          <AuthProvider>
            <Outlet />
          </AuthProvider>
          <Scripts />
        </body>
      </html>
    );
  },
});
