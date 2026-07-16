import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "64x64" },
  {
    rel: "icon",
    href: "/delta-logo-light-background.svg",
    type: "image/svg+xml",
    id: "theme-favicon",
  },
  { rel: "manifest", href: "/site.webmanifest" },
];

const themeBootstrap = `(() => {
  let stored = null;
  try { stored = localStorage.getItem("delta-theme"); } catch {}
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  const color = document.querySelector('meta[name="theme-color"]');
  if (color) color.content = theme === "dark" ? "#1d1b16" : "#f7f7f4";
  const favicon = document.getElementById("theme-favicon");
  if (favicon) favicon.href = theme === "dark"
    ? "/delta-logo-dark-background.svg"
    : "/delta-logo-light-background.svg";
})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="application-name" content="Delta" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#f7f7f4" />
        <Meta />
        <Links />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: The static theme bootstrap prevents a flash before hydration. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="v2 v3">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-24">
      <p className="mb-3 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
        Delta
      </p>
      <h1 className="text-5xl font-semibold tracking-[-0.04em]">{message}</h1>
      <p className="mt-5 text-lg text-muted-foreground">{details}</p>
      {stack && (
        <pre className="mt-8 w-full overflow-x-auto rounded-xl border bg-muted p-4 text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
