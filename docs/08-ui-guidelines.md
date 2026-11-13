# UI design — simple Next.js and Angular

## Design goal

Both applications should look coherent, be fast, accessible and easy to maintain. Avoid elaborate dashboards, animations, state management frameworks and speculative component libraries. Focus on clean spacing, readable typography and straightforward forms.

## Stack and routing

| Area | Standard |
|---|---|
| Customer | Next.js with App Router, React + TypeScript |
| Admin | Angular with TypeScript; production build served as static `/admin/` assets |
| Styling | Tailwind CSS v4 in both applications |
| Typography | **Inter** (Google Fonts), preferably bundled/self-hosted at build time |
| Icons | Lucide (consistent icon stroke and size) |
| Component strategy | Native HTML + small local app components; no Angular Material, PrimeNG, shadcn or other heavy kit unless explicitly justified |
| Theme | Light theme first; dark mode not MVP scope |
| API access | Same-origin `/api/`; session/CSRF policy owned by Node; SSE `/api/events/` |

Use a small shared token **document**, not a cross-framework component library. A font and consistent visual tokens do not justify a UI monorepo package.

## Visual tokens (initial proposal)

- Primary text: dark slate/neutral; secondary: medium neutral; background: white; subtle surface: off-white.
- One restrained primary blue accent for buttons/links and active navigation.
- Base spacing increments: 4/8/12/16/24/32 px.
- Content width: 1080-1200 px for admin; customer chat optimized for a readable message column.
- Border radius: small/medium (6-12 px), unobtrusive borders; avoid large shadows.
- Type: Inter, body 14-16 px; headings 18-28 px where needed; consistent label/caption hierarchy.
- Focus: visible, keyboard accessible, color-contrast compliant.
- Motion: only minimal loading indicators and state changes; respect reduced motion.

Colors/spacing are design tokens; final CSS variable names should be shared by convention, not copied across bespoke UI frameworks.

## Font delivery

Prefer Inter from a supported Google Font package/build flow and serve files from application static assets. For Next.js, `next/font/google` is an option that self-hosts at build time. For Angular, use locally included assets plus `@font-face`. Do not assume runtime CSS imports from fonts.googleapis.com are acceptable for customer privacy/CSP.

Tailwind v4 should be wired to the actual installed framework versions and built in CI. Avoid copying old v3 `tailwind.config.js` assumptions without checking v4 setup.

## Customer experience — minimal screens

1. **Chat:** Agent name/persona, optional ticket label, concise conversation history, text composer, send button, errors/retry, loading states.
2. **Secure verification:** Email and OTP forms outside AI message stream. Clearly separate from chat inputs.
3. **Ticket view:** Subject, status, timestamps, messages, relevant operations/documents, explicit closure action.
4. **Attachment:** Simple picker, progress, validation and OCR status when enabled.

Mobile-first; large tap targets; accessible scroll position and message announcements where appropriate. Don't manufacture typing animations from fabricated model progress.

## Admin experience — minimal screens

- Agent list + edit form (display name, Foundry project/name/version, status, knowledge binding).
- Intents and requirements as straightforward tables/forms, with publish validation.
- Offerings/prices as tables/forms, clearly distinguish draft vs active.
- Tool grants and workflow bindings with explicit enable/disable and validation.
- Ticket table/details and operation history with verified status indicators.
- Basic health/trace links; do not attempt a complex analytics platform for MVP.

Simple left navigation (desktop), compact header (mobile), native tables and details panels. Use confirmation dialogs for consequential admin changes; show validation errors near fields.

## UI rules

- No direct calls from browser to Foundry, Redis, PostgreSQL, private Python gateway or n8n.
- No secrets/tokens in Next.js public variables or Angular bundles. Server manages authenticated sessions.
- Use one typed API client per app; handle errors and validation centrally.
- No optimistic "operation completed" UI until Node provides verified completion event.
- Use `aria-label`, `label`, keyboard navigation, semantic headings, status live regions and accessible dialogs.
- Never display raw OTP, private structured PII or internal model/tool traces in public-facing chat.
- Keep the same visual language between portals but allow different app responsibilities.

## UI acceptance

Both UIs build in CI, pass a basic accessibility audit, render under Nginx at `/` and `/admin/`, and work at desktop/mobile widths. Check Angular deep-link refresh at `/admin/... ` (strip trailing space in actual paths), Next API/SSE same-origin and no inadvertent direct port access.
