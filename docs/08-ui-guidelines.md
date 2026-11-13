# Simple customer UI — Next.js only (POC)

The **Angular Admin Portal is deferred beyond this POC**. Do not recreate \`apps/admin/\`, an Angular build stage or \`/admin/\` routing now.

## Stack

- Next.js, React, TypeScript, Tailwind CSS v4.
- Google Font **Inter**, delivered through bundled/self-hosted \`@fontsource/inter\` assets.
- Use semantic HTML and lightweight local components. Avoid heavy UI component kits, dashboards, animation frameworks or speculative shared UI packages.
- Browser accesses the same-origin Node API through Nginx only (\`/api/\` and \`/api/events/\`). Do not call Foundry, n8n, Redis or PostgreSQL from the browser.

## Minimal screens

1. **Customer chat**: agent name, short introduction, message history, textarea, send button, clear loading/error and retry states.
2. **Ticket history**: subject, status, conversation, sourced info, customer-facing operation state.
3. **Action approval**: explicit, readable summary of proposed lead/quote and single confirm/cancel action. Node validates the approval separately.
4. **Email OTP**: small secure form outside the model conversation (P5).
5. **Document attachment**: size/type validation, upload progress and OCR status (P5).

Do not build an admin screen during P0–P7; seed agent/catalog configuration through controlled local scripts until admin is resumed.

## Styling

Light, minimal design with dark neutral text, white/off-white surfaces, one restrained blue accent, consistent small/medium border radius and readable 14–16px body typography. Spacing 4/8/12/16/24/32px. Inter font weights 400–600 are sufficient.

Use native buttons, form controls, simple tables and dialogs where suitable, with visible keyboard focus, meaningful labels, status announcements and accessible errors. Keep chat responsive at mobile width, with a readable message column on desktop.

## Employee-style chat presentation

- Render useful conversational answers, not repetitive FAQ-style lists.
- Show one clear next question or next step when relevant; do not force a multi-field wizard.
- Preserve cited factual sources cleanly; never render raw tool JSON or internal prompts.
- Separate indicative package explanation from formal price/quote confirmation.
- Never optimistically display "lead created" or "quote sent" until Node reports verified provider completion via SSE.

## Acceptance (POC smoke only)

After the runtime is built: page loads under \`/\`, same-origin \`/api/\` routing works, basic mobile and desktop layouts are readable, and no internal ports or credentials are browser-visible. Full browser/a11y E2E suites are deferred to H1.
