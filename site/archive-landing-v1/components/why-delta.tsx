// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The horizontally scrollable comparison must be keyboard-scrollable.
/** Generated from the approved static landing page for parity. */
export function WhyDeltaSection() {
  return (
    <section className="section category-section" id="why-delta">
      <div className="page">
        <header className="section-head category-head">
          <div>
            <p className="section-kicker">Why Delta</p>
            <h2 className="section-heading">Built for knowledge work beyond the repository.</h2>
          </div>
          <p className="section-intro">
            Delta sits between raw model APIs and managed agent platforms: a self-hosted runtime for
            durable, cross-tool work.
          </p>
        </header>

        <div className="category-compare">
          <section
            className="category-table-scroll"
            aria-label="Comparison of agent operating models"
            tabIndex={0}
          >
            <table className="category-table">
              <caption>
                Comparison of a model call, a coding harness, a hosted agent platform and Delta
              </caption>
              <colgroup>
                <col className="comparison-dimension" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Compare by</th>
                  <th scope="col">
                    <span className="category-column-type">Primitive</span>
                    <span className="category-column-title">Model call</span>
                  </th>
                  <th scope="col">
                    <span className="category-column-type">Specialist</span>
                    <span className="category-column-title">Coding harness</span>
                  </th>
                  <th scope="col">
                    <span className="category-column-type">Platform</span>
                    <span className="category-column-title">Hosted agent platform</span>
                  </th>
                  <th className="delta-cell" scope="col">
                    <span className="category-column-type">Runtime</span>
                    <span className="category-column-title">
                      <span className="category-delta-mark" aria-hidden="true">
                        △
                      </span>
                      Delta
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Starting point</th>
                  <td>Model request</td>
                  <td>Code repository</td>
                  <td>Managed agent service</td>
                  <td className="delta-cell">Knowledge-work outcome</td>
                </tr>
                <tr>
                  <th scope="row">Center of gravity</th>
                  <td>Generate one response</td>
                  <td>Inspect and change code</td>
                  <td>Build on managed primitives</td>
                  <td className="delta-cell">Complete cross-tool work</td>
                </tr>
                <tr>
                  <th scope="row">Runtime lives in</th>
                  <td>Your application</td>
                  <td>Your development environment</td>
                  <td>The hosted platform</td>
                  <td className="delta-cell">Your infrastructure</td>
                </tr>
                <tr>
                  <th scope="row">Durability</th>
                  <td>Added by your application</td>
                  <td>Varies by harness</td>
                  <td>Provided by the platform</td>
                  <td className="delta-cell">Built into the runtime</td>
                </tr>
                <tr>
                  <th scope="row">Best fit</th>
                  <td>Bounded LLM features</td>
                  <td>Repository-centered agents</td>
                  <td>Managed agent applications</td>
                  <td className="delta-cell">Durable knowledge work</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </section>
  );
}
