import { ChangeDetectionStrategy, Component } from "@angular/core";

@Component({
  selector: "app-root",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto min-h-screen max-w-4xl px-5 py-8 md:px-10 md:py-14">
      <header class="flex items-center justify-between border-b border-slate-200 pb-5">
        <div>
          <p class="text-xs font-semibold uppercase tracking-widest text-blue-700">
            AI Service Agent
          </p>
          <h1 class="mt-1 text-2xl font-semibold">Admin Portal</h1>
        </div>
        <a href="/" class="text-sm font-medium text-blue-700 hover:underline">
          Customer portal
        </a>
      </header>
      <section class="mt-12 rounded-xl border border-slate-200 bg-white p-8">
        <h2 class="text-lg font-semibold">Agent management</h2>
        <p class="mt-3 max-w-xl text-sm leading-6 text-slate-600">
          The admin interface will provide simple agent configuration,
          catalog forms and ticket management in P6.
        </p>
        <p class="mt-5 text-xs text-slate-500">
          P0: static Angular application shell. No admin operations are enabled.
        </p>
      </section>
    </main>
  `,
})
export class AppComponent {}
