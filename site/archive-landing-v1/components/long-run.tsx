/** Generated from the approved static landing page for parity. */
export function LongRunSection() {
  return (
    <section className="section v3-controls-section" id="long-run">
      <div className="page">
        <header className="section-head">
          <div>
            <p className="section-kicker">Long-running work</p>
            <h2 className="section-heading">Runs for hours without dropping the thread.</h2>
          </div>
          <p className="section-intro">
            A tool-heavy task can span dozens of steps and hundreds of thousands of tokens. Delta
            keeps the active window bounded and every earlier finding recoverable; nothing
            load-bearing is ever thrown away.
          </p>
        </header>
        <div className="autonomy-contract">
          <div>
            <span>01</span>
            <strong>Compact before overflow</strong>
            <p>
              The engine estimates each request and compacts older turns before sending, so a long
              run never blows the context window.
            </p>
          </div>
          <div>
            <span>02</span>
            <strong>Nothing is deleted</strong>
            <p>
              Compacted turns are archived, not dropped, and large results spill to disk with a
              pointer the agent can read back.
            </p>
          </div>
          <div>
            <span>03</span>
            <strong>Audited summaries</strong>
            <p>
              Each summary is checked to preserve every number, date and path, and merges forward
              across generations so a step-3 fact survives to step 50.
            </p>
          </div>
          <div>
            <span>04</span>
            <strong>Recall and recite</strong>
            <p>
              The agent searches its own compacted history with recall and keeps a working plan that
              rides through every compaction.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
