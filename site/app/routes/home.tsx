// biome-ignore-all lint/security/noDangerouslySetInnerHtml: The only raw HTML is JSON-LD serialized from a static local object.
import { useEffect } from "react";

import {
  BuildSection,
  CodingAgentsSection,
  ControlsSection,
  DeploySection,
  GetStartedSection,
  LearningSection,
  LongRunSection,
  ModelsSection,
  ObserveSection,
  PatternsSection,
  ProductSection,
  ProofSection,
  SiteFooter,
  SiteHeader,
  SystemSection,
  TopSection,
  UseCasesSection,
  WhyDeltaSection,
} from "~/components/landing";
import { initializeLandingInteractions } from "~/legacy/landing-interactions";
import "~/styles/landing.css";
import "~/styles/enhancements.css";

const canonicalUrl = "https://deltaharness.dev/";
const pageTitle = "Delta — Agents that finish the work";
const socialTitle = "Agents that finish the work.";
const description =
  "The open-source harness for long-running tasks, combining MCP tools, managed context, subagents and self-improvement in one lean runtime.";
const socialDescription =
  "Build long-running agents with MCP tools, managed context, subagents and self-improvement—all in one lean open-source runtime.";
const socialImageUrl = `${canonicalUrl}delta-og-image.png`;
const socialImageAlt = "Delta triangular logo and wordmark on a warm off-white background";

export function meta() {
  return [
    { title: pageTitle },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: canonicalUrl },
    {
      tagName: "link",
      rel: "alternate",
      type: "text/markdown",
      href: `${canonicalUrl}guide.md`,
      title: "Delta guide in Markdown",
    },
    { name: "robots", content: "index, follow, max-image-preview:large" },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Delta" },
    { property: "og:locale", content: "en_US" },
    { property: "og:title", content: socialTitle },
    { property: "og:description", content: socialDescription },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: socialImageUrl },
    { property: "og:image:type", content: "image/png" },
    { property: "og:image:width", content: "2401" },
    { property: "og:image:height", content: "1260" },
    { property: "og:image:alt", content: socialImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: socialTitle },
    { name: "twitter:description", content: socialDescription },
    { name: "twitter:image", content: socialImageUrl },
    { name: "twitter:image:alt", content: socialImageAlt },
  ];
}

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${canonicalUrl}#website`,
  name: "Delta",
  alternateName: "Delta Harness",
  url: canonicalUrl,
  description,
  inLanguage: "en",
};

export default function Home() {
  useEffect(() => {
    document.body.classList.add("v2", "v3");
    initializeLandingInteractions();
  }, []);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div
        className="sr-only"
        id="copy-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />

      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <TopSection />
        <ProofSection />
        <ProductSection />
        <WhyDeltaSection />
        <UseCasesSection />
        <SystemSection />
        <LearningSection />
        <ControlsSection />
        <LongRunSection />
        <PatternsSection />
        <BuildSection />
        <ObserveSection />
        <DeploySection />
        <ModelsSection />
        <CodingAgentsSection />
        <GetStartedSection />
      </main>
      <SiteFooter />
    </>
  );
}
