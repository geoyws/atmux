import { defineConfig } from "vitepress";

export default defineConfig({
  title: "atmux",
  description:
    "agent teams multiplexer — one tmux session per project team, one window per agent",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  // README + ADRs cross-link to repo files (LICENSE, install.sh, etc.) that
  // live outside docs/. Don't fail the build on those — they resolve in the
  // GitHub web UI for the source files, not the published docs site.
  ignoreDeadLinks: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#7287fd" }],
  ],

  themeConfig: {
    siteTitle: "atmux",
    nav: [
      { text: "Guide", link: "/GETTING_STARTED" },
      { text: "Architecture", link: "/ARCHITECTURE" },
      { text: "PRD", link: "/PRD" },
      {
        text: "ADRs",
        items: [
          { text: "atmux-bun port (this worktree)", link: "/adr-bun/" },
          { text: "Parent atmux ADRs", link: "/adr/" },
        ],
      },
      { text: "Changelog", link: "/CHANGELOG" },
    ],

    sidebar: {
      "/": [
        {
          text: "Getting started",
          items: [
            { text: "README", link: "/" },
            { text: "Quickstart", link: "/GETTING_STARTED" },
            { text: "Architecture", link: "/ARCHITECTURE" },
            { text: "CI", link: "/CI" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Product Requirements (PRD)", link: "/PRD" },
            { text: "Hosting runbook", link: "/RUNBOOK-hosting" },
            { text: "Changelog", link: "/CHANGELOG" },
          ],
        },
      ],
      "/adr-bun/": [
        {
          text: "atmux-bun port ADRs",
          link: "/adr-bun/",
          items: [],
        },
      ],
      "/adr/": [
        {
          text: "Parent atmux ADRs",
          link: "/adr/",
          items: [],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/geoyws/atmux" },
    ],

    search: { provider: "local" },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2025-present George Yong",
    },

    editLink: {
      pattern:
        "https://github.com/geoyws/atmux/edit/main/.claude/worktrees/atmux-bun/docs/:path",
      text: "Edit this page on GitHub",
    },
  },

  markdown: {
    lineNumbers: false,
    theme: { light: "catppuccin-latte", dark: "catppuccin-frappe" },
    // ADRs use lots of <placeholder>-style tokens (e.g. `<team>`, `<ts>`,
    // `<member>`) outside fenced code. Disabling raw-HTML parsing makes
    // markdown-it auto-escape these so Vue's compiler doesn't treat
    // them as unclosed components.
    html: false,
  },

  vite: {
    server: { host: "127.0.0.1", port: 5173 },
  },
});
