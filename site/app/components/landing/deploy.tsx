import { CopyButton } from "~/components/copy-button";

/** Generated from the approved static landing page for parity. */
export function DeploySection() {
  return (
    <section className="section" id="deploy">
      <div className="page">
        <header className="deploy-head">
          <div>
            <p className="section-kicker">Deploy</p>
            <h2 className="section-heading" id="deploy-title">
              One binary. One volume. Your cloud.
            </h2>
          </div>
          <div className="deploy-summary">
            <p>
              Pair one Delta binary with one persistent volume. Your controller handles intake, wake
              and suspend. Delta checkpoints the work.
            </p>
            <a className="inline-link" href="/docs/#guide-deploy-delta">
              Read the deployment guide <span aria-hidden="true">&rarr;</span>
            </a>
          </div>
        </header>

        <div className="code-block">
          <div className="code-block-header">
            <span>Run the daemon (container)</span>
            <CopyButton
              text="docker run -p 8080:8080 --env-file .env ghcr.io/carrara-labs/delta-harness"
              label="Copy docker command"
            />
          </div>
          <pre>
            <code>docker run -p 8080:8080 --env-file .env ghcr.io/carrara-labs/delta-harness</code>
          </pre>
        </div>

        <figure className="deploy-topology" aria-labelledby="deploy-title topology-caption">
          <figcaption className="topology-head" id="topology-caption">
            <span>Production topology</span>
            <span className="topology-meta">
              <i aria-hidden="true" />
              one agent &middot; externally enforced writer &middot; persistent state
            </span>
          </figcaption>

          <div className="topology-map">
            <div className="topology-stack topology-external">
              <div className="topology-node topology-control">
                <span className="node-tag">External</span>
                <strong>Lifecycle controller</strong>
                <span>Gate intake &middot; check queue &middot; wake &middot; suspend</span>
              </div>
              <div className="topology-node topology-inspect">
                <span className="node-tag">Private</span>
                <strong>Trusted gateway and operator proxy</strong>
                <span>
                  Authenticate &middot; apply limits &middot; inject control and inspect tokens
                </span>
              </div>
            </div>

            <div className="topology-connector" aria-hidden="true">
              <span>private access</span>
            </div>

            <div className="topology-machine">
              <div className="topology-machine-head">
                <strong>Delta machine</strong>
                <span>suspendable compute</span>
              </div>
              <div className="delta-service">
                <div className="delta-service-head">
                  <strong>delta</strong>
                  <code>:8080</code>
                </div>
                <p>Compiled daemon, durable loop and Cockpit</p>
                <ul className="endpoint-list" aria-label="Key endpoints">
                  <li>
                    <code>/v1/responses</code>
                  </li>
                  <li>
                    <code>/v1/tasks</code>
                  </li>
                  <li>
                    <code>/healthz</code>
                  </li>
                  <li>
                    <code>/dev</code>
                  </li>
                  <li>
                    <code>/v1/dev/*</code>
                  </li>
                </ul>
              </div>
              <div className="machine-volume">
                <span className="volume-icon" aria-hidden="true">
                  db
                </span>
                <strong>/data/delta.db</strong>
                <span>SQLite state and durable event outbox</span>
              </div>
              <div className="machine-volume">
                <span className="volume-icon" aria-hidden="true">
                  /
                </span>
                <strong>/data/workspace/</strong>
                <span>DELTA.md &middot; inbox/ &middot; working files</span>
              </div>
            </div>

            <div className="topology-connector" aria-hidden="true">
              <span>outbound</span>
            </div>

            <ul className="topology-stack topology-services" aria-label="External services">
              <li>
                <span className="node-tag">Model</span>
                <strong>Model providers</strong>
                <span>OpenRouter, Anthropic or OpenAI</span>
              </li>
              <li>
                <span className="node-tag">Tools</span>
                <strong>MCP services</strong>
                <span>Product systems and connectors</span>
              </li>
              <li>
                <span className="node-tag">Optional</span>
                <strong>Telemetry collector</strong>
                <span>Custom NDJSON export</span>
              </li>
              <li>
                <span className="node-tag">Backup</span>
                <strong>Litestream + object storage</strong>
                <span>SQLite only &middot; snapshot the workspace separately</span>
              </li>
            </ul>
          </div>

          <div className="lifecycle">
            <div className="lifecycle-head">
              <strong>External lifecycle</strong>
              <span>Delta does not provision or suspend infrastructure itself.</span>
            </div>
            <ol className="lifecycle-strip">
              <li>
                <span className="lifecycle-index">01</span>
                <strong>Gate</strong>
                <span>Hold new work</span>
              </li>
              <li>
                <span className="lifecycle-index">02</span>
                <strong>Wake</strong>
                <span>Start the runtime</span>
              </li>
              <li>
                <span className="lifecycle-index">03</span>
                <strong>Run</strong>
                <span>Checkpoint durable work</span>
              </li>
              <li>
                <span className="lifecycle-index">04</span>
                <strong>Check</strong>
                <span>No queued or running work</span>
              </li>
              <li>
                <span className="lifecycle-index">05</span>
                <strong>Suspend</strong>
                <span>Compute sleeps, /data stays</span>
              </li>
            </ol>
            <p className="lifecycle-caveat">
              Queue zero does not drain reflection or telemetry. Suspending can interrupt background
              work.
            </p>
          </div>
        </figure>

        <dl className="deploy-contract">
          <div>
            <dt>Runtime</dt>
            <dd>Compiled Linux binary</dd>
          </div>
          <div>
            <dt>Persistence</dt>
            <dd>
              Mount all of <code>/data</code>
            </dd>
          </div>
          <div>
            <dt>Health</dt>
            <dd>
              <code>/healthz</code> is liveness
            </dd>
          </div>
          <div>
            <dt>Recovery</dt>
            <dd>Back up DB + workspace; test coordinated restore</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
