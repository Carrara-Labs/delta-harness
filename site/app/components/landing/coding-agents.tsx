/** Generated from the approved static landing page for parity. */
export function CodingAgentsSection() {
  return (
    <section
      className="section v3-coding-section"
      id="coding-agents"
      aria-labelledby="coding-agent-title"
    >
      <div className="page coding-agent-grid">
        <header className="coding-agent-copy">
          <p className="section-kicker">Coding agent integrations</p>
          <h2 className="section-heading" id="coding-agent-title">
            Codex and Claude Code native.
          </h2>
          <p>
            At launch, Delta will hand advanced coding tasks to either CLI with the agent workspace
            as its working directory, then return the result to the run.
          </p>
        </header>

        <div className="coding-agent-route">
          <ol className="coding-handoff" aria-label="Coding task handoff">
            <li>Delta</li>
            <li>
              <code>code(task)</code>
            </li>
            <li>CLI</li>
            <li>Resume</li>
          </ol>

          <ul
            className="cli-integrations"
            aria-label="Coding agent integrations planned for launch"
          >
            <li className="cli-integration">
              <div className="coding-integration-head">
                <h3>Codex</h3>
              </div>
              <div className="coding-command">
                <span>delta.env</span>
                <code>
                  DELTA_CODE_CLI=codex exec --sandbox workspace-write{" "}
                  <span className="coding-flag">--skip-git-repo-check</span>
                </code>
              </div>
            </li>
            <li className="cli-integration">
              <div className="coding-integration-head">
                <h3>Claude Code</h3>
              </div>
              <div className="coding-command">
                <span>delta.env</span>
                <code>DELTA_CODE_CLI=claude --print</code>
              </div>
            </li>
          </ul>

          <p className="coding-install-note">
            Install either CLI separately. Neither ships in the standard Delta image.
          </p>
        </div>

        <ul className="coding-contract" aria-label="Coding CLI execution contract">
          <li>
            <span>Working directory</span>
            <strong>Agent workspace</strong>
          </li>
          <li>
            <span>Authentication</span>
            <strong>CLI-owned credentials</strong>
          </li>
          <li>
            <span>Environment variables</span>
            <strong>Narrow allowlist</strong>
          </li>
          <li>
            <span>Execution</span>
            <strong>No harness timeout</strong>
          </li>
        </ul>
      </div>
    </section>
  );
}
