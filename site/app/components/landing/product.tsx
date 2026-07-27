// biome-ignore-all lint/security/noDangerouslySetInnerHtml: This file renders checked-in, trusted parity markup rather than user content.
import cockpitMarkup from "~/legacy/cockpit.html?raw";

type ProductSectionProps = {
  /** Override the embedded kicker (default "Delta Cockpit"). */
  kicker?: string;
  /** Override the embedded heading (default "Inspect the work, not just the answer."). */
  heading?: string;
};

/**
 * The Cockpit is a deliberately isolated parity island: its approved demo
 * markup stays byte-for-byte compatible while React owns the route, section,
 * lifecycle and interaction bootstrap around it. Optional title props let a
 * specific route reframe the section (e.g. "Test your agent") via a targeted
 * replace, without editing the shared markup.
 */
export function ProductSection({ kicker, heading }: ProductSectionProps = {}) {
  let markup = cockpitMarkup;
  if (kicker) {
    markup = markup.replace(
      '<p class="section-kicker">Delta Cockpit</p>',
      `<p class="section-kicker">${kicker}</p>`,
    );
  }
  if (heading) {
    markup = markup.replace(
      '<h2 id="cockpit-title">Inspect the work, not just the answer.</h2>',
      `<h2 id="cockpit-title">${heading}</h2>`,
    );
  }
  return (
    <section
      className="section v3-product-section"
      id="product"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
