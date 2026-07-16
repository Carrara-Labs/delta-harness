import { useState } from "react";

import { CopyButton } from "~/components/copy-button";

type InstallTab = {
  id: string;
  label: string;
  /** The exact text the copy button puts on the clipboard. */
  command: string;
  /** Shell prompt marker; omitted for the prose "coding agents" brief. */
  prompt?: string;
  note: string;
};

const TABS: InstallTab[] = [
  {
    id: "curl",
    label: "curl",
    command: "curl -fsSL https://deltaharness.dev/install.sh | sh",
    prompt: "$",
    note: "Prebuilt binary for macOS and Linux — no runtime required.",
  },
  {
    id: "bun",
    label: "bun",
    command: "bunx @carrara-labs/delta-harness init ./my-agent",
    prompt: "$",
    note: "Run it through Bun 1.3+ with no install step.",
  },
  {
    id: "docker",
    label: "docker",
    command: "docker run -p 8080:8080 --env-file .env ghcr.io/carrara-labs/delta-harness",
    prompt: "$",
    note: "Run the daemon as a container from GitHub Container Registry.",
  },
  {
    id: "agents",
    label: "Coding agents",
    command: "Read https://deltaharness.dev/llms.txt, then install Delta and scaffold an agent.",
    note: "Paste into a fresh session — llms.txt links the install, guide, and integration brief.",
  },
];

export function InstallTabs() {
  const [active, setActive] = useState(TABS[0].id);
  const tab = TABS.find((candidate) => candidate.id === active) ?? TABS[0];

  return (
    <div className="install-tabs">
      <div className="install-card">
        <div className="install-card-head">
          <div className="install-tablist" role="tablist" aria-label="Install Delta">
            {TABS.map((candidate) => {
              const selected = candidate.id === active;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  id={`install-tab-${candidate.id}`}
                  aria-selected={selected}
                  aria-controls="install-panel"
                  tabIndex={selected ? 0 : -1}
                  className={`install-tab${selected ? " is-active" : ""}`}
                  onClick={() => setActive(candidate.id)}
                >
                  {candidate.label}
                </button>
              );
            })}
          </div>
          <CopyButton
            text={tab.command}
            label={`Copy ${tab.label} command`}
            className="copy-button install-copy"
          />
        </div>

        <div
          className="install-card-body"
          id="install-panel"
          role="tabpanel"
          aria-labelledby={`install-tab-${tab.id}`}
        >
          <code className="install-command">
            {tab.prompt ? (
              <span className="prompt" aria-hidden="true">
                {tab.prompt}
              </span>
            ) : null}
            {tab.command}
          </code>
        </div>
      </div>

      <p className="install-note">{tab.note}</p>
    </div>
  );
}
