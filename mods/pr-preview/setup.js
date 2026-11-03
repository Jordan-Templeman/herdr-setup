// Personal settings, from setup.json beside the mods (copy setup.example.json to start). Read on
// every call so edits apply on the next refresh; anything left out falls back to DEFAULTS.

import { appHome, readTextFile } from "herdr";

export const DEFAULTS = {
  // The folder inbox sessions start in; null: the space you're looking at.
  repo: null,
  github: {
    tabs: [
      { id: "mine", label: "Mine", query: "is:open is:pr author:@me sort:updated-desc" },
      {
        id: "reviews", label: "Review requests", query: "is:open is:pr review-requested:@me sort:updated-desc",
        action: { label: "Start review", prompt: "Review {url} and give me a list of findings. Read-only: don't edit files, push, or post comments." },
      },
    ],
  },
  // null hides the Jira tab. { cli, site, statuses: [{ id, label, action? }], dry_run? }
  // dry_run: the Jira preview logs its move/comment commands to inspect/jira-dry-run.log instead of running them.
  jira: null,
  // Words the pond leaves out of agent names (your repo's name, say).
  pond: { ignore_words: [] },
  // default: new Claude agents open as a chat, their terminal in a tab put away (the CLI / Chat switch).
  chat: { default: true },
};

export async function setup() {
  try {
    const text = await readTextFile(`${appHome()}/setup.json`);
    return text ? { ...DEFAULTS, ...JSON.parse(text) } : DEFAULTS;
  } catch (e) {
    return { ...DEFAULTS, error: `setup.json: ${e.message ?? e}` };
  }
}

// "{url}" and "{key}" in prompts and labels.
export const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
