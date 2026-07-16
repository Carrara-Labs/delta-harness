/** Generated from the approved static landing page for parity. */
export function SystemSection() {
  return (
    <section className="section v3-system-section" id="system">
      <div className="page">
        <header className="section-head">
          <div>
            <p className="section-kicker">The runtime</p>
            <h2 className="section-heading">Files, MCP tools, memory and subagents. Built in.</h2>
          </div>
          <p className="section-intro">
            Each capability has an explicit place in the prompt, runtime or durable state.
          </p>
        </header>

        <div className="capability-grid outcome-grid">
          <article className="capability outcome-card">
            <span className="capability-number">01</span>
            <h3>Work across tools and files</h3>
            <p>
              Research through MCP, work with files, delegate focused tasks and invoke a coding
              agent when needed.
            </p>
            <div className="capability-tags">
              <span>Files</span>
              <span>MCP</span>
              <span>Subagents</span>
              <span>Code CLI</span>
              <span>Schedules</span>
            </div>
          </article>
          <article className="capability outcome-card">
            <span className="capability-number">02</span>
            <h3>Learn within bounds</h3>
            <p>Carry scoped memory, recall and bounded self-file updates into the next run.</p>
            <div className="capability-tags">
              <span>DELTA.md</span>
              <span>Scoped memory</span>
              <span>Recall</span>
              <span>Reflection</span>
            </div>
          </article>
          <article className="capability outcome-card">
            <span className="capability-number">03</span>
            <h3>Keep control explicit</h3>
            <p>
              Apply fixed policy, usage guards, checkpoints, cancellation and reviewed-write
              guidance.
            </p>
            <div className="capability-tags">
              <span>Policy</span>
              <span>Usage guards</span>
              <span>Review rail</span>
              <span>Recovery</span>
              <span>Redaction</span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
