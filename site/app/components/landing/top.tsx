import { InstallTabs } from "~/components/landing/install-tabs";

export function TopSection() {
  return (
    <section className="hero" id="top">
      <div className="page hero-inner">
        <p className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          The open source harness for knowledge work
        </p>
        <h1>Agents that finish the work.</h1>
        <p className="hero-copy">
          Build agents for long-running tasks. Delta combines MCP tools, managed context, subagents
          and self-improvement in one lean runtime.
        </p>
        <div className="hero-actions">
          <a className="button" href="#product">
            Explore the walkthrough
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M4 10h11M11 6l4 4-4 4"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <a className="button button-secondary" href="#build">
            Start building
          </a>
        </div>

        <InstallTabs />
      </div>
    </section>
  );
}
