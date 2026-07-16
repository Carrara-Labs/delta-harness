import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

type Theme = "light" | "dark";

function getStoredTheme(): Theme | null {
  try {
    const theme = localStorage.getItem("delta-theme");
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#1d1b16" : "#f7f7f4");
  document
    .getElementById("theme-favicon")
    ?.setAttribute(
      "href",
      theme === "dark" ? "/delta-logo-dark-background.svg" : "/delta-logo-light-background.svg",
    );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => {
      const next = getStoredTheme() ?? (systemTheme.matches ? "dark" : "light");
      applyTheme(next);
      setTheme(next);
    };

    const handleSystemChange = () => {
      if (!getStoredTheme()) syncTheme();
    };

    syncTheme();
    systemTheme.addEventListener("change", handleSystemChange);
    return () => systemTheme.removeEventListener("change", handleSystemChange);
  }, []);

  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <Button
      className="theme-toggle"
      size="icon"
      type="button"
      variant="ghost"
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      onClick={() => {
        applyTheme(nextTheme);
        setTheme(nextTheme);
        try {
          localStorage.setItem("delta-theme", nextTheme);
        } catch {
          // The page theme can still change when storage is unavailable.
        }
      }}
    >
      <svg className="sun-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3 7 7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      <svg className="moon-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M19.2 15.4A8.1 8.1 0 0 1 8.6 4.8 8.2 8.2 0 1 0 19.2 15.4Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </Button>
  );
}
