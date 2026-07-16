/** Generated from the approved static landing page for parity. */
export function ModelsSection() {
  return (
    <section className="section section-wash section-wash-blue" id="models">
      <div className="page">
        <div className="providers-head">
          <div>
            <p className="section-kicker">Provider neutral</p>
            <h2 className="section-heading">Switch providers. Keep the same agent contract.</h2>
          </div>
          <p className="section-intro">
            Use compatible Chat Completions, native Anthropic Messages or OpenAI Responses while
            preserving policy, identity and tools.
          </p>
        </div>

        <div className="provider-list">
          <article className="provider">
            <span className="provider-index">01</span>
            <h3>OpenRouter</h3>
            <p>Route across models with streaming, provider choice and cost-aware usage.</p>
            <span className="provider-tag">DEFAULT</span>
          </article>
          <article className="provider">
            <span className="provider-index">02</span>
            <h3>Anthropic</h3>
            <p>Use native Messages with prompt caching and configurable thinking budgets.</p>
            <span className="provider-tag">NATIVE</span>
          </article>
          <article className="provider">
            <span className="provider-index">03</span>
            <h3>OpenAI</h3>
            <p>
              Use native Responses, or compatible Chat Completions through the OpenAI-compatible
              route.
            </p>
            <span className="provider-tag">RESPONSES</span>
          </article>
          <article className="provider">
            <span className="provider-index">04</span>
            <h3>Codex subscription</h3>
            <p>
              Broker-minted Responses access for subscription-backed deployments; tokens are
              restricted to configured allowlisted hosts.
            </p>
            <span className="provider-tag">PREVIEW</span>
          </article>
        </div>
      </div>
    </section>
  );
}
