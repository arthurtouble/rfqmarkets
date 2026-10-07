# Internal manual

Every Markdown file under [`docs/`](../../docs/README.md) as one searchable site for the team. The folder
is the section, the first heading is the title, and `docs/README.md` is the start page. Nothing needs
registering: add or move a file and it appears on the next build.

- Each page has its own URL (`/architecture/overview`, with `#section` anchors), so links can be shared
  and the back button works.
- Links between docs stay in the manual. Links to other repository files (scripts, deploy config,
  folders without a README) open on GitHub. Mermaid blocks show their source with a link to GitHub's
  rendered view.
- Search matches every word across titles and text, title matches first.

```sh
npm run dev:internal-docs   # http://localhost:4176
```

It is deployed to `internal-docs.rfq-markets.workers.dev` behind Cloudflare Access because it contains
architecture and operating detail. Docs must never contain secrets.

`npm run test:ops-apps` checks the page model and Markdown renderer against the real `docs/` tree,
including that no doc links to a missing doc.
