/** Generated from the approved static landing page for parity. */
export function UseCasesSection() {
  return (
    <section className="section pattern-section" id="use-cases">
      <div className="page">
        <header className="section-head pattern-head">
          <div>
            <p className="section-kicker">Use cases</p>
            <h2 className="section-heading">
              One runtime. A chat assistant, or an agentic feature.
            </h2>
          </div>
          <p className="section-intro">
            Both are the same agent: threads for context, tools for reach and review-driven
            reflection for learning. What changes is who opens the thread and where the human gives
            feedback.
          </p>
        </header>
        <div className="pattern-grid">
          <article className="pattern-card">
            <span className="pattern-index">01 &middot; Agentic assistant</span>
            <h3>Chat that does the work, then gets better at it.</h3>
            <dl>
              <div>
                <dt>Opened by</dt>
                <dd>A person, one thread per task</dd>
              </div>
              <div>
                <dt>Work</dt>
                <dd>Tools &middot; permissioned app access &middot; propose</dd>
              </div>
              <div>
                <dt>Learns from</dt>
                <dd>How each proposal is reviewed</dd>
              </div>
            </dl>
          </article>
          <article className="pattern-card">
            <span className="pattern-index">02 &middot; Agentic feature</span>
            <h3>Turn a one-shot LLM call into an agent that improves.</h3>
            <dl>
              <div>
                <dt>Opened by</dt>
                <dd>Your product, seeded with task context</dd>
              </div>
              <div>
                <dt>Work</dt>
                <dd>Draft &middot; propose &middot; reflect on the diff</dd>
              </div>
              <div>
                <dt>Learns from</dt>
                <dd>Proposed versus accepted, per use case</dd>
              </div>
            </dl>
          </article>
          <article className="pattern-card">
            <span className="pattern-index">03 &middot; One runtime underneath</span>
            <h3>Same engine, threads, tools and review loop.</h3>
            <dl>
              <div>
                <dt>Config</dt>
                <dd>One bundle per agent</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>One loop &middot; one memory model</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>Two products, one thing to operate</dd>
              </div>
            </dl>
          </article>
        </div>
      </div>
    </section>
  );
}
