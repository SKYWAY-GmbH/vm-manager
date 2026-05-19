<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Project Notes

- This app is dark-only and intentionally has no built-in authentication; Pangolin SSO protects production access.
- Keep Kubernetes access server-only. Do not import `@kubernetes/client-node` into client components.
- Use Next.js route handlers for browser-triggered VM actions. Do not shell out to `kubectl` or `virtctl`.
- Use `pnpm` for dependency changes and `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before pushing.
