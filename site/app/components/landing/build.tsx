import { CopyButton } from "~/components/copy-button";

export function BuildSection() {
  return (
    <section className="section v3-build-section" id="build">
      <div className="page">
        <div className="develop-grid" id="develop">
          <div className="develop-copy">
            <p className="section-kicker">Build</p>
            <h2 className="section-heading">Create and run in two commands. Shape four files.</h2>
            <p className="section-intro">
              Install in one command, then scaffold and launch a versionable agent bundle.
            </p>
          </div>

          <div className="steps">
            <article className="step">
              <h3 className="step-label">Install, then initialize and run</h3>
              <p>
                One command to install. Then <code>delta init</code> scaffolds without overwriting
                files, and <code>delta dev</code> opens the local Cockpit. Prefer a package?{" "}
                <code>bunx @carrara-labs/delta-harness</code> runs it via Bun.
              </p>
              <div className="code-block">
                <div className="code-block-header">
                  <span>Terminal</span>
                  <CopyButton
                    text={`curl -fsSL https://deltaharness.dev/install.sh | sh
delta init ./my-agent
delta dev ./my-agent`}
                    label="Copy setup commands"
                  />
                </div>
                <pre>
                  <code>
                    <span className="comment"># install (macOS / Linux)</span>
                    {`
curl -fsSL https://deltaharness.dev/install.sh | sh

`}
                    <span className="comment"># create and launch an agent</span>
                    {`
delta init ./my-agent
delta dev ./my-agent`}
                  </code>
                </pre>
              </div>
            </article>

            <article className="step">
              <h3 className="step-label">Shape four files. Add context if needed.</h3>
              <p>
                The bundle is deliberately plain. Version it, review it and change it without
                learning a framework.
              </p>
              <div className="file-list">
                <div className="file">
                  <span className="file-name">delta.env</span>
                  <span className="file-purpose">Providers, budgets and MCP</span>
                </div>
                <div className="file">
                  <span className="file-name">vocab.json</span>
                  <span className="file-purpose">Product language and actions</span>
                </div>
                <div className="file">
                  <span className="file-name">DELTA.md</span>
                  <span className="file-purpose">Role, memory and learned rules</span>
                </div>
                <div className="file">
                  <span className="file-name">POLICY.md</span>
                  <span className="file-purpose">Highest-priority prompt guidance</span>
                </div>
                <div className="file">
                  <span className="file-name">
                    PROMPT_CONTEXT.md <span className="optional">optional</span>
                  </span>
                  <span className="file-purpose">Bounded stable and per-turn context</span>
                </div>
              </div>
            </article>

            <article className="step">
              <h3 className="step-label">Inspect the real loop locally</h3>
              <p>
                <code>delta dev</code> runs the ordinary daemon on loopback, adds exact
                successful-call capture and local editing, and opens Cockpit at <code>/dev</code>.
              </p>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
