import { BookOpenIcon } from "lucide-react";

import { MobileNavigation } from "~/components/mobile-navigation";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";

const repositoryUrl = "https://github.com/Carrara-Labs/delta-harness";

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.02c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.98 10.98 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.18c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header
      className="site-header"
      style={{
        backdropFilter: "blur(24px) saturate(140%)",
        WebkitBackdropFilter: "blur(24px) saturate(140%)",
      }}
    >
      <nav className="nav page" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="Delta home">
          <span className="brand-mark" aria-hidden="true">
            <img
              className="brand-logo brand-logo-light"
              src="/delta-logo-light-background.svg"
              alt=""
            />
            <img
              className="brand-logo brand-logo-dark"
              src="/delta-logo-dark-background.svg"
              alt=""
            />
          </span>
          <span>delta</span>
        </a>

        <div className="nav-links">
          <a href="#product">Product</a>
          <a href="#why-delta">Why Delta</a>
          <a href="#use-cases">Use cases</a>
          <a href="#build">Build</a>
          <a href="#observe">Operate</a>
        </div>

        <div className="nav-tools">
          <Button asChild className="nav-github-link" size="icon" variant="ghost">
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="View Delta on GitHub"
              title="View Delta on GitHub"
            >
              <GitHubMark />
            </a>
          </Button>
          <Button asChild className="nav-docs-button" variant="outline">
            <a href="/docs/" aria-label="Documentation">
              <BookOpenIcon data-icon="inline-start" aria-hidden="true" />
              <span>Docs</span>
            </a>
          </Button>
          <MobileNavigation />
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
