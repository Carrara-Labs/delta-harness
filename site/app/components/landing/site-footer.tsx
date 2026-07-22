import { useLocation } from "react-router";

/** Generated from the approved static landing page for parity. */
export function SiteFooter() {
  const year = new Date().getFullYear();
  const onHome = useLocation().pathname === "/";
  const to = (id: string) => (onHome ? `#${id}` : `/#${id}`);

  return (
    <footer className="site-footer">
      <div className="page footer-inner">
        <div className="footer-meta">
          <span>&copy; {year} Delta. Built for durable knowledge work.</span>
          <span className="footer-credit">
            Built by{" "}
            <a href="https://github.com/TNEP4" target="_blank" rel="noopener">
              Nic Touron
            </a>{" "}
            <a
              href="https://carrara.is/?utm_source=delta&utm_medium=referral&utm_campaign=footer_credit&utm_content=landing"
              target="_blank"
              rel="noopener"
            >
              @Carrara Labs
            </a>
          </span>
        </div>
        <div className="footer-links">
          <a href="/how-it-works">How it works</a>
          <a href={to("product")}>Product</a>
          <a href={to("build")}>Build</a>
          <a href={to("deploy")}>Deploy</a>
          <a href="/docs/">Docs</a>
        </div>
      </div>
    </footer>
  );
}
