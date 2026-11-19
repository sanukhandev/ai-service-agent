# Chat Window UI Overhaul (Option A: Executive Free Zone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the customer chat interface into a premium, authoritative, and responsive UAE Free Zone AI Assistant ("Sara @ ANCFZ") with a cohesive slate/gold palette, rich domain content, fluid spring animations, and a modern frosted-glass transaction modal.

**Architecture:** Next.js 16 with React 19 and Tailwind CSS v4. Frosted glassmorphism (`backdrop-blur-xl`, semi-transparent backgrounds, subtle borders, and gentle ambient lighting). State management via existing React hooks, SSE streams (`useTicketEvents`), and Node API endpoints.

**Tech Stack:** Next.js 16 (Turbopack), React 19, Tailwind CSS v4, Inter font (`@fontsource/inter`), SVG Icons.

**Spec:** [chat-ui-overhaul-design.md](file:///C:/Users/SanuKarimullaKhan/.gemini/antigravity-cli/brain/2e8f463c-91ef-489e-9b8b-590273b42375/chat-ui-overhaul-design.md)

## Global Constraints
- Preserve all existing API routes, SSE events, and security contracts from `AGENTS.md`.
- No new external component libraries or runtime dashboard packages.
- Self-hosted Inter font only.
- Strict isolation of sensitive OTP codes and identity files from chat messages and LLM transcripts.
- Build must pass cleanly: `npm --prefix apps/web run build` with zero TypeScript errors.

## Review Focus
1. **Background & Color Harmony**: No muddy grey blotches or arbitrary harsh colors; canvas is soft slate (`#F8FAFC`) with subtle ambient warmth.
2. **Authoritative Content**: Empty state bento grid presents 4 high-value ANCFZ scenarios (licenses, visas, company setup, ticket tracking).
3. **Animation Performance**: CSS keyframe animations for message entrance, thinking wave, and modal dialog run smoothly without layout shift.
4. **Transaction Modal Glassmorphism**: In-thread transaction controls and modal in `chat-journey-controls.tsx` adopt the frosted design system instead of flat white boxes.
5. **Interactive Controls & Accessibility**: Copy buttons, consent buttons, OTP inputs, and composer textarea maintain high contrast, visible focus rings, and tactile feedback.

---

### Task 1: Design Tokens, Ambient Lighting & Animation Keyframes in `globals.css`

**Files:**
- Modify: `apps/web/app/globals.css:1-74`
- Modify: `apps/web/app/layout.tsx:1-20`

**Interfaces:**
- Produces: CSS utility classes `.animate-message-slide`, `.animate-modal-scale`, `.animate-pulse-glow`, refined scrollbar, and clean ambient background.

- [ ] **Step 1: Update `apps/web/app/globals.css`**
  - Replace blotchy radial gradients with refined luminous slate background:
    ```css
    background-color: #f8fafc;
    background-image: 
      radial-gradient(at 15% 15%, rgba(245, 158, 11, 0.04) 0px, transparent 50%),
      radial-gradient(at 85% 10%, rgba(148, 163, 184, 0.08) 0px, transparent 55%),
      radial-gradient(at 50% 90%, rgba(226, 232, 240, 0.4) 0px, transparent 60%);
    ```
  - Define custom animation keyframes for message sliding entrance, modal scale-fade, and wave pulse.
  - Polish the scrollbar thumb with slate-zinc coloring and smooth hover transition.

- [ ] **Step 2: Update `apps/web/app/layout.tsx`**
  - Ensure body applies `bg-slate-50 text-slate-900 antialiased selection:bg-amber-100 selection:text-amber-950`.

- [ ] **Step 3: Verify build**
  - Run: `npm --prefix apps/web run build`
  - Expected: Build succeeds without CSS or Tailwind errors.

- [ ] **Step 4: Commit**
  ```bash
  git add apps/web/app/globals.css apps/web/app/layout.tsx
  git commit -m "style(web): refine ambient lighting and add animation keyframes in globals.css"
  ```

---

### Task 2: Header, Bento Empty State & Thinking Indicator in `customer-chat.tsx`

**Files:**
- Modify: `apps/web/components/customer-chat.tsx:110-135, 451-740`

**Interfaces:**
- Consumes: Animation classes from `globals.css`, icons from `icons.tsx`.
- Produces: Enhanced `CustomerChat` with executive header, 4 authoritative ANCFZ starter prompts, and fluid thinking indicator.

- [ ] **Step 1: Replace starter prompts with high-value ANCFZ scenarios**
  - Update `STARTER_PROMPTS` array with:
    1. Trade Licensing & Packages (Commercial/service fees, zero-tax benefits, visa quotas)
    2. Investor & Employment Visas (Fast-track residency, partner visas, Emirates ID timeline)
    3. Company Setup & Inclusions (FZE/FZC registration, shareholder resolutions, bank accounts)
    4. Track Application & Quotation (Live ticket status, verified quotes, compliance steps)

- [ ] **Step 2: Refactor Glassmorphic Header**
  - Executive styling with deep slate/gold accent badge: `ANCFZ Free Zone · Official Concierge`.
  - Copyable ticket pill with spring checkmark and hover elevation.
  - Live connection status pill with glowing emerald / pulsing amber dot.
  - Refined "New Chat" button with smooth active press feedback.

- [ ] **Step 3: Redesign Empty State Hero & Bento Grid**
  - Hero with luxury gold-accented icon badge, bold typography, and clear regulatory subtitle.
  - 2x2 Bento grid cards with frosted glass styling (`bg-white/70 backdrop-blur-md border-white/80 hover:border-amber-200/80 hover:bg-white/90 hover:shadow-lg hover:-translate-y-0.5`).
  - Security trust banner: `256-bit Encrypted Session · Governed by ANCFZ Regulatory Intelligence`.

- [ ] **Step 4: Refactor Thinking & Processing Card**
  - Animated thinking card featuring rhythmic 3-dot wave and informative copy:
    `Sara is consulting official ANCFZ regulations and drafting guidance…`
  - Subtle glowing shimmer border.

- [ ] **Step 5: Verify build**
  - Run: `npm --prefix apps/web run build`
  - Expected: PASS with zero errors.

- [ ] **Step 6: Commit**
  ```bash
  git add apps/web/components/customer-chat.tsx
  git commit -m "feat(web): overhaul header, bento starter cards, and thinking states in customer-chat"
  ```

---

### Task 3: Rich Message Formatting, Bubbles & Action Buttons in `chat-message.tsx`

**Files:**
- Modify: `apps/web/components/chat-message.tsx:218-348, 435-575`

**Interfaces:**
- Consumes: `ChatMessage`, `SourceReference`, `conversationalText`.
- Produces: Polished `MessageBubble` and `RichTextContent` with executive slate user bubbles, luminous frosted assistant cards, and tactile consent buttons.

- [ ] **Step 1: Refactor Customer & Assistant Bubble Surfaces**
  - Customer bubble: `bg-slate-900 text-white rounded-2xl rounded-tr-xs px-4.5 py-3 shadow-md ring-1 ring-white/10`.
  - Assistant card: `bg-white/85 text-slate-850 rounded-2xl rounded-tl-xs border border-white/80 shadow-[0_2px_16px_rgba(0,0,0,0.03)] ring-1 ring-slate-900/5 hover:bg-white/95 backdrop-blur-md p-4.5`.
  - Add entrance animation: `animate-message-slide`.

- [ ] **Step 2: Polish Rich Text Typography**
  - Numbered list circles with crisp slate accents and aligned text.
  - Bullet items with custom slate markers and generous line height.
  - Blockquotes with subtle warm gold border accent (`border-l-3 border-amber-500/80 bg-amber-50/40`).
  - Inline code pills with `bg-slate-100 text-slate-800 border-slate-200/80 font-mono text-[0.82em]`.

- [ ] **Step 3: Modernize Action Buttons**
  - "I Consent" button: High-contrast executive button with check icon, subtle gradient, and tactile click state.
  - "Review proposal again" button: Slate outline button with clear typography.
  - Copy response button: Smooth transition with tooltip feedback.

- [ ] **Step 4: Verify build**
  - Run: `npm --prefix apps/web run build`
  - Expected: PASS with zero errors.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/components/chat-message.tsx
  git commit -m "feat(web): polish rich message typography, bubbles, and consent actions"
  ```

---

### Task 4: In-Thread Transaction Card & Modal Redesign in `chat-journey-controls.tsx`

**Files:**
- Modify: `apps/web/components/chat-journey-controls.tsx:428-732`

**Interfaces:**
- Consumes: Journey state (`quote`, `purchase`, `otp`, `payment`), API handlers (`requestJson`, `base64File`).
- Produces: Cohesive frosted glass transaction trigger card and executive modal dialog with modern inputs and step indicators.

- [ ] **Step 1: Redesign Transaction Trigger Card**
  - Replace flat white box with frosted glass card:
    `border border-white/80 bg-white/75 backdrop-blur-xl hover:bg-white/90 hover:border-amber-200/60 shadow-sm ring-1 ring-slate-900/5 p-4 rounded-2xl`.
  - Add gold/slate transaction icon, clear step summary, and sleek "View Transaction" pill.

- [ ] **Step 2: Redesign Secure Transaction Modal**
  - Backdrop: `fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-fade-in`.
  - Dialog container: `bg-white/95 backdrop-blur-2xl border border-white/80 shadow-2xl rounded-2xl p-6 sm:p-7 max-w-2xl ring-1 ring-slate-900/10 animate-modal-scale`.
  - Header with executive badge and sleek close button.

- [ ] **Step 3: Restyle Interactive Journey Steps**
  - Quote confirmation: Gold/slate card with verified price badge and download link.
  - OTP Input: Styled 6-digit numeric input with letter-spacing, focus ring, and clear label.
  - Document dropzones: Clean upload surfaces with status badges ("Uploaded", "Required"), file format requirements, and progress indicator.
  - Test payment & Sandbox checkout: Polished action buttons, order state pill, and clear guidance disclaimers.

- [ ] **Step 4: Verify build**
  - Run: `npm --prefix apps/web run build`
  - Expected: PASS with zero errors.

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/components/chat-journey-controls.tsx
  git commit -m "feat(web): modernize transaction trigger card and modal in chat-journey-controls"
  ```

---

### Task 5: Composer Floating Island in `chat-composer.tsx`

**Files:**
- Modify: `apps/web/components/chat-composer.tsx:93-165`

**Interfaces:**
- Consumes: Composer props (`onSend`, `disabled`, `sending`, `prefilledPrompt`, etc.).
- Produces: Sleek floating glassmorphic input island with tactile send button and keyboard shortcut indicators.

- [ ] **Step 1: Polish Composer Container & Input**
  - Refined island border: `border border-white/80 bg-white/80 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.06)] ring-1 ring-slate-900/5 focus-within:ring-4 focus-within:ring-slate-900/10 focus-within:border-slate-800`.
  - Placeholder text: `Ask Sara about company setup, trade licenses, visa quotas, or your quotation…`.

- [ ] **Step 2: Polish Send Button & Keyboard Shortcuts**
  - Send button: High-contrast slate-900 button with smooth hover elevation, active scale (`active:scale-95`), and crisp loading spinner.
  - Keyboard hint: Clear, modern badge styling (`Enter ↵ to send · Shift + Enter for new line`).

- [ ] **Step 3: Verify build**
  - Run: `npm --prefix apps/web run build`
  - Expected: PASS with zero errors.

- [ ] **Step 4: Commit**
  ```bash
  git add apps/web/components/chat-composer.tsx
  git commit -m "feat(web): polish floating composer island, typography, and shortcut badges"
  ```

---

### Task 6: End-to-End Build, Layout Verification & Polish

**Files:**
- Audit: All modified files in `apps/web/`

- [ ] **Step 1: Execute Full Build**
  - Run: `npm --prefix apps/web run build`
  - Expected: Successful compilation with static page optimization.

- [ ] **Step 2: Responsive & Contrast Verification**
  - Check text contrast against WCAG AA standards.
  - Verify layout integrity across mobile, tablet, and desktop breakpoints.

- [ ] **Step 3: Final Commit & Clean up**
  ```bash
  git add apps/web/
  git commit -m "chore(web): finalize chat window UI overhaul with Option A Executive Free Zone design"
  ```
