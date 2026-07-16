import { CopyButton } from "~/components/copy-button";

export function ObserveSection() {
  return (
    <section className="section v3-observe-section" id="observe">
      <div className="page">
        <div className="telemetry-block" id="telemetry">
          <div className="telemetry-head">
            <div className="telemetry-copy">
              <p className="section-kicker">Runtime telemetry</p>
              <h2 id="telemetry-title">Trace runs, tools, tokens and cost.</h2>
            </div>
            <div className="telemetry-summary">
              <p>
                Correlate each event with its user, agent, session, run and turn. Inspect live,
                persist locally or export NDJSON.
              </p>
              <a className="inline-link" href="/docs/#guide-telemetry-and-events">
                Read the telemetry setup <span aria-hidden="true">&rarr;</span>
              </a>
            </div>
          </div>

          <figure className="signal-board" aria-labelledby="telemetry-title">
            <figcaption className="signal-bar">
              <span className="signal-live">
                <i className="signal-live-dot" aria-hidden="true" />
                Event stream anatomy
              </span>
              <code>custom NDJSON &middot; GenAI-inspired fields</code>
            </figcaption>

            <div className="correlation-head">
              <strong>Correlation fields</strong>
              <span>Included when present</span>
            </div>
            <ol className="correlation-rail" aria-label="Correlation fields, when present">
              <li>
                <span className="rail-index">01</span>
                <strong>user.id</strong>
              </li>
              <li>
                <span className="rail-index">02</span>
                <strong>agent.id</strong>
              </li>
              <li>
                <span className="rail-index">03</span>
                <strong>session.id</strong>
              </li>
              <li>
                <span className="rail-index">04</span>
                <strong>run.id</strong>
              </li>
              <li>
                <span className="rail-index">05</span>
                <strong>task.id</strong>
              </li>
              <li>
                <span className="rail-index">06</span>
                <strong>entity.id</strong>
              </li>
              <li>
                <span className="rail-index">07</span>
                <strong>turn</strong>
              </li>
            </ol>

            <div className="signal-body">
              <div className="event-card">
                <div className="event-card-head">
                  <span className="event-kind">
                    <span className="event-example">Example event</span>
                    <code>model.call</code>
                  </span>
                  <time dateTime="12:43:08.621">12:43:08.621</time>
                </div>
                <strong>A single envelope keeps the operational context together.</strong>
                <p>See the served model and tracked usage without opening the full prompt.</p>
                <dl className="event-metrics">
                  <div>
                    <dt>Model</dt>
                    <dd>anthropic/claude-sonnet-5</dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>4,812 total</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>$0.0148</dd>
                  </div>
                  <div>
                    <dt>Latency</dt>
                    <dd>1,184 ms</dd>
                  </div>
                </dl>
              </div>

              <ol className="delivery-list" aria-label="Telemetry destinations">
                <li>
                  <span className="delivery-index">01</span>
                  <div>
                    <strong>Inspect live</strong>
                    <span>Cockpit and task SSE</span>
                  </div>
                </li>
                <li>
                  <span className="delivery-index">02</span>
                  <div>
                    <strong>Persist locally</strong>
                    <span>Restart-stable SQLite records</span>
                  </div>
                </li>
                <li>
                  <span className="delivery-index">03</span>
                  <div>
                    <strong>Export as NDJSON</strong>
                    <span>Batched, retried while retained and deduplicable</span>
                  </div>
                </li>
              </ol>
            </div>

            <div className="signal-config">
              <code>
                <span>TELEMETRY_URL=https://collector.example/ingest</span>
                <span>TELEMETRY_TOKEN=your_bearer_token</span>
              </code>
              <CopyButton
                className="signal-copy"
                text={`TELEMETRY_URL=https://collector.example/ingest
TELEMETRY_TOKEN=your_bearer_token`}
                label="Copy telemetry config"
              />
            </div>
          </figure>

          <div className="telemetry-contract" role="note">
            <strong>Export contract</strong>
            <span>
              <code>DELTA_CAPTURE_PAYLOADS=1</code> preserves per-call model and tool attributes. It
              never exports prompt or result bodies; exact call capture stays local to Cockpit.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
